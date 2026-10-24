/**
 * HTTP 路由：`/api/dsh-ssh/*` 九个端点的全部逻辑。
 *
 * 这个模块只 import 自己的 schema 层（响应白名单）与 node 内置，不碰任何 dsh
 * 内部模块——因此可以在 node --test 里被直接引用。
 *
 * 三条纪律：
 * 1. 每条路由第一件事都是 `ctx.connection.requestRejection(req)`（M0 铁律，
 *    设计 §7.7）：连接层（远程访问鉴权一类的全局策略）说拒就拒；
 * 2. 响应体序列化前必过 `toHostView()`，**禁止 `...host` 展开**（设计 §7.6）；
 * 3. 错误体统一 `{error, code}`，`error` 保留给 M0 客户端做兼容。
 *
 * 路由形态（设计 §0.3：webServer 只有 exact/prefix，没有路径参数）：
 * - `/api/dsh-ssh/hosts` 走 **exact**，处理集合的 GET/POST；
 * - `/api/dsh-ssh/hosts` 走 **prefix**，处理 `/hosts/<id>` 的 PATCH/DELETE。
 *   同 path 不同 kind 不冲突，分发时 exact 优先。
 */
import { SessionStatus } from './sessions.js';
import { toHostView } from './schema.js';

/** 路由前缀。 */
const PREFIX = '/api/dsh-ssh';
/** 主机集合路径（exact 与 prefix 共用同一个 path）。 */
const HOSTS_PATH = `${PREFIX}/hosts`;

/** POST body 上限：终端输入再长也长不过一块粘贴板，1MB 足够。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** SSE 心跳间隔（毫秒）：防代理与浏览器把空闲连接掐掉。 */
const PING_INTERVAL_MS = 15000;

/** 会话终态集合：已经不会再有数据/退出事件的状态。 */
const TERMINAL_STATUSES = new Set([SessionStatus.CLOSED, SessionStatus.ERROR]);

/**
 * 错误码 → HTTP 状态码（设计 §7.3 的九个码全在这里）。
 *
 * `decrypt-failed` 归到 502 与 `vault-unavailable` 同一档：对客户端来说
 * "凭据层给不出可用的认证信息"，动作都是"重填凭据"；具体原因看 `code`。
 */
const STATUS_BY_CODE = Object.freeze({
  'invalid-host': 400,
  'duplicate-host': 409,
  'unknown-host': 404,
  'unknown-session': 404,
  'storage-unavailable': 501,
  'vault-unavailable': 502,
  'decrypt-failed': 502,
  'transfer-disabled': 400,
  'path-outside-root': 400,
});

/** 带 HTTP 状态码的错误，路由层统一接住转成响应。 */
export class HttpError extends Error {
  /**
   * @param {number} statusCode HTTP 状态码。
   * @param {string} message 人类可读原因。
   * @param {string} [code] 机器可读错误码。
   */
  constructor(statusCode, message, code = undefined) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * 造一个带错误码的普通 Error（服务层抛的 `code` 由 handleError 统一翻译）。
 * @param {string} code 错误码。
 * @param {string} message 原因。
 * @returns {Error} 带 code 的错误。
 */
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 把一条缓冲分片格式化成 SSE 帧。
 * @param {{seq: number, data: string}} entry 分片（data 为 base64）。
 * @returns {string} `data: {"seq":..,"chunk":..}\n\n`。
 */
export function formatSseFrame(entry) {
  return `data: ${JSON.stringify({ seq: entry.seq, chunk: entry.data })}\n\n`;
}

/**
 * 把退出事件格式化成 SSE 帧。
 * @param {{code?: number|null, reason?: string|null}} event 退出事件。
 * @returns {string} `event: exit\ndata: {...}\n\n`。
 */
export function formatExitFrame(event = {}) {
  return `event: exit\ndata: ${JSON.stringify({ code: event.code ?? null, reason: event.reason ?? null })}\n\n`;
}

/**
 * 把回放缺口格式化成 SSE meta 帧。
 * @param {{truncated: boolean, firstSeq: number|null, dropped: number, since: number}} meta 缺口信息。
 * @returns {string} `event: meta\ndata: {...}\n\n`。
 */
export function formatMetaFrame(meta) {
  return `event: meta\ndata: ${JSON.stringify(meta)}\n\n`;
}

/**
 * 连接层准入检查。返回 true 表示请求已被拒、调用方应直接收尾。
 * @param {object} ctx cordis 上下文。
 * @param {object} req 请求。
 * @param {object} res 响应。
 * @returns {boolean} 是否已拒绝。
 */
function rejected(ctx, req, res) {
  const rejection = ctx.connection.requestRejection(req);
  if (rejection !== undefined) {
    res.statusCode = rejection;
    res.end();
    return true;
  }
  return false;
}

/**
 * 发送一个 JSON 响应。
 * @param {object} res 响应。
 * @param {number} statusCode 状态码。
 * @param {unknown} payload 响应体。
 * @returns {void}
 */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/**
 * 读取并解析 JSON body。空 body 按 `{}` 处理（POST 不带参是合法调用）。
 * @param {object} req 请求。
 * @returns {Promise<object>} 解析结果。
 */
async function readJsonBody(req) {
  /** @type {Buffer[]} */
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    parts.push(part);
  }
  if (parts.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a json object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'invalid json body');
  }
}

/**
 * 校验 sid 参数：缺省 / 非字符串对应 400（会话不存在由 service 抛 404）。
 * @param {object} value 原始值。
 * @returns {string} 规范化后的 sid。
 */
function requireSid(value) {
  if (typeof value !== 'string' || value === '') throw new HttpError(400, 'sid is required');
  return value;
}

/**
 * 从 prefix 路由的 URL 里抠出主机 id。
 *
 * prefix 匹配保证 pathname 以 `/hosts` 开头（`/hosts` 本身走 exact，到不了
 * 这里），所以只需再挡掉空 id 与多段路径。
 * @param {object} req 请求。
 * @returns {string} 主机 id。
 */
function hostIdFromPath(req) {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const rest = pathname.slice(HOSTS_PATH.length);
  if (!rest.startsWith('/')) throw new HttpError(404, 'unknown route');
  const id = decodeURIComponent(rest.slice(1));
  if (id === '' || id.includes('/')) throw new HttpError(404, 'unknown host route');
  return id;
}

/**
 * 把服务层异常翻成 HTTP 响应；返回 true 表示已处理。
 * @param {object} res 响应。
 * @param {unknown} error 异常。
 * @returns {boolean} 是否已处理。
 */
function handleError(res, error) {
  // 头已发出（SSE 等长连接）时没有回头路：直接收流，绝不能二次 setHeader。
  if (res.headersSent) {
    res.end();
    return true;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.statusCode, { error: error.message, code: error.code ?? 'bad-request' });
    return true;
  }
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  const status = typeof code === 'string' ? STATUS_BY_CODE[code] : undefined;
  if (typeof code === 'string' && status !== undefined) {
    sendJson(res, status, { error: error instanceof Error ? error.message : String(error), code });
    return true;
  }
  // 未预期异常：500 但绝不把堆栈泼给客户端。
  sendJson(res, 500, {
    error: error instanceof Error ? error.message : String(error),
    code: 'internal-error',
  });
  return true;
}

/**
 * SSE 流处理器。先按 since 回放缓冲，再转实时订阅；req 关闭时解绑。
 *
 * 顺序是刻意的：read / subscribe 都可能抛 404，必须发生在 writeHead 之前；
 * 所有写入走 safeWrite——socket 半死时 res.write 会同步抛，定时器回调里
 * 抛未捕获异常会带走整个 Host 进程。
 *
 * 两个"迟到连接"边界（QA 报的 P1-B / P1-C）：
 * - 会话在客户端连上之前就已经死了（典型：连 127.0.0.1:22 被拒，用户几秒后
 *   才点开应用）——exit 事件在当时已经广播给"零个订阅者"，迟到者永远等不到。
 *   解法：回放后若会话已是终态，立刻补发 exit 帧并收流，连接不永久悬挂。
 * - 回放本身可能有缺口（缓冲裁剪过）。read() 算出了 truncated，这里必须
 *   以一帧 meta 告诉客户端"你少看了一段"，否则缺口语义上不存在。
 * @param {object} ctx cordis 上下文。
 * @param {object} service SshSessionService。
 * @param {object} req 请求。
 * @param {object} res 响应。
 * @returns {Promise<void>}
 */
async function handleStream(ctx, service, req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const sid = requireSid(url.searchParams.get('sid'));
  const rawSince = url.searchParams.get('since');
  const since = rawSince === null ? 0 : Number.parseInt(rawSince, 10);
  const from = Number.isFinite(since) && since > 0 ? since : 0;
  const replay = service.read(sid, from);
  const session = service.get(sid);

  const unsubscribe = service.subscribe(sid, (event) => {
    if (event.kind === 'data') {
      safeWrite(res, formatSseFrame({ seq: event.seq, data: event.data }));
      return;
    }
    // 会话终结：发一个 exit 事件再收流，客户端能区分"关了"和"网断了"。
    safeWrite(res, formatExitFrame(event));
    res.end();
  });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  // 首帧注释：立刻把管道冲开，客户端可据此判定"连上了"。
  safeWrite(res, ': dsh-ssh stream open\n\n');
  // 回放缺口提示：只在真的有缺口时发，安静路径上不增加任何一帧。
  if (replay.truncated) {
    safeWrite(
      res,
      formatMetaFrame({
        truncated: true,
        firstSeq: replay.firstSeq,
        dropped: replay.dropped,
        since: from,
      }),
    );
  }
  for (const entry of replay.chunks) safeWrite(res, formatSseFrame(entry));

  // 迟到连接补发 exit：会话已终态，实时订阅者等不到任何事件了。
  // reason/code 与实时路径的 onError/onExit 发射保持同一形状。
  if (TERMINAL_STATUSES.has(session.status)) {
    safeWrite(
      res,
      formatExitFrame({
        code: session.exitCode ?? null,
        reason: session.status === SessionStatus.ERROR ? (session.error ?? null) : null,
      }),
    );
    res.end();
    unsubscribe();
    return;
  }

  const ping = setInterval(() => {
    safeWrite(res, ': ping\n\n');
  }, PING_INTERVAL_MS);

  const teardown = () => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on('close', teardown);
  res.on('close', teardown);
  res.on('error', teardown);
}

/**
 * 写帧的安全版：连接半死时 write 会同步抛，定时器里抛异常会带走进程。
 * @param {object} target res。
 * @param {string} text 帧文本。
 * @returns {void}
 */
function safeWrite(target, text) {
  try {
    if (!target.writableEnded && !target.destroyed) target.write(text);
  } catch {
    // 连接已断：teardown 会随后跑到，这里静默。
  }
}

/**
 * 把一个对话事件格式化成 SSE 帧。
 * @param {object} event chat 事件（{type, ...}）。
 * @returns {string} `data: {...}\n\n`。
 */
export function formatChatFrame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * POST /api/dsh-ssh/chat —— 对话回合（SSE 事件流）。
 *
 * 事件序列：`model`（选中的 provider/model）→ `text`（增量，可多条）→
 * `tool-call`（待执行/已执行）→ `tool-result` → … → `finish`；
 * 出错是 `error` 帧不断流。finish.reason='tool-call' 表示人工确认模式下
 * 回合暂停，客户端执行后带 tool 结果再次 POST 续跑。
 * @param {() => object|null} getChat 取对话服务（llm 缺失时为 null）。
 * @param {object} req 请求。
 * @param {object} res 响应。
 * @returns {Promise<void>}
 */
async function handleChat(getChat, req, res) {
  const chat = getChat();
  if (chat === null || chat === undefined) {
    throw new HttpError(501, 'chat service unavailable: host llm service is missing', 'chat-unavailable');
  }
  const body = await readJsonBody(req);
  const sid = requireSid(body.sid);
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.on('close', onClose);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  // 首帧注释：立刻冲开管道，客户端可据此判定"连上了"。
  safeWrite(res, ': dsh-ssh chat open\n\n');
  // 心跳：模型思考与命令执行都可能有十几秒空窗，防代理掐空闲连接。
  const ping = setInterval(() => safeWrite(res, ': ping\n\n'), PING_INTERVAL_MS);
  try {
    await chat.runTurn({
      sid,
      messages,
      autoExecute: body.autoExecute === true,
      approval: typeof body.approval === 'string' ? body.approval : undefined,
      provider: typeof body.provider === 'string' ? body.provider : '',
      model: typeof body.model === 'string' ? body.model : '',
      signal: controller.signal,
      onEvent: (event) => safeWrite(res, formatChatFrame(event)),
    });
  } finally {
    clearInterval(ping);
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

/**
 * 注册全部 `/api/dsh-ssh/*` 路由。
 *
 * 每条路由一个 ctx.effect：插件停用时 webServer 的 disposer 自动跑掉，
 * 不会给宿主留半条路由。
 * @param {object} ctx cordis 上下文（已注入 webServer 与 connection）。
 * @param {object} options 选项。
 * @param {object} options.service SshSessionService 实例。
 * @param {object|(() => object|null)} [options.store] HostStore 或其取值函数（分层 inject 下晚到）。
 * @param {object[]} [options.fallbackHosts] 无持久化层时的只读主机表（来自 patch config）。
 * @returns {void}
 */
export function registerRoutes(ctx, options = {}) {
  const service = options.service;
  if (service === undefined || service === null) {
    throw new TypeError('dsh-ssh routes: service is required');
  }
  const fallbackHosts = Array.isArray(options.fallbackHosts) ? options.fallbackHosts : [];
  /**
   * 取当前的 HostStore。
   * @returns {object|null} store 或 null。
   */
  const getStore = () =>
    (typeof options.store === 'function' ? options.store() : options.store ?? null);
  /**
   * 取当前的对话服务（llm 分层 inject 晚到；缺失时为 null）。
   * @returns {object|null} chat 服务或 null。
   */
  const getChat = () =>
    (typeof options.chat === 'function' ? options.chat() : options.chat ?? null);

  /**
   * 取 store，没有就抛 `storage-unavailable`（501）。
   * @returns {object} store。
   */
  const requireStore = () => {
    const store = getStore();
    if (store === null || store === undefined || store.ready !== true) {
      throw codedError('storage-unavailable', 'host storage is not available');
    }
    return store;
  };

  /**
   * 主机记录列表：有持久化层用域里的，没有就退回 patch 只读表。
   * @returns {Promise<object[]>} 主机记录数组。
   */
  const listRecords = async () => {
    const store = getStore();
    if (store === null || store === undefined || store.ready !== true) return fallbackHosts;
    return store.list();
  };

  /**
   * 给每台主机挑一个"代表会话"：优先当前聚焦的那个，否则最后打开的那个。
   * 一主机多标签时，状态灯要反映用户正在看的那个标签。
   * @param {object[]} sessions 会话描述数组。
   * @returns {Map<string, object>} hostId -> 会话描述。
   */
  const pickSessions = (sessions) => {
    /** @type {Map<string, object>} */
    const byHost = new Map();
    for (const session of sessions) {
      const current = byHost.get(session.host.id);
      if (current === undefined || session.sid === service.activeSid) byHost.set(session.host.id, session);
    }
    return byHost;
  };

  const register = (kind, path, handler) =>
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind,
          path,
          handler: async (req, res) => {
            // 铁律：准入检查永远是第一件事。
            if (rejected(ctx, req, res)) return;
            try {
              await handler(req, res);
            } catch (error) {
              handleError(res, error);
            }
          },
        }),
      `dsh-ssh: ${kind} ${path}`,
    );

  // GET /api/dsh-ssh/stream?sid=&since= —— SSE 终端输出 + 断线回放。
  register('exact', `${PREFIX}/stream`, async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'GET only');
    await handleStream(ctx, service, req, res);
  });

  // POST /api/dsh-ssh/input —— 键盘原始字节（base64）。
  register('exact', `${PREFIX}/input`, async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const body = await readJsonBody(req);
    const sid = requireSid(body.sid);
    if (typeof body.data !== 'string') throw new HttpError(400, 'data must be a base64 string');
    // Buffer.from 对非法 base64 字符是忽略而非抛错，包 try/catch 是死代码。
    const bytes = Buffer.from(body.data, 'base64');
    service.send(sid, bytes);
    sendJson(res, 200, { ok: true, bytes: bytes.length });
  });

  // POST /api/dsh-ssh/resize —— 终端行列变化。
  register('exact', `${PREFIX}/resize`, async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const body = await readJsonBody(req);
    const sid = requireSid(body.sid);
    if (!Number.isInteger(body.cols) || !Number.isInteger(body.rows)) {
      throw new HttpError(400, 'cols and rows must be integers');
    }
    service.resize(sid, body.cols, body.rows);
    // 回显 service 钳制后的值（resize() 本身无返回值，越界值会被拉回边界），
    // 客户端以此校准自己的尺寸认知，不能拿请求值糊弄。
    const session = service.get(sid);
    sendJson(res, 200, { ok: true, cols: session.cols, rows: session.rows });
  });

  // POST /api/dsh-ssh/focus —— 聚焦上报（模型侧工具的默认目标）。
  register('exact', `${PREFIX}/focus`, async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const body = await readJsonBody(req);
    const sid = requireSid(body.sid);
    const activeSid = service.setActive(sid);
    sendJson(res, 200, { ok: true, activeSid });
  });

  // GET/POST /api/dsh-ssh/hosts —— 集合（exact；`/hosts/<id>` 由 prefix 那条接）。
  register('exact', HOSTS_PATH, async (req, res) => {
    if (req.method === 'GET') {
      const sessions = service.list();
      const byHost = pickSessions(sessions);
      const records = await listRecords();
      const hosts = records.map((record) => toHostView(record, byHost.get(record.id) ?? null));
      sendJson(res, 200, { hosts, sessions, activeSid: service.activeSid });
      return;
    }
    if (req.method === 'POST') {
      const store = requireStore();
      const body = await readJsonBody(req);
      const record = await store.create(body);
      sendJson(res, 201, { host: toHostView(record, null) });
      return;
    }
    throw new HttpError(405, 'GET or POST only');
  });

  // PATCH/DELETE /api/dsh-ssh/hosts/<id> —— 单条（prefix）。
  register('prefix', HOSTS_PATH, async (req, res) => {
    const hostId = hostIdFromPath(req);
    if (req.method === 'PATCH') {
      const store = requireStore();
      const body = await readJsonBody(req);
      const record = await store.update(hostId, body);
      const sessions = service.listByHost(hostId);
      const session = sessions.find((item) => item.sid === service.activeSid) ?? sessions[sessions.length - 1] ?? null;
      sendJson(res, 200, { host: toHostView(record, session) });
      return;
    }
    if (req.method === 'DELETE') {
      const store = requireStore();
      // 先确认主机存在（不存在就 404，别白关一堆无关会话）。
      await store.get(hostId);
      // 三步删除（设计 §2.4）：关会话 → 删密文 → 删元数据。
      const closed = service.closeByHost(hostId);
      await store.remove(hostId);
      sendJson(res, 200, { ok: true, closed });
      return;
    }
    throw new HttpError(405, 'PATCH or DELETE only');
  });

  // POST /api/dsh-ssh/open —— 显式开服（激活不再隐式连接，设计 §2.3）。
  register('exact', `${PREFIX}/open`, async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const store = requireStore();
    const body = await readJsonBody(req);
    if (typeof body.hostId !== 'string' || body.hostId === '') {
      throw new HttpError(400, 'hostId is required');
    }
    // store.get 抛 unknown-host（404）；getAuth 抛 decrypt-failed（502）。
    const record = await store.get(body.hostId);
    const auth = await store.getAuth(body.hostId);
    const session = service.open({ host: record, auth, cols: body.cols, rows: body.rows });
    // 会话即便立刻是 error 状态也回 200：客户端要拿到 sid 才能订阅它的 SSE
    // 与看错误原因（设计 §4）。
    sendJson(res, 200, { sid: session.sid, session });
  });

  // POST /api/dsh-ssh/close —— 关掉一个会话。
  register('exact', `${PREFIX}/close`, async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const body = await readJsonBody(req);
    const sid = requireSid(body.sid);
    service.close(sid);
    sendJson(res, 200, { ok: true, sid });
  });

  // GET /api/dsh-ssh/context?sid=&lines= —— 右栏上下文卡的数据源（M3）。
  register('exact', `${PREFIX}/context`, async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'GET only');
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const sid = requireSid(url.searchParams.get('sid'));
    const rawLines = url.searchParams.get('lines');
    const lines = rawLines === null ? undefined : Number.parseInt(rawLines, 10);
    const session = service.get(sid);
    const tail = service.readText(sid, Number.isFinite(lines) ? lines : undefined);
    sendJson(res, 200, {
      sid,
      host: {
        id: session.host.id,
        label: session.host.label,
        host: session.host.host,
        port: session.host.port,
        username: session.host.username,
      },
      status: session.status,
      tail: tail.text,
      gap: { truncated: tail.truncated, dropped: tail.dropped },
    });
  });

  // GET /api/dsh-ssh/llm —— 对话可用的模型清单（右栏下拉的数据源）。
  register('exact', `${PREFIX}/llm`, async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'GET only');
    const chat = getChat();
    if (chat === null) {
      // 没挂上 llm 服务也是可回答的状态：UI 显示"未配置模型"，不是错误。
      sendJson(res, 200, { available: false, providers: [], default: { provider: '', model: '' }, reason: 'chat-unavailable' });
      return;
    }
    sendJson(res, 200, await chat.describeModels());
  });

  // POST /api/dsh-ssh/chat —— 对话回合（SSE）。
  register('exact', `${PREFIX}/chat`, async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    await handleChat(getChat, req, res);
  });

  // POST /api/dsh-ssh/chat/exec —— 人工确认模式下执行一条命令并捕获输出。
  // 与自动执行同一份 marker 捕获实现；结果由客户端拼进 history 续跑对话。
  register('prefix', `${PREFIX}/chat`, async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== `${PREFIX}/chat/exec`) throw new HttpError(404, 'unknown route');
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    const chat = getChat();
    if (chat === null) {
      throw new HttpError(501, 'chat service unavailable: host llm service is missing', 'chat-unavailable');
    }
    const body = await readJsonBody(req);
    const sid = requireSid(body.sid);
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (command === '') throw new HttpError(400, 'command must be a non-empty string');
    const outcome = await chat.executeInSession({
      sid,
      command,
      timeoutMs: Number.isFinite(body.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : undefined,
    });
    sendJson(res, 200, outcome);
  });
}
