/**
 * 会话表：Host 半唯一有状态的核心模块。
 *
 * 它回答"现在有哪些 SSH 会话、每个会话的字节流放到哪了"：
 * - 传输是注入的（`createTransport`），真实 ssh2 与测试用 fake 走同一条路；
 * - 每个会话一条有界滚动缓冲（行数 / 字节数双上限，带单调 `seq`），
 *   客户端断线重连靠 `read(sid, since)` 回放，不依赖组件存活；
 * - 会话状态机：connecting -> open -> closed / error，全部由 transport
 *   的回调驱动，本模块自己不起任何定时器。
 *
 * **秘密纪律（设计 §2.11 / §7.9）**：`session.host` 只保留
 * `{id,label,host,port,username}` 五个字段；密码/私钥只作为 `open()` 的
 * 入参出现在 `createTransport(config)` 调用里，函数返回后不可达——会话记录、
 * 缓冲、describe() 的输出里都没有它们。
 *
 * 为什么把缓冲放在 Host 而不是客户端：启动台会随时卸载 view（设计 §0.3），
 * 浏览器刷新更是家常便饭；Host 侧的缓冲是唯一能在"连模块级 store 都没了"
 * 之后还把屏幕还给用户的兜底（设计 §2.5）。
 */
import { Buffer } from 'node:buffer';

/** 滚动缓冲默认上限：行数。 */
const DEFAULT_MAX_LINES = 2000;
/** 滚动缓冲默认上限：字节数（512KB）。 */
const DEFAULT_MAX_BYTES = 512 * 1024;
/** `readText()` 的默认行数与硬上限（模型侧工具不许一次拉爆上下文）。 */
const DEFAULT_TAIL_LINES = 80;
const MAX_TAIL_LINES = 500;

/** 会话生命周期的可见状态。 */
export const SessionStatus = Object.freeze({
  CONNECTING: 'connecting',
  OPEN: 'open',
  CLOSED: 'closed',
  ERROR: 'error',
});

/** 会话不存在时抛出，路由层据此回 404。 */
export class SessionNotFoundError extends Error {
  constructor(sid) {
    super(`ssh-sessions: unknown session ${JSON.stringify(sid)}`);
    this.name = 'SessionNotFoundError';
    this.code = 'unknown-session';
  }
}

/**
 * 把一个 chunk 规范成 Buffer。ssh2 给 Buffer，fake transport 与测试可能给
 * 字符串；统一按 utf8 解释，保证 base64 落库后可 round-trip。
 * @param {Buffer|Uint8Array|string} chunk 原始输出。
 * @returns {Buffer} 规范化后的字节。
 */
function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Buffer.from(String(chunk ?? ''), 'utf8');
}

/** 数一段字节里有多少个换行（0x0A），用于按行裁剪缓冲。 */
function countLines(buffer) {
  let lines = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) lines += 1;
  }
  return lines;
}

/** 把错误压成一行可展示文本，绝不把堆栈塞进状态里。 */
function errorText(error) {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/**
 * 规范化主机描述——**这是唯一面向会话/响应的主机形状，永远不含秘密**。
 *
 * 密码/私钥不在这里处理：它们由 `open({host, auth})` 的 `auth` 参数单独传入，
 * 只在拼 transport config 时短暂存在（见 {@link buildTransportConfig}）。
 * @param {object} host 原始主机描述（可以带 password/privateKey，会被丢弃）。
 * @returns {{id: string, label: string, host: string, port: number, username: string}} 规范化结果。
 */
export function normalizeHost(host = {}) {
  const address = typeof host.host === 'string' && host.host.trim() !== '' ? host.host.trim() : '127.0.0.1';
  const port = Number.isInteger(host.port) && host.port > 0 && host.port <= 65535 ? host.port : 22;
  const username = typeof host.username === 'string' ? host.username : '';
  const label =
    typeof host.label === 'string' && host.label !== ''
      ? host.label
      : username === ''
        ? address
        : `${username}@${address}`;
  return {
    id: typeof host.id === 'string' && host.id !== '' ? host.id : address,
    label,
    host: address,
    port,
    username,
  };
}

/**
 * 拼传输层配置：主机公开字段 + 秘密 + 终端尺寸。
 *
 * 返回值只作为 `createTransport()` 的入参存在，**调用方不得保存、不得返回
 * 给 HTTP 层、不得写日志**。
 * @param {object} host 主机描述（公开字段）。
 * @param {object|null} [auth] 认证信息（`{kind,password?,privateKey?,passphrase?}`）。
 * @param {number} cols 列数。
 * @param {number} rows 行数。
 * @returns {object} transport config。
 */
export function buildTransportConfig(host, auth = null, cols = 80, rows = 24) {
  const normalized = normalizeHost(host);
  /** @type {object} */
  const config = {
    id: normalized.id,
    label: normalized.label,
    host: normalized.host,
    port: normalized.port,
    username: normalized.username,
    cols,
    rows,
  };
  if (auth !== null && typeof auth === 'object') {
    if (typeof auth.password === 'string' && auth.password !== '') config.password = auth.password;
    if (typeof auth.privateKey === 'string' && auth.privateKey !== '') config.privateKey = auth.privateKey;
    if (typeof auth.passphrase === 'string' && auth.passphrase !== '') config.passphrase = auth.passphrase;
  }
  return config;
}

/**
 * SSH 会话服务。一个 dsh 进程一份实例，由 Host 半的 `apply()` 创建，
 * 不注入 cordis（它不需要别的服务）。
 */
export class SshSessionService {
  /**
   * @param {object} [options] 构造选项。
   * @param {(config: object, handlers: object) => object} [options.createTransport] 传输工厂；必填，测试注入 fake。
   * @param {number} [options.maxBufferLines] 滚动缓冲行数上限（与 patch config 同名）。
   * @param {number} [options.maxBufferBytes] 滚动缓冲字节数上限（与 patch config 同名）。
   */
  constructor(options = {}) {
    if (typeof options.createTransport !== 'function') {
      throw new TypeError('ssh-sessions: createTransport factory is required');
    }
    this.createTransport = options.createTransport;
    this.maxLines =
      Number.isInteger(options.maxBufferLines) && options.maxBufferLines > 0
        ? options.maxBufferLines
        : DEFAULT_MAX_LINES;
    this.maxBytes =
      Number.isInteger(options.maxBufferBytes) && options.maxBufferBytes > 0
        ? options.maxBufferBytes
        : DEFAULT_MAX_BYTES;
    /** @type {Map<string, object>} sid -> 会话记录。 */
    this.sessions = new Map();
    /** sid 计数器，保证 s1/s2/... 单调递增。 */
    this.counter = 0;
    /** 当前聚焦会话（模型侧工具的默认目标）。 */
    this.activeSid = null;
  }

  /**
   * 开一个会话：分配 sid、调 transport 建通道、挂上有界缓冲。
   *
   * 传输是异步连通的，本方法同步返回，状态机随后续回调推进。
   * `auth` 只用于拼 transport config：既不进 `session`，也不进缓冲。
   * @param {object} [options] 开服参数。
   * @param {object} options.host 主机描述（公开字段；多余字段会被丢弃）。
   * @param {object|null} [options.auth] 认证信息，缺省为无凭据连接。
   * @param {number} [options.cols] 初始列数。
   * @param {number} [options.rows] 初始行数。
   * @returns {object} 会话公开描述（含 sid）。
   */
  open({ host, auth = null, cols = 80, rows = 24 } = {}) {
    const hostConfig = normalizeHost(host);
    this.counter += 1;
    const sid = `s${this.counter}`;
    const session = {
      sid,
      // 只存公开字段：秘密绝不落到会话记录上（设计 §7.9）。
      host: hostConfig,
      cols: Number.isInteger(cols) && cols > 0 ? cols : 80,
      rows: Number.isInteger(rows) && rows > 0 ? rows : 24,
      status: SessionStatus.CONNECTING,
      error: null,
      exitCode: null,
      transport: null,
      /** @type {Array<{seq: number, data: string, size: number}>} 有界滚动缓冲，data 为 base64。 */
      buffer: [],
      /** 缓冲总字节数（解码后）。 */
      bytes: 0,
      /** 缓冲总行数。 */
      lines: 0,
      /** 已写入缓冲的最大 seq。 */
      seq: 0,
      /** 因超限被丢弃的分片数（>0 即发生过截断）。 */
      dropped: 0,
      /** @type {Set<Function>} 数据订阅者。 */
      listeners: new Set(),
    };
    this.sessions.set(sid, session);

    const handlers = {
      onData: (chunk) => this._append(session, chunk),
      onReady: () => {
        if (session.status === SessionStatus.CONNECTING) session.status = SessionStatus.OPEN;
      },
      onError: (error) => {
        session.error = errorText(error);
        session.status = SessionStatus.ERROR;
        this._emit(session, { kind: 'exit', code: null, reason: session.error });
      },
      onExit: (info = {}) => {
        session.exitCode = Number.isInteger(info.code) ? info.code : null;
        if (session.status !== SessionStatus.ERROR) session.status = SessionStatus.CLOSED;
        this._emit(session, { kind: 'exit', code: session.exitCode, reason: null });
      },
    };

    try {
      // 秘密只在这一行短暂出现：入参 → 工厂 → 返回值即不可达。
      session.transport = this.createTransport(
        buildTransportConfig(hostConfig, auth, session.cols, session.rows),
        handlers,
      );
    } catch (error) {
      // 工厂同步抛错（配置非法等）不能让 apply() 崩掉——会话以 error 状态留下，
      // 客户端在主机列表上能看到红灯与原因。
      session.status = SessionStatus.ERROR;
      session.error = errorText(error);
    }

    if (this.activeSid === null) this.activeSid = sid;
    return this.describe(session);
  }

  /**
   * 取会话记录，不存在时抛 {@link SessionNotFoundError}。
   * @param {string} sid 会话 id。
   * @returns {object} 会话记录（内部形态，含 transport）。
   */
  get(sid) {
    const session = this.sessions.get(sid);
    if (session === undefined) throw new SessionNotFoundError(sid);
    return session;
  }

  /**
   * 向会话写键盘字节。
   * @param {string} sid 会话 id。
   * @param {Buffer|Uint8Array|string} data 原始字节。
   * @returns {void}
   */
  send(sid, data) {
    const session = this.get(sid);
    const bytes = toBuffer(data);
    if (session.transport === null) {
      throw new Error(`ssh-sessions: session ${sid} has no transport (status=${session.status})`);
    }
    session.transport.send(bytes);
  }

  /**
   * 改变远端窗口尺寸。
   * @param {string} sid 会话 id。
   * @param {number} cols 列数。
   * @param {number} rows 行数。
   * @returns {void}
   */
  resize(sid, cols, rows) {
    const session = this.get(sid);
    const nextCols = Number.isInteger(cols) && cols > 0 && cols <= 1000 ? cols : session.cols;
    const nextRows = Number.isInteger(rows) && rows > 0 && rows <= 1000 ? rows : session.rows;
    session.cols = nextCols;
    session.rows = nextRows;
    if (session.transport !== null && typeof session.transport.resize === 'function') {
      session.transport.resize(nextCols, nextRows);
    }
  }

  /**
   * 读缓冲里 seq > since 的分片——断线重连的回放原语。
   *
   * `truncated` / `firstSeq` / `dropped` 三个字段服务于一件事：让客户端知道
   * "这次回放是有缺口的"（设计 §2.5 兜底层）。since 早于缓冲最早分片时，
   * 中间的字节已被裁掉，客户端必须能提示用户，而不是安静地少一屏。
   * @param {string} sid 会话 id。
   * @param {number} [since] 客户端已持有的最大 seq。
   * @returns {{seq: number, chunks: Array<{seq: number, data: string}>, truncated: boolean, firstSeq: number|null, dropped: number, status: string}} 回放结果。
   */
  read(sid, since = 0) {
    const session = this.get(sid);
    const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0;
    const chunks = [];
    for (const entry of session.buffer) {
      if (entry.seq > from) chunks.push({ seq: entry.seq, data: entry.data });
    }
    const firstSeq = session.buffer.length > 0 ? session.buffer[0].seq : null;
    return {
      seq: session.seq,
      chunks,
      // since 早于缓冲里最早的分片 => 中间有数据被裁掉了，客户端应提示用户。
      truncated: session.dropped > 0 && firstSeq !== null && from < firstSeq,
      firstSeq,
      dropped: session.dropped,
      status: session.status,
    };
  }

  /**
   * 把缓冲解成文本并取最后 N 行——给 `/context` 与模型侧 `ssh_read` 用。
   *
   * 实现要点：**先 Buffer.concat 再 toString('utf8')**。逐片解码会把跨片的
   * 多字节字符（中文、ANSI 序列）劈成两半产生 U+FFFD；拼接后一次性解码才
   * 与终端看到的内容一致。
   * @param {string} sid 会话 id。
   * @param {number} [lines] 需要最后多少行（默认 80，上限 500）。
   * @returns {{text: string, truncated: boolean, lines: number, dropped: number}} 文本与截断标记。
   */
  readText(sid, lines = DEFAULT_TAIL_LINES) {
    const session = this.get(sid);
    const limit = Number.isInteger(lines) && lines > 0 ? Math.min(lines, MAX_TAIL_LINES) : DEFAULT_TAIL_LINES;
    const raw = Buffer.concat(session.buffer.map((entry) => Buffer.from(entry.data, 'base64'))).toString('utf8');
    // 终端换行是 \r\n；按 \r?\n 切才不会把每行末尾留一个 \r。
    const rows = raw.split(/\r?\n/);
    // 文本以换行结尾时最后会多出一个空串，它不是一个"空行"，去掉。
    if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    const kept = rows.slice(-limit);
    return {
      text: kept.join('\n'),
      // 两种缺口都算截断：缓冲被裁过（dropped > 0），或行数超过 limit。
      truncated: session.dropped > 0 || rows.length > limit,
      lines: kept.length,
      dropped: session.dropped,
    };
  }

  /**
   * 订阅会话的数据 / 退出事件。
   * @param {string} sid 会话 id。
   * @param {(event: object) => void} listener 事件回调。
   * @returns {() => void} 退订函数。
   */
  subscribe(sid, listener) {
    const session = this.get(sid);
    if (typeof listener !== 'function') throw new TypeError('ssh-sessions: listener must be a function');
    session.listeners.add(listener);
    return () => {
      session.listeners.delete(listener);
    };
  }

  /**
   * 设置当前聚焦会话（`POST /api/dsh-ssh/focus` 的落点）。
   * @param {string} sid 会话 id。
   * @returns {string|null} 新的 activeSid。
   */
  setActive(sid) {
    this.get(sid);
    this.activeSid = sid;
    return this.activeSid;
  }

  /**
   * 关一个会话：通知 transport、广播 exit，然后把会话从表里移除。
   *
   * 移除而非留痕：客户端要的"会话结束了"信号由 exit 事件承载，不需要表里
   * 再留一条 closed 记录（留了会让 /hosts 永远显示已关闭的会话）。
   *
   * 关掉的正好是 activeSid 时，把焦点让给仍然活着的最后一个会话——否则
   * 模型侧"不传 sid"的工具会突然失去目标（设计 §2.7）。
   * @param {string} sid 会话 id。
   * @returns {object} 关闭后的公开描述。
   */
  close(sid) {
    const session = this.get(sid);
    if (session.status !== SessionStatus.CLOSED && session.status !== SessionStatus.ERROR) {
      session.status = SessionStatus.CLOSED;
    }
    if (session.transport !== null && typeof session.transport.close === 'function') {
      try {
        session.transport.close();
      } catch {
        // transport 自己收尾失败不影响会话表状态；连接即将随进程消失。
      }
    }
    this._emit(session, { kind: 'exit', code: session.exitCode, reason: session.error });
    this.sessions.delete(sid);
    if (this.activeSid === sid) {
      const remaining = [...this.sessions.keys()];
      this.activeSid = remaining.length > 0 ? remaining[remaining.length - 1] : null;
    }
    return this.describe(session);
  }

  /**
   * 关掉某台主机的**全部**会话（多标签时一个主机可能开了好几个）。
   * @param {string} hostId 主机 id。
   * @returns {string[]} 被关掉的 sid 列表（顺序按打开顺序）。
   */
  closeByHost(hostId) {
    /** @type {string[]} */
    const closed = [];
    for (const [sid, session] of [...this.sessions]) {
      if (session.host.id !== hostId) continue;
      try {
        this.close(sid);
        closed.push(sid);
      } catch {
        // 单个会话关闭失败不应阻断其余会话的清理。
      }
    }
    return closed;
  }

  /**
   * 列出某台主机的会话描述。
   * @param {string} hostId 主机 id。
   * @returns {object[]} 会话描述数组。
   */
  listByHost(hostId) {
    return this.list().filter((session) => session.host.id === hostId);
  }

  /**
   * 关掉所有会话（插件 dispose 用）。
   * @returns {void}
   */
  closeAll() {
    for (const sid of [...this.sessions.keys()]) {
      try {
        this.close(sid);
      } catch {
        // 单个会话关闭失败不应阻断其余会话的清理。
      }
    }
  }

  /**
   * 列出所有会话的公开描述。
   * @returns {object[]} 描述数组。
   */
  list() {
    return [...this.sessions.values()].map((session) => this.describe(session));
  }

  /**
   * 会话的公开描述：给 `/api/dsh-ssh/hosts` 与客户端状态灯用。
   * @param {object} session 会话记录。
   * @returns {object} 可 JSON 序列化的描述。
   */
  describe(session) {
    return {
      sid: session.sid,
      status: session.status,
      error: session.error,
      exitCode: session.exitCode,
      cols: session.cols,
      rows: session.rows,
      seq: session.seq,
      dropped: session.dropped,
      // 白名单：只放主机公开字段，禁止 ...session.host 展开（设计 §7.6）。
      host: {
        id: session.host.id,
        label: session.host.label,
        host: session.host.host,
        port: session.host.port,
        username: session.host.username,
      },
    };
  }

  /**
   * 追加一段远端输出到滚动缓冲，并通知订阅者。
   * @param {object} session 会话记录。
   * @param {Buffer|Uint8Array|string} chunk 原始输出。
   * @returns {void}
   */
  _append(session, chunk) {
    if (session.status === SessionStatus.CLOSED || session.status === SessionStatus.ERROR) return;
    let bytes = toBuffer(chunk);
    if (bytes.length === 0) return;
    // 单个分片就超过字节上限时保留其尾部：终端用户关心的是最新一屏，
    // 被冲掉的开头（例如 cat 大文件的前几行）没有回放价值。
    if (bytes.length > this.maxBytes) {
      bytes = bytes.subarray(bytes.length - this.maxBytes);
      session.dropped += 1;
    }
    session.seq += 1;
    session.buffer.push({ seq: session.seq, data: bytes.toString('base64'), size: bytes.length });
    session.bytes += bytes.length;
    session.lines += countLines(bytes);
    this._trim(session);
    this._emit(session, { kind: 'data', seq: session.seq, data: session.buffer[session.buffer.length - 1].data });
  }

  /**
   * 把缓冲裁回上限内：行数、字节数谁先超谁丢最旧的分片。
   * @param {object} session 会话记录。
   * @returns {void}
   */
  _trim(session) {
    while (
      session.buffer.length > 1 &&
      (session.lines > this.maxLines || session.bytes > this.maxBytes)
    ) {
      const oldest = session.buffer.shift();
      session.bytes -= oldest.size;
      session.lines -= countLines(Buffer.from(oldest.data, 'base64'));
      session.dropped += 1;
    }
  }

  /**
   * 向会话的所有订阅者广播事件；单个监听器抛错不能拖垮其余订阅者。
   * @param {object} session 会话记录。
   * @param {object} event 事件对象。
   * @returns {void}
   */
  _emit(session, event) {
    for (const listener of [...session.listeners]) {
      try {
        listener(event);
      } catch {
        // 订阅者（通常是 SSE 响应）出错时静默跳过，连接层自己会收尾。
      }
    }
  }
}
