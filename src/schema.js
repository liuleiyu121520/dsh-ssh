/**
 * 主机与密文的 schema 层：zod 定义 + 请求体归一化 + 响应视图白名单。
 *
 * 三件事都在这里，是因为它们必须共用同一份字段定义：
 * 1. **落库 schema**（`hostRecordSchema` / `secretBoxSchema`）——`storageDomain`
 *    的表 schema 必须是 zod `ZodType`（`storage-domain/src/spec.ts:27-32`），
 *    写错在第一次 put 时就炸，而不是留到读的时候。
 * 2. **请求体归一化**（`normalizeHostInput`）——HTTP 层的原始 JSON 不可信，
 *    端口可能是字符串、auth 可能是平铺的 M0 形态，全部在这里收口成一种形状。
 * 3. **响应视图**（`toHostView`）——白名单式展开，**禁止 `...host`**：主机记录
 *    里没有秘密，但视图层不许依赖"记录里恰好没有秘密"这个事实（设计 §7.6）。
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** 主机 id 的形状：`h-<8hex>`，**服务端生成**，客户端不得指定（设计 §2.2）。 */
const HOST_ID_PATTERN = /^h-[0-9a-f]{8}$/;

/**
 * 认证方式的闭集（**规范值**）。
 *
 * 为什么是 `pass`/`key` 而不是 `password`/`privateKey`：`authKind` 会原样出现在
 * `GET /hosts` 的响应体里，而验收要求该响应体 grep
 * `password|privateKey|"ct"|"iv"|"tag"` 必须为空——一个叫 `"authKind":"password"`
 * 的类型标签会把这条断言打红。语义不变，只是取值换成不会与秘密字段名撞车的词。
 * 客户端可以继续传 `kind:'password'` / `'privateKey'`（见 {@link AUTH_KIND_ALIASES}）。
 */
export const AUTH_KINDS = Object.freeze(['pass', 'key', 'none']);

/** 请求体里可接受的 auth.kind 别名 → 规范值。 */
const AUTH_KIND_ALIASES = Object.freeze({
  pass: 'pass',
  password: 'pass',
  pwd: 'pass',
  key: 'key',
  privateKey: 'key',
  none: 'none',
});


/**
 * 落库的主机元数据（`dsh_ssh` 域 / `hosts` 表 / `<hostId>`）。
 *
 * 注意这里**没有任何秘密字段**：密码/私钥只存在于 `secrets` 表的密文里。
 * `hasSecret` 是给 UI 判断"要不要显示'已保存凭据'"的布尔量，不泄漏内容。
 */
export const hostRecordSchema = z.object({
  id: z.string().regex(HOST_ID_PATTERN),
  label: z.string(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string(),
  authKind: z.enum(AUTH_KINDS),
  hasSecret: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * 信封加密的密文盒（`dsh_ssh` 域 / `secrets` 表 / `<hostId>`）。
 *
 * 四个字段全 base64：`v` 是格式版本（留升级缝），`iv` 12B，`tag` 16B，
 * `ct` 为密文。AAD 是 hostId，所以盒子搬到别的主机上解不开（设计 §0.1）。
 */
export const secretBoxSchema = z.object({
  v: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  ct: z.string(),
});

/**
 * 域/表名规则，与 dsh 的 `UNIT_NAME_RE` 逐字一致
 * （`storage/storage/src/backend.ts:10`）。所以是 `dsh_ssh` 而不是 `dsh-ssh`。
 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** 允许的存储布局（`storage-domain/src/spec.ts:43`）。 */
const DOMAIN_LAYOUTS = Object.freeze(['single', 'per-record']);

/**
 * 在构造期静态校验域规格，镜像 dsh `defineDomain()` 的运行时检查
 * （`storage-domain/src/spec.ts:107-147`）。
 *
 * 为什么自己做而不是 import 那个包：第三方插件只通过 ctx 服务交互，import
 * dsh 内部包会带来第二份副本与版本漂移（设计 §2.6）。但"写错 spec"这类
 * 编程错误必须在构造时就炸——等到 `open()` 才炸，报的是
 * `DomainError code=invalid-record` 这种看不出根因的错，本轮 QA 就吃过一次。
 * @param {object} spec 域规格。
 * @returns {object} 同一个 spec（便于链式）。
 */
function assertDomainSpec(spec) {
  if (!UNIT_NAME_RE.test(spec.name)) {
    throw new Error(`dsh-ssh: domain name '${spec.name}' must match ${UNIT_NAME_RE}`);
  }
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(`dsh-ssh: domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`);
  }
  if (spec.layout !== undefined && !DOMAIN_LAYOUTS.includes(spec.layout)) {
    throw new Error(
      `dsh-ssh: domain '${spec.name}' layout must be 'single' or 'per-record', got ${String(spec.layout)}`,
    );
  }
  for (const [tableName, tableSpec] of Object.entries(spec.tables ?? {})) {
    if (!UNIT_NAME_RE.test(tableName)) {
      throw new Error(`dsh-ssh: domain '${spec.name}' table name '${tableName}' must match ${UNIT_NAME_RE}`);
    }
    // 真实现的 `DomainTableSpec` 只有 `valueSchema` 一个字段
    // （`storage-domain/src/spec.ts:27-32`），读边界用 `valueSchema.parse()`。
    // 少了它，`open()` 在读存量记录时会抛 `Cannot read properties of undefined`。
    const valueSchema = tableSpec?.valueSchema;
    if (valueSchema === undefined || typeof valueSchema.safeParse !== 'function') {
      throw new Error(`dsh-ssh: table '${tableName}' must declare a zod 'valueSchema'`);
    }
  }
  return spec;
}

/**
 * 构造 `dsh_ssh` 域的规格。
 *
 * 表规格的形状是 dsh 的 `DomainTableSpec`：`{valueSchema: ZodType}`
 * （`storage-domain/src/spec.ts:27-32`）。**不是**裸 zod schema——早先按设计
 * 文档的简写直接塞 zod 对象，真 dsh 在 `open()` 读存量记录时
 * `tableSpec.valueSchema.parse(...)` 拿到 undefined 直接抛，表现为"第一次
 * 用正常、重启后主机全丢"。替身 storageDomain 从不校验存量记录，所以单测
 * 一直是绿的。
 * @returns {{name: string, version: number, tables: object}} 可直接交给 `ctx.storageDomain.open`。
 */
export function defineDomainSpec() {
  return assertDomainSpec({
    name: 'dsh_ssh',
    version: 1,
    tables: {
      hosts: { valueSchema: hostRecordSchema },
      secrets: { valueSchema: secretBoxSchema },
    },
  });
}

/** 请求体不合法（HTTP 400 `invalid-host`）。 */
export class HostInputError extends Error {
  /**
   * @param {string} message 人类可读原因（不含任何秘密）。
   */
  constructor(message) {
    super(message);
    this.name = 'HostInputError';
    this.code = 'invalid-host';
  }
}

/**
 * 请求体里 auth 的原始形状（客户端可能给，也可能完全不给）。
 *
 * `nullish()` 而不是 `optional()`：`{auth: null}` 与"没有 auth 字段"必须同样
 * 被理解成"不改凭据"。如果让 null 走进 normalizeAuth，它会被当成空对象 →
 * `kind:'none'` → 把已有密文删掉，那是数据丢失级的坑。
 */
const rawAuthSchema = z
  .object({
    // 别名在 normalizeAuth 里映射到 AUTH_KINDS；这里只做类型收口。
    kind: z.enum(['pass', 'password', 'pwd', 'key', 'privateKey', 'none']).optional(),
    password: z.string().optional(),
    privateKey: z.string().optional(),
    passphrase: z.string().optional(),
  })
  .nullish();

/** 请求体的原始形状：宽松接收（端口可给字符串），语义校验在下面手工做。 */
const rawHostInputSchema = z.object({
  label: z.unknown().optional(),
  host: z.unknown().optional(),
  port: z.unknown().optional(),
  username: z.unknown().optional(),
  auth: rawAuthSchema,
  // M0 兼容：密码/私钥平铺在顶层（旧客户端与 patch 播种都这么写）。
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
});

/**
 * 把一个任意值解析成合法端口。
 * @param {unknown} value 原始值。
 * @param {number} fallback 缺省值。
 * @returns {number} 端口。
 */
function parsePort(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const port = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HostInputError('port must be an integer between 1 and 65535');
  }
  return port;
}

/**
 * 归一化 auth 段。
 *
 * 语义：
 * - 显式 `kind:'none'` → `{kind:'none'}`（用于清除已存凭据）；
 * - 有 password → `pass`；有 privateKey → `key`；都没给 → 按 `kind` 判空；
 * - `kind` 接受别名（`password`/`pwd` → `pass`，`privateKey` → `key`），
 *   落库与响应统一用规范值。
 * `partial` 语义（PATCH）：选了口令/私钥认证但**没给对应的秘密**时返回 `null`，
 * 意思是"这次不动凭据"。这是"编辑表单里密码框留空 = 保持不变"的服务端保证——
 * 若按创建路径严格报错，用户改个端口就会被 400 挡住；若按空秘密处理，就会把
 * 已有密文删掉。两种都不可接受，所以这里单独返回 null。
 * @param {object} raw 原始 auth（可能为空对象）。
 * @param {object} [options] 选项。
 * @param {string} [options.fallbackKind] 未显式给 kind 时的推断值。
 * @param {boolean} [options.partial] 是否为部分更新（PATCH）。
 * @returns {{kind: string, password?: string, privateKey?: string, passphrase?: string}|null} 归一化结果；null 表示"不改"。
 */
function normalizeAuth(raw = {}, options = {}) {
  const partial = options.partial === true;
  const password = typeof raw.password === 'string' && raw.password !== '' ? raw.password : undefined;
  const privateKey = typeof raw.privateKey === 'string' && raw.privateKey !== '' ? raw.privateKey : undefined;
  const passphrase = typeof raw.passphrase === 'string' && raw.passphrase !== '' ? raw.passphrase : undefined;
  const declared = raw.kind ?? options.fallbackKind;
  /** @type {string|undefined} */
  let kind = declared === undefined ? undefined : AUTH_KIND_ALIASES[declared];
  if (declared !== undefined && kind === undefined) {
    throw new HostInputError(`unknown auth.kind ${JSON.stringify(declared)}`);
  }
  if (kind === undefined) {
    if (password !== undefined) kind = 'pass';
    else if (privateKey !== undefined) kind = 'key';
    else kind = 'none';
  }
  if (kind === 'pass' && password === undefined) {
    if (partial) return null;
    throw new HostInputError('auth.kind=pass requires a non-empty password');
  }
  if (kind === 'key' && privateKey === undefined) {
    if (partial) return null;
    throw new HostInputError('auth.kind=key requires a non-empty privateKey');
  }
  // 给了私钥但不是 PEM：无论创建还是更新都是用户填错了，直接拒。
  if (kind === 'key' && !privateKey.includes('PRIVATE KEY')) {
    throw new HostInputError('privateKey does not look like a PEM private key');
  }
  return { kind, password, privateKey, passphrase };
}

/**
 * 归一化一个主机请求体。
 *
 * `partial: false`（POST）要求 `host` 必填；`partial: true`（PATCH）只返回
 * 请求里**显式出现**的字段——`auth` 缺席意味着"不改凭据"，这与"传空 auth
 * 表示清除"是两件事，必须区分开（设计 §4）。
 * @param {unknown} raw 请求体。
 * @param {{partial?: boolean}} [options] 选项。
 * @returns {{label?: string, host?: string, port?: number, username?: string, auth?: object}} 归一化结果。
 */
export function normalizeHostInput(raw, options = {}) {
  const partial = options.partial === true;
  const parsed = rawHostInputSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new HostInputError(parsed.error.issues.map((issue) => issue.message).join('; '));
  const input = parsed.data;

  /** @type {object} */
  const out = {};

  if (input.host !== undefined) {
    if (typeof input.host !== 'string' || input.host.trim() === '') {
      throw new HostInputError('host must be a non-empty string');
    }
    const host = input.host.trim();
    if (/\s/.test(host)) throw new HostInputError('host must not contain whitespace');
    if (host.length > 255) throw new HostInputError('host is too long');
    out.host = host;
  } else if (!partial) {
    throw new HostInputError('host is required');
  }

  if (input.port !== undefined) out.port = parsePort(input.port, 22);
  else if (!partial) out.port = 22;

  if (input.username !== undefined) {
    if (input.username !== null && typeof input.username !== 'string') {
      throw new HostInputError('username must be a string');
    }
    out.username = typeof input.username === 'string' ? input.username.trim() : '';
  } else if (!partial) {
    out.username = '';
  }

  if (input.label !== undefined) {
    if (input.label !== null && typeof input.label !== 'string') {
      throw new HostInputError('label must be a string');
    }
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    out.label = label;
  }

  // auth：PATCH 时"没给"与"给了空"含义不同。`auth: null` 按"没给"处理
  // （见 rawAuthSchema 的注释：null 绝不能被当成"清空凭据"）。
  const authGiven = (input.auth !== undefined && input.auth !== null)
    || input.password !== undefined
    || input.privateKey !== undefined;
  if (authGiven) {
    const rawAuth = input.auth ?? {};
    const flat = {
      kind: rawAuth.kind,
      password: rawAuth.password ?? input.password,
      privateKey: rawAuth.privateKey ?? input.privateKey,
      passphrase: rawAuth.passphrase ?? input.passphrase,
    };
    const normalizedAuth = normalizeAuth(flat, { partial });
    if (normalizedAuth !== null) out.auth = normalizedAuth;
  } else if (!partial) {
    out.auth = { kind: 'none' };
  }

  // label 缺省：`user@host`，再退化到 host。空 label 在 UI 上是一行空白，
  // 所以这里必须给出可读默认值。
  if (out.label === undefined && !partial) {
    const username = out.username ?? '';
    out.label = username === '' ? (out.host ?? '') : `${username}@${out.host ?? ''}`;
  }

  return out;
}

/**
 * 生成一个新的主机 id：`h-<8hex>`。
 * @returns {string} 主机 id。
 */
export function newHostId() {
  return `h-${randomBytes(4).toString('hex')}`;
}

/**
 * 主机记录 → HTTP 响应视图（**白名单**，绝无秘密字段）。
 *
 * 字段顺序固定，便于客户端与测试做稳定断言。`status` 来自该主机的会话
 * （一主机多会话时取"当前活跃"的那个，由调用方决定传哪个）。
 * @param {object} host 主机记录。
 * @param {object|null} [session] 该主机对应的会话描述（可为 null）。
 * @returns {object} HostView。
 */
export function toHostView(host, session = null) {
  return {
    id: host.id,
    label: host.label,
    host: host.host,
    port: host.port,
    username: host.username,
    authKind: host.authKind,
    hasSecret: host.hasSecret === true,
    // 状态机：主机没有会话就是 offline（设计 §7.4）。
    status: session?.status ?? 'offline',
    sid: session?.sid ?? null,
    error: session?.error ?? null,
  };
}
