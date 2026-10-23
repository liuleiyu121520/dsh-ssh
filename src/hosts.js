/**
 * 主机仓库：`dsh_ssh` 域的读写门面。
 *
 * 两张表，职责严格分开：
 * - `hosts`：**元数据**（`{id,label,host,port,username,authKind,hasSecret,
 *   createdAt,updatedAt}`），可以随便被 UI 读、被 `/hosts` 序列化；
 * - `secrets`：**密文盒**（`{v,iv,tag,ct}`），只有本模块的 `getAuth()` 会解。
 *
 * 秘密的完整生命周期只出现在 `create/update`（seal）与 `getAuth`（open）两处，
 * 且明文永远不会被写进任何一张表、任何一个返回值里（设计 §2.11 / §7.9）。
 * 上层（路由、工具）拿到的是"解好的 auth 对象"，用完即弃。
 */
import {
  HostInputError,
  defineDomainSpec,
  newHostId,
  normalizeHostInput,
} from './schema.js';

/** 仓库层错误。`code` 直接进 HTTP 响应体。 */
export class HostStoreError extends Error {
  /**
   * @param {string} code 错误码（`unknown-host` / `duplicate-host` / `storage-unavailable` / `decrypt-failed`）。
   * @param {string} message 人类可读原因（**不含任何秘密**）。
   */
  constructor(code, message) {
    super(message);
    this.name = 'HostStoreError';
    this.code = code;
  }
}

/**
 * 从 patch config 推导"首次播种"的主机列表。
 *
 * 两种形态（M0 兼容）：`hosts: [...]` 显式列表，或 `host/port/username/password`
 * 平铺在 config 上。都没有则返回空数组——不播种，主机列表由用户自己加。
 * @param {object} [config] cordis.patch.yml 的 config 段。
 * @returns {object[]} 待播种的主机原始输入。
 */
export function seedHostsFromConfig(config = {}) {
  if (Array.isArray(config.hosts) && config.hosts.length > 0) {
    return config.hosts.map((host) => ({ ...host }));
  }
  if (typeof config.host === 'string' && config.host.trim() !== '') {
    return [
      {
        label: config.label,
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        privateKey: config.privateKey,
        passphrase: config.passphrase,
      },
    ];
  }
  return [];
}

/**
 * 主机仓库。
 */
export class HostStore {
  /**
   * @param {object} options 构造选项。
   * @param {object} options.storageDomain `ctx.storageDomain`。
   * @param {object} options.vault `createVault()` 的返回值。
   * @param {(message: string) => void} [options.logger] 日志函数（只允许传 hostId/错误码）。
   */
  constructor(options = {}) {
    if (options.storageDomain === undefined || options.storageDomain === null) {
      throw new HostStoreError('storage-unavailable', 'ctx.storageDomain is not available');
    }
    if (options.vault === undefined || options.vault === null) {
      throw new HostStoreError('vault-unavailable', 'vault is not available');
    }
    this.storageDomain = options.storageDomain;
    this.vault = options.vault;
    this.log = typeof options.logger === 'function' ? options.logger : () => {};
    /** @type {object|null} 域句柄，init() 之后可用。 */
    this.domain = null;
    /** @type {object|null} hosts 表句柄。 */
    this.hostsTable = null;
    /** @type {object|null} secrets 表句柄。 */
    this.secretsTable = null;
  }

  /**
   * 打开域并拿表句柄。插件激活时调用一次。
   *
   * 直接把 `defineDomainSpec()` 交给 `open()`：真 `DomainFacility` **没有**
   * `defineDomain` 方法（它是 storage-domain 的顶层具名导出），早先那个
   * `typeof storageDomain.defineDomain === 'function'` 分支在真机上永远是死
   * 代码。规格的静态校验改在 `defineDomainSpec()` 构造期做（见 schema.js 的
   * `assertDomainSpec`），所以这里不需要再借服务的手。
   * @returns {Promise<HostStore>} this（便于链式）。
   */
  async init() {
    const spec = defineDomainSpec();
    try {
      this.domain = await this.storageDomain.open(spec);
    } catch (error) {
      throw new HostStoreError(
        'storage-unavailable',
        `storageDomain.open(${spec.name}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.hostsTable = this.domain.table('hosts');
    this.secretsTable = this.domain.table('secrets');
    return this;
  }

  /** 域是否已打开。 */
  get ready() {
    return this.domain !== null && this.hostsTable !== null && this.secretsTable !== null;
  }

  /**
   * 列出全部主机。
   *
   * 排序：按 `createdAt` 升序；同一毫秒创建的多台（脚本批量加主机时很常见）
   * 保持表迭代顺序——`Array.prototype.sort` 自 ES2019 起保证稳定，所以这里
   * 直接返回 0 让插入顺序胜出，而不是拿随机 id 当兜底排序键（那会让列表
   * 顺序在每次读之间跳变）。
   * @returns {Promise<object[]>} 主机记录数组。
   */
  async list() {
    this._assertReady();
    // entries() 在真实现里是迭代器，先摊平成数组再排序（不要假设它带 Array 方法）。
    const records = [...this.hostsTable.entries()].map(([, value]) => value);
    records.sort((left, right) => {
      if (left.createdAt === right.createdAt) return 0;
      return left.createdAt < right.createdAt ? -1 : 1;
    });
    return records;
  }

  /**
   * 主机数量。
   * @returns {Promise<number>} 条数。
   */
  async count() {
    this._assertReady();
    return this.hostsTable.size;
  }

  /**
   * 按 id 取主机记录。
   * @param {string} id 主机 id。
   * @returns {Promise<object>} 主机记录。
   */
  async get(id) {
    this._assertReady();
    const record = this.hostsTable.get(String(id ?? ''));
    if (record === undefined) {
      throw new HostStoreError('unknown-host', `unknown host ${JSON.stringify(id)}`);
    }
    return record;
  }

  /**
   * 主机是否存在（不抛错版本，工具层用）。
   * @param {string} id 主机 id。
   * @returns {boolean} 是否存在。
   */
  has(id) {
    this._assertReady();
    return this.hostsTable.get(String(id ?? '')) !== undefined;
  }

  /**
   * 新建主机。id 由服务端生成，调用方**不能**指定。
   * @param {object} input 请求体（`{label,host,port,username,auth}`）。
   * @returns {Promise<object>} 新建的主机记录。
   */
  async create(input) {
    this._assertReady();
    const normalized = normalizeHostInput(input);
    this._assertNoDuplicate(normalized);
    const id = newHostId();
    const now = new Date().toISOString();
    const auth = normalized.auth ?? { kind: 'none' };
    const hasSecret = auth.kind !== 'none';

    // 先写密文再写元数据：元数据是"这条主机存在"的唯一凭据，先落它再写
    // 密文的话，中间失败会留下一条 hasSecret=true 却无密文的主机。
    if (hasSecret) {
      const box = await this.vault.seal(serializeAuth(auth), id);
      await this.secretsTable.put(id, box);
    }

    /** @type {object} */
    const record = {
      id,
      label: normalized.label ?? defaultLabel(normalized),
      host: normalized.host,
      port: normalized.port ?? 22,
      username: normalized.username ?? '',
      authKind: auth.kind,
      hasSecret,
      createdAt: now,
      updatedAt: now,
    };
    await this.hostsTable.put(id, record);
    this.log(`host created ${id}`);
    return record;
  }

  /**
   * 更新主机。
   *
   * **`auth` 缺席 ≠ `auth.kind='none'`**：前者不动密文（`ct` 字节级不变），
   * 后者删除密文。这是"改标签/端口不会顺手把密码弄丢"的保证（设计 §4）。
   * @param {string} id 主机 id。
   * @param {object} input 请求体（部分字段）。
   * @returns {Promise<object>} 更新后的主机记录。
   */
  async update(id, input) {
    this._assertReady();
    const existing = await this.get(id);
    const patch = normalizeHostInput(input, { partial: true });

    /** @type {object} */
    const next = { ...existing };
    if (patch.host !== undefined) next.host = patch.host;
    if (patch.port !== undefined) next.port = patch.port;
    if (patch.username !== undefined) next.username = patch.username;
    if (patch.label !== undefined) {
      next.label = patch.label === '' ? defaultLabel({ host: next.host, username: next.username }) : patch.label;
    }
    this._assertNoDuplicate(next, id);

    if (patch.auth !== undefined) {
      if (patch.auth.kind === 'none') {
        await this.secretsTable.delete(id);
        next.authKind = 'none';
        next.hasSecret = false;
      } else {
        const box = await this.vault.seal(serializeAuth(patch.auth), id);
        await this.secretsTable.put(id, box);
        next.authKind = patch.auth.kind;
        next.hasSecret = true;
      }
    }

    next.updatedAt = new Date().toISOString();
    await this.hostsTable.put(id, next);
    this.log(`host updated ${id}`);
    return next;
  }

  /**
   * 删除主机：先删密文再删元数据。
   *
   * 顺序刻意：元数据删掉后 id 就不存在了，此时若密文还在，就是一条永远没人
   * 能定位的孤儿密文。反过来（先删密文）最坏结果是一条 hasSecret=true 的
   * 主机暂时解不开，用户能看见、能重填。
   * @param {string} id 主机 id。
   * @returns {Promise<object>} 被删掉的主机记录。
   */
  async remove(id) {
    this._assertReady();
    const existing = await this.get(id);
    await this.secretsTable.delete(id);
    await this.hostsTable.delete(id);
    this.log(`host removed ${id}`);
    return existing;
  }

  /**
   * 解出主机的认证信息——**唯一**会把秘密还原成明文的出口。
   *
   * 调用方（路由 / 工具）必须把它直接交给 `createTransport`，不得缓存、
   * 不得写日志、不得塞进响应体。
   * @param {string} id 主机 id。
   * @returns {Promise<{kind: string, password?: string, privateKey?: string, passphrase?: string}|null>} 认证信息或 null（无凭据）。
   */
  async getAuth(id) {
    this._assertReady();
    // 主机不存在与"主机存在但没有凭据"必须能区分：前者是调用方传错了 id
    // （404 unknown-host），后者是合法的无凭据主机（返回 null）。
    if (!this.has(id)) {
      throw new HostStoreError('unknown-host', `unknown host ${JSON.stringify(id)}`);
    }
    const box = this.secretsTable.get(String(id ?? ''));
    if (box === undefined) return null;
    // vault.open 抛 VaultError('decrypt-failed')，原样上抛：AAD 是 hostId，
    // 所以"把 A 的密文挂到 B 上"在这里必然失败。
    const plaintext = await this.vault.open(box, String(id));
    try {
      const parsed = JSON.parse(plaintext);
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.kind !== 'string') {
        throw new Error('bad payload shape');
      }
      return parsed;
    } catch {
      throw new HostStoreError('decrypt-failed', 'secret payload is not valid json');
    }
  }

  /**
   * 首次播种：域里**一台主机都没有**时才写 patch config 里的那几台。
   *
   * 只播一次是刻意的——用户删掉 patch 里的主机后重启插件，不该又冒出来。
   * @param {object[]} hosts 待播种的主机原始输入。
   * @returns {Promise<number>} 实际播种数量。
   */
  async seed(hosts) {
    this._assertReady();
    if (!Array.isArray(hosts) || hosts.length === 0) return 0;
    if (this.hostsTable.size > 0) return 0;
    let seeded = 0;
    for (const host of hosts) {
      try {
        await this.create(host);
        seeded += 1;
      } catch (error) {
        // 播种失败不该让插件激活失败：记错误码（绝不打 host 内容），继续下一台。
        const code = error instanceof HostInputError || error instanceof HostStoreError ? error.code : 'invalid-host';
        this.log(`seed skipped: ${code}`);
      }
    }
    return seeded;
  }

  /**
   * 断言域已打开。
   * @returns {void}
   */
  _assertReady() {
    if (!this.ready) throw new HostStoreError('storage-unavailable', 'host store is not initialized');
  }

  /**
   * 查重：同一 `(host, port, username)` 视为同一台机器。
   * @param {object} candidate 待写入的主机（含 host/port/username）。
   * @param {string} [excludeId] 更新时排除自己。
   * @returns {void}
   */
  _assertNoDuplicate(candidate, excludeId = undefined) {
    const username = candidate.username ?? '';
    for (const [, record] of [...this.hostsTable.entries()]) {
      if (record.id === excludeId) continue;
      if (record.host === candidate.host && record.port === candidate.port && record.username === username) {
        throw new HostStoreError(
          'duplicate-host',
          `host ${candidate.host}:${candidate.port} as ${username} already exists (${record.id})`,
        );
      }
    }
  }
}

/**
 * 把 auth 对象序列化成待加密的明文。
 * @param {object} auth `{kind, password?, privateKey?, passphrase?}`。
 * @returns {string} JSON 明文。
 */
function serializeAuth(auth) {
  /** @type {object} */
  const payload = { kind: auth.kind };
  if (typeof auth.password === 'string' && auth.password !== '') payload.password = auth.password;
  if (typeof auth.privateKey === 'string' && auth.privateKey !== '') payload.privateKey = auth.privateKey;
  if (typeof auth.passphrase === 'string' && auth.passphrase !== '') payload.passphrase = auth.passphrase;
  return JSON.stringify(payload);
}

/**
 * 默认展示名：`user@host`，没有用户名时用 host。
 * @param {object} host `{host, username}`。
 * @returns {string} 展示名。
 */
function defaultLabel(host) {
  const address = typeof host.host === 'string' ? host.host : '';
  const username = typeof host.username === 'string' ? host.username : '';
  return username === '' ? address : `${username}@${address}`;
}
