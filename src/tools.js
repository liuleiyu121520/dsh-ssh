/**
 * 模型侧接管：七个 `ssh_*` 工具 + 一段动态 systemPrompt。
 *
 * **手写 ToolDefinition 字面量，不 import 任何 `@deepseek-ai/*` 包**（设计 §2.6）：
 * 第三方插件只通过 ctx 服务交互，一旦 import dsh 的内部包，宿主升级就会带来
 * 第二份副本与版本漂移。依据是两条已核实的源码事实：
 * - `parameters` 是**裸 JSON Schema**，`tools.register` 只校验 `output.schema`
 *   （`core/tools/src/index.ts:1069-1094`）；
 * - JSON Schema 只支持 `type/oneOf/properties/required/additionalProperties/
 *   items/enum/const/description/title/default/examples`，**没有 min/max/pattern**
 *   （`tools/src/json-schema.ts:1-68`）→ 数值范围、格式约束一律在 `execute` 里自己校验。
 *
 * 工具默认目标是 `service.activeSid`（用户在终端里聚焦的那个标签），但每个工具
 * 都接受显式 `sid`（设计 §2.7）——模型在跑批量命令时不该被用户的切标签打断。
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** systemPrompt 片段的 order：PTY(1700) 与 WEB_SEARCH(2000) 之间。 */
const PROMPT_ORDER = 1750;

/** `ssh_read` 的默认行数与硬上限。 */
const DEFAULT_READ_LINES = 80;
const MAX_READ_LINES = 500;

/**
 * 造一个带错误码的 Error（工具执行失败时抛，宿主会把 message 交给模型）。
 * @param {string} code 错误码。
 * @param {string} message 原因（**不含秘密**）。
 * @returns {Error} 带 code 的错误。
 */
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 把任意输入钳成合法行数。
 * @param {unknown} value 原始值。
 * @returns {number} 1..MAX_READ_LINES 之间的整数。
 */
function clampLines(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_READ_LINES;
  return Math.min(parsed, MAX_READ_LINES);
}

/**
 * 把任意输入钳成合法终端尺寸。
 * @param {unknown} value 原始值。
 * @param {number} fallback 缺省值。
 * @returns {number} 1..1000 之间的整数。
 */
function clampSize(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 1000);
}

/**
 * 校验本地路径是否落在允许的根目录内。
 *
 * 两道检查：先 `resolve` 干掉 `..`（`resolve('/root', '../../etc/passwd')` 直接
 * 跳出去），文件存在时再 `realpath` 一次挡住"软链指向外面"。用 `relative()`
 * 判断归属，比字符串前缀更可靠（`/root` 与 `/root-evil` 不会互相误判）。
 * @param {string} root 允许的根目录（绝对路径）。
 * @param {string} candidate 用户给的路径（可相对可绝对）。
 * @returns {string} 规范化后的绝对路径。
 */
function resolveInsideRoot(root, candidate) {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  /** 判断一个路径是否在根内。 */
  const inside = (path) => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  if (!inside(absolute)) throw codedError('path-outside-root', `path is outside transferRoot: ${candidate}`);
  if (existsSync(absolute)) {
    const real = realpathSync(absolute);
    if (!inside(real)) throw codedError('path-outside-root', `path escapes transferRoot via a symlink: ${candidate}`);
    return real;
  }
  return absolute;
}

/**
 * 建七个工具的定义与提示词片段。
 * @param {object} options 选项。
 * @param {object} options.service SshSessionService。
 * @param {object|(() => object|null)} [options.store] HostStore 或取值函数。
 * @param {object} [options.config] patch config（读 allowTransfer / transferRoot）。
 * @param {(message: string) => void} [options.logger] 日志函数（只打 sid/hostId/错误码）。
 * @returns {{definitions: object[], promptText: () => string, promptOrder: number}} 工具定义与提示词。
 */
export function createSshTools(options = {}) {
  const service = options.service;
  if (service === undefined || service === null) {
    throw new TypeError('dsh-ssh tools: service is required');
  }
  const config = options.config ?? {};
  const log = typeof options.logger === 'function' ? options.logger : () => {};
  const allowTransfer = config.allowTransfer === true;
  /**
   * 允许的本地根目录，**已 realpath**。
   *
   * macOS 上 `os.tmpdir()` 是 `/var/folders/...`，而它的真实路径是
   * `/private/var/folders/...`；只 realpath 候选文件会让"合法文件"看起来在根
   * 之外。两边都规范化才比得准。
   */
  const transferRoot = (() => {
    const raw = typeof config.transferRoot === 'string' && config.transferRoot !== '' ? config.transferRoot : process.cwd();
    const absolute = resolve(raw);
    try {
      return realpathSync(absolute);
    } catch {
      return absolute;
    }
  })();
  /**
   * 取当前 store（可能还没挂上持久化层）。
   * @returns {object|null} store 或 null。
   */
  const getStore = () => (typeof options.store === 'function' ? options.store() : options.store ?? null);

  /**
   * 取一个可用的 store。
   * @returns {object} store。
   */
  const requireStore = () => {
    const store = getStore();
    if (store === null || store === undefined || store.ready !== true) {
      throw codedError('storage-unavailable', 'host storage is not available, so ssh_open cannot resolve hosts');
    }
    return store;
  };

  /**
   * 解析工具的目标会话：显式 sid 优先，否则回落到 activeSid。
   * @param {object} args 工具入参。
   * @returns {string} sid。
   */
  const targetSid = (args = {}) => {
    const explicit = typeof args.sid === 'string' && args.sid !== '' ? args.sid : null;
    const sid = explicit ?? service.activeSid;
    if (sid === null || sid === undefined) {
      throw codedError('unknown-session', 'no active ssh session; call ssh_open first or pass sid explicitly');
    }
    // service.get 会抛 unknown-session，这里先走一遍保证错误码一致。
    service.get(sid);
    return sid;
  };

  /**
   * 按 id / label / 主机名解析一台已保存的主机。
   * @param {string} ref 主机引用。
   * @returns {Promise<object>} 主机记录。
   */
  const resolveHost = async (ref) => {
    const store = requireStore();
    const records = await store.list();
    const byId = records.find((record) => record.id === ref);
    if (byId !== undefined) return byId;
    // 模型手里可能只有 label（"测试机"）或主机名，两个都认。
    const byLabel = records.find((record) => record.label === ref) ?? records.find((record) => record.host === ref);
    if (byLabel !== undefined) return byLabel;
    throw codedError('unknown-host', `unknown host ${JSON.stringify(ref)}; call ssh_hosts to list them`);
  };

  /**
   * 传输类工具的公共前置：开关 + 路径 + 会话。
   * @param {object} args 工具入参。
   * @param {string} localKey `local` 参数名。
   * @returns {{sid: string, localPath: string}} 解析结果；被拒时返回 `{error}`。
   */
  const prepareTransfer = (args, localKey) => {
    if (!allowTransfer) {
      // 默认关闭：写远端/写本地都是有破坏性的动作，必须显式在 patch 里开启。
      return { error: 'transfer-disabled' };
    }
    const local = typeof args[localKey] === 'string' ? args[localKey] : '';
    if (local === '') throw codedError('invalid-host', `${localKey} is required`);
    const sid = targetSid(args);
    try {
      return { sid, localPath: resolveInsideRoot(transferRoot, local) };
    } catch (error) {
      if (error.code === 'path-outside-root') return { error: 'path-outside-root' };
      throw error;
    }
  };

  /**
   * 取会话的 transport，并确认它支持所需的传输方法。
   * @param {string} sid 会话 id。
   * @param {'uploadFile'|'downloadFile'} method 方法名。
   * @returns {object} transport。
   */
  const requireTransport = (sid, method) => {
    const session = service.get(sid);
    const transport = session.transport;
    if (transport === null || transport === undefined) {
      throw codedError('unknown-session', `session ${sid} has no transport (status=${session.status})`);
    }
    if (typeof transport[method] !== 'function') {
      throw codedError('transfer-disabled', `transport does not implement ${method}`);
    }
    return transport;
  };

  /** 一段可复用的 `sid` 参数 schema。 */
  const sidProperty = {
    type: 'string',
    description: '目标会话 id（如 s1）。省略时作用于当前聚焦的会话。',
  };

  /** @type {object[]} */
  const definitions = [];

  // ---- ssh_hosts -------------------------------------------------------
  definitions.push({
    name: 'ssh_hosts',
    description:
      '列出所有已保存的 SSH 主机及其会话状态。返回的 id 可直接传给 ssh_open。active 表示该主机持有当前聚焦的会话。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          hosts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                host: { type: 'string' },
                port: { type: 'number' },
                username: { type: 'string' },
                authKind: { type: 'string' },
                status: { type: 'string' },
                // 用 oneOf 而不是 type:['string','null']：dsh 的 JSON Schema 子集
                // 明确支持 oneOf，数组形式的 type 没有保证（设计 §1）。
                sid: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                active: { type: 'boolean' },
              },
              required: ['id', 'label', 'host', 'port', 'username', 'authKind', 'status', 'active'],
              additionalProperties: false,
            },
          },
        },
        required: ['hosts'],
        additionalProperties: false,
      },
      render: (value) => {
        if (!Array.isArray(value?.hosts) || value.hosts.length === 0) return '没有已保存的 SSH 主机。';
        return value.hosts
          .map((host) => `${host.active ? '*' : ' '} ${host.id} ${host.label} (${host.username}@${host.host}:${host.port}) ${host.status}`)
          .join('\n');
      },
    },
    /**
     * 列出主机。
     * @returns {Promise<{hosts: object[]}>} 主机视图数组。
     */
    async execute() {
      const store = getStore();
      if (store === null || store === undefined || store.ready !== true) return { hosts: [] };
      const records = await store.list();
      const sessions = service.list();
      /** @type {Map<string, object>} */
      const byHost = new Map();
      for (const session of sessions) {
        const current = byHost.get(session.host.id);
        if (current === undefined || session.sid === service.activeSid) byHost.set(session.host.id, session);
      }
      return {
        hosts: records.map((record) => {
          const session = byHost.get(record.id) ?? null;
          return {
            id: record.id,
            label: record.label,
            host: record.host,
            port: record.port,
            username: record.username,
            authKind: record.authKind,
            status: session?.status ?? 'offline',
            sid: session?.sid ?? null,
            active: session !== null && session.sid === service.activeSid,
          };
        }),
      };
    },
  });

  // ---- ssh_open --------------------------------------------------------
  definitions.push({
    name: 'ssh_open',
    description: '在已保存的主机上打开一个新的 SSH 会话。host 可以传主机 id（推荐）或主机名/label。',
    parameters: {
      type: 'object',
      properties: {
        host: { type: 'string', description: '主机 id（h-xxxxxxxx）或主机名/label。' },
        cols: { type: 'number', description: '终端列数，默认 80。' },
        rows: { type: 'number', description: '终端行数，默认 24。' },
      },
      required: ['host'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sid: { type: 'string' },
          status: { type: 'string' },
          host: { type: 'string' },
        },
        required: ['sid', 'status', 'host'],
        additionalProperties: false,
      },
      render: (value) => `已打开会话 ${value.sid}（${value.host}），状态 ${value.status}。`,
    },
    /**
     * 开一个会话。
     * @param {object} args `{host, cols?, rows?}`。
     * @returns {Promise<{sid: string, status: string, host: string}>} 会话摘要。
     */
    async execute(args = {}) {
      if (typeof args.host !== 'string' || args.host === '') {
        throw codedError('invalid-host', 'host is required (host id, label or hostname)');
      }
      const store = requireStore();
      const record = await resolveHost(args.host);
      const auth = await store.getAuth(record.id);
      const session = service.open({
        host: record,
        auth,
        cols: clampSize(args.cols, 80),
        rows: clampSize(args.rows, 24),
      });
      log(`tool open ${record.id} ${session.sid}`);
      return { sid: session.sid, status: session.status, host: `${record.username}@${record.host}:${record.port}` };
    },
  });

  // ---- ssh_send --------------------------------------------------------
  definitions.push({
    name: 'ssh_send',
    description:
      '向 SSH 会话发送文本。submit 为 true（默认）时会在末尾追加回车，相当于"敲下这条命令"。不传 sid 时作用于当前聚焦的会话。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发送的文本（不含回车）。' },
        submit: { type: 'boolean', description: '是否追加回车，默认 true。' },
        sid: sidProperty,
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sid: { type: 'string' },
          bytes: { type: 'number' },
        },
        required: ['sid', 'bytes'],
        additionalProperties: false,
      },
      render: (value) => `已向 ${value.sid} 发送 ${value.bytes} 字节。`,
    },
    /**
     * 写键盘字节。
     * @param {object} args `{text, submit?, sid?}`。
     * @returns {{sid: string, bytes: number}} 发送结果。
     */
    execute(args = {}) {
      if (typeof args.text !== 'string') throw codedError('invalid-host', 'text must be a string');
      const sid = targetSid(args);
      const submit = args.submit !== false;
      const payload = submit ? `${args.text}\r` : args.text;
      service.send(sid, payload);
      return { sid, bytes: Buffer.byteLength(payload, 'utf8') };
    },
  });

  // ---- ssh_read --------------------------------------------------------
  definitions.push({
    name: 'ssh_read',
    description:
      '读取 SSH 会话最近若干行输出（默认 80 行，最多 500 行）。返回纯文本，ANSI 转义序列保留原样。truncated 为 true 表示缓冲区被裁剪过或行数超过请求值。',
    parameters: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: '要读取的行数，默认 80，上限 500。' },
        sid: sidProperty,
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sid: { type: 'string' },
          text: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['sid', 'text', 'truncated'],
        additionalProperties: false,
      },
      render: (value) => (value.text === '' ? `会话 ${value.sid} 暂无输出。` : value.text),
    },
    /**
     * 读最后 N 行。
     * @param {object} args `{lines?, sid?}`。
     * @returns {{sid: string, text: string, truncated: boolean}} 文本。
     */
    execute(args = {}) {
      const sid = targetSid(args);
      const tail = service.readText(sid, clampLines(args.lines));
      return { sid, text: tail.text, truncated: tail.truncated };
    },
  });

  // ---- ssh_close -------------------------------------------------------
  definitions.push({
    name: 'ssh_close',
    description: '关闭一个 SSH 会话。不传 sid 时关闭当前聚焦的会话。',
    parameters: {
      type: 'object',
      properties: { sid: sidProperty },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sid: { type: 'string' },
          closed: { type: 'boolean' },
        },
        required: ['sid', 'closed'],
        additionalProperties: false,
      },
      render: (value) => (value.closed ? `会话 ${value.sid} 已关闭。` : `会话 ${value.sid} 关闭失败。`),
    },
    /**
     * 关会话。
     * @param {object} args `{sid?}`。
     * @returns {{sid: string, closed: boolean}} 结果。
     */
    execute(args = {}) {
      const sid = targetSid(args);
      service.close(sid);
      log(`tool close ${sid}`);
      return { sid, closed: !service.sessions.has(sid) };
    },
  });

  // ---- ssh_upload ------------------------------------------------------
  definitions.push({
    name: 'ssh_upload',
    description:
      '把本地文件上传到远端（SFTP）。需要插件配置里开启 allowTransfer，且本地路径必须位于配置的 transferRoot 之内。',
    parameters: {
      type: 'object',
      properties: {
        local: { type: 'string', description: '本地文件路径（相对于 transferRoot 或绝对路径）。' },
        remote: { type: 'string', description: '远端目标路径。' },
        sid: sidProperty,
      },
      required: ['local', 'remote'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          bytes: { type: 'number' },
          error: { type: 'string' },
        },
        required: [],
        additionalProperties: false,
      },
      render: (value) => (value.error ? `上传被拒绝：${value.error}` : `已上传 ${value.bytes} 字节。`),
    },
    /**
     * 上传。
     * @param {object} args `{local, remote, sid?}`。
     * @returns {Promise<{bytes?: number, error?: string}>} 结果。
     */
    async execute(args = {}) {
      if (typeof args.remote !== 'string' || args.remote === '') throw codedError('invalid-host', 'remote is required');
      const prepared = prepareTransfer(args, 'local');
      if (prepared.error !== undefined) return { error: prepared.error };
      const transport = requireTransport(prepared.sid, 'uploadFile');
      const size = existsSync(prepared.localPath) ? statSync(prepared.localPath).size : 0;
      await transport.uploadFile(prepared.localPath, args.remote);
      log(`tool upload ${prepared.sid}`);
      return { bytes: size };
    },
  });

  // ---- ssh_download ----------------------------------------------------
  definitions.push({
    name: 'ssh_download',
    description:
      '把远端文件下载到本地（SFTP）。需要插件配置里开启 allowTransfer，且本地路径必须位于配置的 transferRoot 之内。',
    parameters: {
      type: 'object',
      properties: {
        remote: { type: 'string', description: '远端源路径。' },
        local: { type: 'string', description: '本地目标路径（相对于 transferRoot 或绝对路径）。' },
        sid: sidProperty,
      },
      required: ['remote', 'local'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          bytes: { type: 'number' },
          error: { type: 'string' },
        },
        required: [],
        additionalProperties: false,
      },
      render: (value) => (value.error ? `下载被拒绝：${value.error}` : `已下载 ${value.bytes} 字节。`),
    },
    /**
     * 下载。
     * @param {object} args `{remote, local, sid?}`。
     * @returns {Promise<{bytes?: number, error?: string}>} 结果。
     */
    async execute(args = {}) {
      if (typeof args.remote !== 'string' || args.remote === '') throw codedError('invalid-host', 'remote is required');
      const prepared = prepareTransfer(args, 'local');
      if (prepared.error !== undefined) return { error: prepared.error };
      const transport = requireTransport(prepared.sid, 'downloadFile');
      await transport.downloadFile(args.remote, prepared.localPath);
      const size = existsSync(prepared.localPath) ? statSync(prepared.localPath).size : 0;
      log(`tool download ${prepared.sid}`);
      return { bytes: size };
    },
  });

  /**
   * 动态提示词文本。
   *
   * 用函数而不是常量：`systemPrompt.section({text})` 的 `text` 允许是
   * `(ctx) => string`，**每次装配求值**（`system-prompt/src/index.ts:59-79,478-491`），
   * 所以用户切标签之后，下一轮模型看到的默认目标就是新的那个（设计 §2.10）。
   * @returns {string} 提示词片段。
   */
  const promptText = () => {
    const activeSid = service.activeSid;
    if (activeSid === null || activeSid === undefined || !service.sessions.has(activeSid)) {
      return '当前没有打开的 SSH 会话。';
    }
    const session = service.get(activeSid);
    const host = session.host;
    return (
      `当前 SSH 会话：${host.label}（${host.username}@${host.host}:${host.port}，状态 ${session.status}）。`
      + ' ssh_send/ssh_read/ssh_close 默认作用于它。'
    );
  };

  return { definitions, promptText, promptOrder: PROMPT_ORDER };
}
