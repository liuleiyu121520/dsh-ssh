/**
 * 凭据保管：信封加密（envelope encryption）。
 *
 * 为什么不用 `ctx.credentials` 直接存密码：它是**明文**落盘
 * （`credentials-local/src/index.ts:450` 把值原样写进 YAML，只有 0600 文件权限，
 * 见设计 §0.1）。所以这里做两层：
 *
 * - **DEK**（32B 随机）→ `ctx.credentials` 的 ref `DSH_SSH_VAULT_KEY`（base64）；
 * - **密文** → `dsh_ssh` 域 `secrets` 表（`{v,iv,tag,ct}` 全 base64）。
 *
 * 算法 `aes-256-gcm`，12B IV，16B tag，**AAD = hostId**：把密文从 A 主机搬到
 * B 主机就解不开（GCM 认证失败 → `decrypt-failed`），这是"改 id 绕过凭据绑定"
 * 的第二道锁（第一道是 id 由服务端生成）。
 *
 * 威胁模型（README 里同样写，不许夸大）：
 * - 防：日志泄漏、HTTP 响应泄漏、storageDomain 公开读接口泄漏、单文件误同步/
 *   误提交、grep 审计；
 * - 不防：已获得同用户本机权限者（能同时读 DEK 与密文）。要防需 passphrase
 *   KEK 或 OS 钥匙串 —— `createVault(ctx, {provider})` 的 provider 参数就是
 *   留给那一步的缝。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** 对称算法。 */
const ALGORITHM = 'aes-256-gcm';
/** GCM 推荐 IV 长度：12 字节。 */
const IV_BYTES = 12;
/** GCM tag 长度：16 字节。 */
const TAG_BYTES = 16;
/** DEK 长度：AES-256 → 32 字节。 */
const KEY_BYTES = 32;

/** DEK 在 `ctx.credentials` 里的 ref（设计 §7.1 固定值）。 */
export const VAULT_KEY_REF = 'DSH_SSH_VAULT_KEY';

/** 支持的 provider。目前只有 credentials；其余留作未来（keychain / passphrase）。 */
export const VAULT_PROVIDERS = Object.freeze(['credentials']);

/** 保管层错误。`code` 直接进 HTTP 响应体的 `code` 字段。 */
export class VaultError extends Error {
  /**
   * @param {string} code 错误码（`vault-unavailable` / `decrypt-failed`）。
   * @param {string} message 人类可读原因（**不含任何秘密**）。
   */
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

/**
 * 判断一个值是不是形状合法的密文盒。
 * @param {unknown} box 候选值。
 * @returns {boolean} 是否合法。
 */
export function isSealed(box) {
  if (box === null || typeof box !== 'object') return false;
  const candidate = /** @type {Record<string, unknown>} */ (box);
  return (
    candidate.v === 1
    && typeof candidate.iv === 'string'
    && typeof candidate.tag === 'string'
    && typeof candidate.ct === 'string'
  );
}

/**
 * 建一个 vault 实例。
 *
 * 返回值是**惰性**的：DEK 在第一次 seal/open 时才读/写 credentials，
 * 这样插件激活不会被一个慢凭据后端拖住。
 * @param {object} ctx cordis 上下文（需要 `credentials`）。
 * @param {object} [options] 选项。
 * @param {string} [options.provider] 托管方，默认 `credentials`。
 * @param {object} [options.credentials] 显式传入的 credentials 服务（测试用）。
 * @returns {{ensureDek: () => Promise<Buffer>, seal: (plain: string, aad: string) => Promise<object>, open: (box: object, aad: string) => Promise<string>, provider: string, forget: () => void, hasCachedDek: () => boolean}} vault 实例。
 */
export function createVault(ctx, options = {}) {
  const provider = options.provider ?? 'credentials';
  if (!VAULT_PROVIDERS.includes(provider)) {
    throw new VaultError('vault-unavailable', `unsupported vault provider ${JSON.stringify(provider)}`);
  }
  const credentials =
    options.credentials
    ?? ctx?.credentials
    ?? (typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined);
  if (credentials === undefined || credentials === null) {
    throw new VaultError('vault-unavailable', 'ctx.credentials is not available');
  }
  if (typeof credentials.resolve !== 'function' || typeof credentials.set !== 'function') {
    throw new VaultError('vault-unavailable', 'ctx.credentials does not implement resolve/set');
  }

  /** @type {Buffer|null} 进程内 DEK 缓存（绝不落日志）。 */
  let dek = null;
  /** @type {Promise<Buffer>|null} 并发去重：两个请求同时首次 seal 只生成一把 DEK。 */
  let pending = null;

  /**
   * 取（必要时生成）DEK。
   *
   * 首次调用生成 32B 随机密钥并写进 `ctx.credentials`；之后走缓存。若
   * credentials 里已有一把**长度不对**的密钥，抛 `vault-unavailable` 而不是
   * 覆盖——覆盖会让既有密文永久不可解，静默毁数据比报错更糟。
   *
   * `resolve()` 的契约是 `Promise<{value, source} | undefined>`
   * （`credentials/src/index.ts:118-123,184`），**不是**裸字符串。早先按裸
   * 字符串判断，`typeof stored === 'string'` 恒为 false → 每次启动都当"没有
   * DEK"→ 生成新的并 `set()` 覆盖旧的 → 上一轮所有密文永久报废。替身当初
   * 返回裸字符串，把这个 bug 完整地伪装成了正确实现。
   * @returns {Promise<Buffer>} 32B DEK。
   */
  async function ensureDek() {
    if (dek !== null) return dek;
    if (pending !== null) return pending;
    pending = (async () => {
      const resolved = await credentials.resolve(VAULT_KEY_REF);
      // 兼容裸字符串只是为了不让手工/旧替身把这里再打回原形；真契约取 .value。
      const stored = typeof resolved === 'string' ? resolved : resolved?.value;
      if (typeof stored === 'string' && stored !== '') {
        const decoded = Buffer.from(stored, 'base64');
        if (decoded.length !== KEY_BYTES) {
          throw new VaultError(
            'vault-unavailable',
            `${VAULT_KEY_REF} is corrupt (${decoded.length} bytes, expected ${KEY_BYTES}); unset it to reset`,
          );
        }
        return decoded;
      }
      const fresh = randomBytes(KEY_BYTES);
      await credentials.set(VAULT_KEY_REF, fresh.toString('base64'));
      return fresh;
    })();
    try {
      dek = await pending;
      return dek;
    } finally {
      pending = null;
    }
  }

  return {
    provider,
    ensureDek,
    /**
     * 加密一段明文。
     * @param {string} plain 明文。
     * @param {string} aad 附加认证数据（固定用 hostId）。
     * @returns {Promise<{v: 1, iv: string, tag: string, ct: string}>} 密文盒（全 base64）。
     */
    async seal(plain, aad) {
      const key = await ensureDek();
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(String(aad ?? ''), 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(String(plain), 'utf8')), cipher.final()]);
      return {
        v: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ct: ciphertext.toString('base64'),
      };
    },
    /**
     * 解密一个密文盒。
     *
     * 任何失败（IV/tag 长度不对、被篡改、AAD 不匹配、密钥换了）都收敛成同一个
     * `decrypt-failed`：区分"是篡改还是错 key"会把预言机递给攻击者，对用户也
     * 没有可操作差异。
     * @param {object} box 密文盒。
     * @param {string} aad 附加认证数据（必须与 seal 时一致）。
     * @returns {Promise<string>} 明文。
     */
    async open(box, aad) {
      if (!isSealed(box)) {
        throw new VaultError('decrypt-failed', 'secret box is malformed');
      }
      const key = await ensureDek();
      try {
        const iv = Buffer.from(box.iv, 'base64');
        const tag = Buffer.from(box.tag, 'base64');
        if (iv.length !== IV_BYTES) throw new Error('bad iv length');
        if (tag.length !== TAG_BYTES) throw new Error('bad tag length');
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.from(String(aad ?? ''), 'utf8'));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]);
        return plaintext.toString('utf8');
      } catch {
        throw new VaultError('decrypt-failed', 'secret could not be decrypted (tampered, or wrong host key)');
      }
    },
    /** 丢掉进程内缓存的 DEK（插件卸载 / 测试清理用）。 */
    forget() {
      dek = null;
      pending = null;
    },
    /** 是否已缓存 DEK（断言"没有重复生成"用）。 */
    hasCachedDek() {
      return dek !== null;
    },
  };
}
