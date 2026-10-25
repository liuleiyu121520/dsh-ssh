/**
 * 模块级 store：跨"启动台卸载 view"存活的唯一真相源（设计 §0.3 / §2.5）。
 *
 * 三层保活里它负责 L2：
 * - `state` 放 hosts / sessions / activeSid / 右栏折叠 / toast，React 组件
 *   随便卸载，数据不丢；
 * - `runtimes` 放 xterm 实例 + DOM wrapper + SSE 订阅（L2/L3），keyed by sid，
 *   与组件生命周期彻底脱钩；
 * - 组件侧只通过 useSyncExternalStore(subscribe, getState) 读，通过 actions 写。
 *
 * 这里也是唯一碰 fetch 的地方：三个 POST 端点 + 一个 GET，全部静默失败——
 * 网络抖动不该把 UI 打崩，状态灯与回放机制会兜底。
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { t } from './locales.js';

/** 接口前缀。 */
const API = '/api/dsh-ssh';
/**
 * 同时保活的终端上限（M0 设计 §2.5 边界 4：设 8 个上限，超出按 LRU 真销毁）。
 *
 * 关标签**不**销毁 runtime（那是保活，设计 §2.5 的 L2/L3），所以反复开关不同
 * 主机时 `runtimes` 会一直涨——每个 runtime 是一棵 DOM 子树 + 一个 EventSource
 * + 一份有界滚动缓冲。这个上限就是那道闸：新建 runtime 之后若超限，按
 * `lastUsed` 升序真销毁**没有开着的标签**的那些。
 *
 * 有标签的 runtime 永不销毁：用户正在看的终端当场变白是不可接受的，所以
 * 8 个标签都开着时允许暂时超限（那是用户显式选择，不是泄漏）。
 */
export const MAX_KEPT_RUNTIMES = 8;
/** SSE 重连退避上限（毫秒）。 */
const MAX_RETRY_MS = 15000;
/** 主机状态轮询间隔（毫秒）：连接中的状态灯要在几秒内跳到终态。 */
const POLL_INTERVAL_MS = 2000;

/** @type {object} 全局状态；每次变更整体替换，保证 useSyncExternalStore 快照稳定。 */
let state = {
  hosts: [],
  sessions: {},
  /** 中栏标签顺序（sid 数组）。关标签只从这里摘，runtimes 里的实例照旧保活。 */
  tabs: [],
  activeSid: null,
  chatOpen: true,
  /** 授权档位：auto | danger | always（默认 danger：只拦危险命令）。 */
  chatApproval: 'danger',
  toast: null,
  /** sid -> 回放缺口信息（{truncated, firstSeq, dropped, since}）；左栏据此标记"回放缺口"。 */
  gaps: {},
  /**
   * 主机表单弹层；null 表示没打开。密码框的值永远是 `''`（编辑时也不回填，
   * 设计 §0.1：秘密不进响应体，客户端拿不到就没有回填这回事）。
   * @type {{mode: 'create'|'edit', hostId: string|null, values: object, error: string|null, busy: boolean}|null}
   */
  form: null,
  /**
   * sid -> 右栏上下文卡数据（M3 方案 A）。
   * `{status: 'loading'|'ready'|'unavailable', data: object|null}`；
   * Host 侧 /context 还没就位时一律 'unavailable'，UI 优雅降级不崩。
   */
  contexts: {},
  /**
   * sid -> 对话状态（AI 助手）。
   * `{messages: object[], streaming: boolean, error: string|null}`；
   * messages 是视图模型：user 消息 `{role, content}`，assistant 回合
   * `{role:'assistant', kind:'turn', text, calls:[...]}`（calls 即命令卡）。
   * 模块级存活，切标签不丢（与 runtimes 同一保活哲学）。
   * @type {Record<string, object>}
   */
  chats: {},
  /**
   * 模型服务状态：`{status: 'idle'|'ready'|'unavailable', providers: object[], picked: {provider, model}}`。
   * @type {object}
   */
  llm: { status: 'idle', providers: [], picked: { provider: '', model: '' } },
  /** 左栏主机列表是否收起。 */
  hostsCollapsed: false,
  /** 左栏当前高亮的主机 id（单击只选中，双击才连接）。 */
  selectedHostId: null,
};

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * 订阅状态变更。
 * @param {() => void} listener 变更回调。
 * @returns {() => void} 退订函数。
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 取当前状态快照。
 * @returns {object} 状态对象（变更前引用不变）。
 */
export function getState() {
  return state;
}

/**
 * 合并补丁并广播。
 * @param {object} patch 要改的字段。
 * @returns {void}
 */
function setState(patch) {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

/**
 * 把 `sessions` 数组索引成 `sid -> session` 映射。
 * @param {object[]|undefined} sessions `GET /hosts` 返回的会话数组。
 * @returns {Record<string, object>} 映射（字段可能是空对象）。
 */
function indexSessions(sessions) {
  /** @type {Record<string, object>} */
  const map = {};
  for (const session of sessions ?? []) {
    if (session !== null && typeof session === 'object' && typeof session.sid === 'string') {
      map[session.sid] = session;
    }
  }
  return map;
}

/**
 * 认证方式闭集，**必须与 Host 侧 `src/schema.js` 的 `AUTH_KINDS` 一致**
 * （`['pass', 'key', 'none']`）。
 *
 * 取值刻意是短名而不是 `password` / `privateKey`：`authKind` 会原样出现在
 * `GET /hosts` 的 HostView 里，而验收要求响应体 grep
 * `password|privateKey|"ct"|"iv"|"tag"` 必须为空——长名会把那条断言打红。
 * 服务端对入参宽容（`password`/`pwd`/`pass` 都归一化成 `pass`），但客户端
 * 只发规范值，不给后端留模糊地带。
 */
const AUTH_KINDS = ['pass', 'key', 'none'];

/** 缺省认证方式（新建表单、以及服务端给了未知值时的兜底）。 */
const DEFAULT_AUTH_KIND = 'pass';

/**
 * 把表单值翻成路由要的请求体（设计 §4）。
 *
 * 两个要点：
 * - 秘密只在非空时才带上：编辑时留空 = 不改密文，Host 侧据此跳过 seal；
 * - 编辑时若"认证方式没变、秘密也没填"，整个 `auth` 字段**省略**——PATCH
 *   的语义是"auth 缺席 = 不改"（Host 侧 update() 里 ct 字节级不变）。
 * @param {object} values 表单值（{label,host,port,username,authKind,password,privateKey}）。
 * @param {boolean} includeAuth 是否携带 auth。
 * @returns {object} POST/PATCH 请求体。
 */
function toHostBody(values, includeAuth) {
  const rawPort = Number.parseInt(String(values?.port ?? '').trim(), 10);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 22;
  /** @type {object} */
  const body = {
    label: String(values?.label ?? '').trim(),
    host: String(values?.host ?? '').trim(),
    port,
    username: String(values?.username ?? '').trim(),
  };
  if (!includeAuth) return body;

  const kind = AUTH_KINDS.includes(values?.authKind) ? values.authKind : DEFAULT_AUTH_KIND;
  /** @type {object} */
  const auth = { kind };
  const password = typeof values?.password === 'string' ? values.password : '';
  const privateKey = typeof values?.privateKey === 'string' ? values.privateKey : '';
  if (kind === 'pass' && password !== '') auth.password = password;
  if (kind === 'key' && privateKey !== '') auth.privateKey = privateKey;
  body.auth = auth;
  return body;
}

/**
 * 编辑时是否需要携带 `auth`。
 * @param {{mode: string, values: object, originalAuthKind: string|null}} form 表单状态。
 * @returns {boolean} 是否需要携带。
 */
function shouldSendAuth(form) {
  if (form.mode === 'create') return true;
  if (form.values.authKind !== form.originalAuthKind) return true;
  if (form.values.authKind === 'pass' && form.values.password !== '') return true;
  if (form.values.authKind === 'key' && form.values.privateKey !== '') return true;
  return false;
}

/** 错误码 -> 文案 key（设计 §7.3）。 */
const ERROR_KEYS = {
  'invalid-host': 'errorInvalidHost',
  'duplicate-host': 'errorDuplicateHost',
  'unknown-host': 'errorUnknownHost',
  'unknown-session': 'errorUnknownSession',
  'storage-unavailable': 'errorStorageUnavailable',
  'vault-unavailable': 'errorVaultUnavailable',
  'decrypt-failed': 'errorDecryptFailed',
  'transfer-disabled': 'errorTransferDisabled',
  'path-outside-root': 'errorPathOutsideRoot',
};

/**
 * 把异常翻成一句人话（优先按错误码查表）。
 * @param {unknown} error 异常。
 * @returns {string} 文案。
 */
function describeError(error) {
  const code = error !== null && typeof error === 'object' ? error.code : null;
  const key = typeof code === 'string' ? ERROR_KEYS[code] : undefined;
  if (key !== undefined) return t(key);
  const message = error instanceof Error ? error.message : String(error);
  return t('errorGeneric', { message });
}

/**
 * 字节数组转 base64。
 * @param {Uint8Array} bytes 原始字节。
 * @returns {string} base64 文本。
 */
export function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

/**
 * base64 转字节数组。
 * @param {string} text base64 文本。
 * @returns {Uint8Array} 原始字节。
 */
export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * 读一个宿主 CSS 变量；取不到时回退 fallback。
 * @param {string} name 变量名（含 --）。
 * @param {string} fallback 回退值。
 * @returns {string} 颜色值。
 */
function readAlias(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/**
 * 从 --dsw-alias-* 组装 xterm 主题。
 *
 * 只读变量、不判断明暗：主题随宿主切换自动正确，JS 侧零逻辑。
 * @returns {object} xterm ITheme。
 */
function terminalTheme() {
  return {
    background: readAlias('--dsw-alias-bg-base', '#1b1b1f'),
    foreground: readAlias('--dsw-alias-label-primary', '#e6e6e6'),
    cursor: readAlias('--dsw-alias-label-primary', '#e6e6e6'),
    cursorAccent: readAlias('--dsw-alias-bg-base', '#1b1b1f'),
    selectionBackground: readAlias('--dsw-alias-bg-layer-3', '#3a3a44'),
    black: readAlias('--dsw-alias-bg-layer-4', '#2a2a30'),
    white: readAlias('--dsw-alias-label-secondary', '#b8b8c0'),
    brightBlack: readAlias('--dsw-alias-label-tertiary', '#8a8a94'),
    red: readAlias('--dsw-alias-label-error', '#e5534b'),
    green: readAlias('--dsw-alias-brand-primary', '#4c8dff'),
    yellow: readAlias('--dsw-alias-label-tertiary', '#c8a24a'),
    blue: readAlias('--dsw-alias-brand-primary', '#4c8dff'),
    magenta: readAlias('--dsw-alias-label-primary-dimmed', '#a06ac8'),
    cyan: readAlias('--dsw-alias-label-secondary', '#4ab8a8'),
  };
}

/** @type {Map<string, object>} sid -> 运行时（xterm + DOM wrapper + SSE）。 */
const runtimes = new Map();

// ── AI 助手：对话状态机（视图模型 ↔ llm history 双向映射） ──────────────
//
// 视图模型（state.chats[sid].messages）：
//   user      {role:'user', content: string}
//   assistant {role:'assistant', kind:'turn', text, calls: [call], streaming?}
//     call = {id, name, command, arguments, status, ok, output, timedOut,
//             resultContent?, resultError?}
//       status: 'awaiting'（等用户确认）| 'running' | 'done' | 'failed'
//               | 'skipped'
// llm history（POST /chat 的 messages）由 buildChatHistory 推导：assistant
// 回合拆成"文本块 + tool-call 块"的一条消息，每个有 resultContent 的 call
// 跟一条 {role:'tool'} 结果消息。

/** localStorage 键：模型选择与自动执行开关。 */
const LS_MODEL = 'dsh-ssh:chatModel';

/**
 * 从清单里挑第一个"已知可用"（未打 unavailable 标记、且不在回避表里）的
 * provider + 首个模型。
 *
 * `avoid` 是本次会话里**刚刚调用失败**的通道：不过滤掉它，"自动切换"会把
 * 用户从坏通道切到同一个坏通道——表现就是报错后模型下拉纹丝不动、也没有
 * 任何提示（2026-10-24 真机：DeepSeek 官方通道 transport failed 后一直卡在
 * 同一通道，而第一个 provider 恰好就是它）。
 *
 * 层层退让：可用且未回避 → 未回避 → 全部。最后一级是"实在没得选，让用户
 * 至少能试，错误会原样透出"。
 * @param {object[]} providers 模型清单。
 * @param {string[]} [avoid] 需要回避的 provider id。
 * @returns {{provider: string, model: string}} 选择结果；无可选时两个字段皆空。
 */
function pickHealthy(providers, avoid = []) {
  const rows = providers ?? [];
  const avoided = new Set(avoid);
  const usable = rows.filter((row) => row.unavailable === undefined && avoided.has(row.id) === false);
  const notAvoided = rows.filter((row) => avoided.has(row.id) === false);
  const pool = usable.length > 0 ? usable : (notAvoided.length > 0 ? notAvoided : rows);
  for (const row of pool) {
    const model = (row.models ?? [])[0] ?? null;
    if (model !== null) return { provider: row.id, model: model.id };
  }
  return { provider: '', model: '' };
}
const LS_APPROVAL = 'dsh-ssh:chatApproval';
/** 旧版布尔开关的键：迁移用，读到 '1' 视为 auto。 */
const LS_AUTO_EXEC_LEGACY = 'dsh-ssh:chatAutoExec';
/** 合法档位。 */
const APPROVALS = ['auto', 'danger', 'always'];

/** localStorage 键：调用失败过的通道（重启后也别再自动选它）。 */
const LS_AVOID = 'dsh-ssh:chatAvoid';
/** 回避表上限：够覆盖这台机器的通道数，又不会无限长。 */
const MAX_AVOID = 8;

/**
 * 读取回避表。坏数据一律当空表——这个表只影响"默认选谁"，绝不能让它
 * 把右栏打崩。
 * @returns {string[]} provider id 列表。
 */
function loadAvoid() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_AVOID) ?? '[]');
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && id !== '') : [];
  } catch {
    return [];
  }
}

/** 本次会话的回避表（localStorage 是持久层，这里是内存副本）。 */
let avoidProviders = loadAvoid();

/**
 * 记一个"调用失败"的通道并持久化。
 * @param {string} provider provider id。
 * @returns {void}
 */
function rememberAvoid(provider) {
  if (provider === '') return;
  avoidProviders = [...avoidProviders.filter((id) => id !== provider), provider].slice(-MAX_AVOID);
  try {
    localStorage.setItem(LS_AVOID, JSON.stringify(avoidProviders));
  } catch {
    // 隐私模式：内存副本照旧生效，只是重启后忘掉。
  }
}

/**
 * 忘掉一个通道的失败记录（用户手动选了它，就是"我愿意再试"）。
 * @param {string} provider provider id。
 * @returns {void}
 */
function forgetAvoid(provider) {
  if (avoidProviders.includes(provider) === false) return;
  avoidProviders = avoidProviders.filter((id) => id !== provider);
  try {
    localStorage.setItem(LS_AVOID, JSON.stringify(avoidProviders));
  } catch {
    // 忽略。
  }
}

/** 进行中的对话请求的 AbortController（"停止"按钮用）。 */
let chatAbort = null;
/** 最近一次对话事件的时间戳（看门狗用）。 */
let chatLastEventAt = 0;
/**
 * 看门狗两档阈值。
 *
 * 只有 60s 硬超时是不够的：思考型模型（reasoning effort）单是思考就可能
 * 超过 60s，而通道侧（如 our-free-model 的 combo）在出首个正文前会把
 * reasoning 增量整个缓冲住、一个字节都不吐——两者都不是"挂死"，掐掉只会
 * 把能答的回合变成超时（2026-10-24 真机：同一模型原生对话能答、右栏必超时）。
 *
 * 所以：60s 只**提示**"还在等"，180s 才是真挂死（连心跳都没有）。
 */
const WATCHDOG_SLOW_MS = 60000;
const WATCHDOG_HARD_MS = 180000;

/**
 * 取（或懒建）一个会话的对话状态。
 *
 * 三个布尔各有各的意思，**不能合并**：
 * - `streaming`：有在途请求（模型正在吐字/跑命令）；
 * - `pending`：回合因工具调用暂停，等用户点"执行/跳过"——此时既不能发新
 *   消息（历史里会留下没有结果的 tool-call，wire 校验必炸），也不该显示
 *   "停止"（没有可停的东西）；
 * - `slow`：看门狗提示"还在等模型"，纯 UI 提示，不影响请求。
 * @param {string} sid 会话 id。
 * @returns {object} 对话状态。
 */
function chatOf(sid) {
  return state.chats[sid] ?? { messages: [], streaming: false, pending: false, slow: false, retrying: null, error: null };
}

/**
 * 合并补丁到某个会话的对话状态并广播。
 * @param {string} sid 会话 id。
 * @param {object} patch 补丁。
 * @returns {void}
 */
function patchChat(sid, patch) {
  const next = { ...chatOf(sid), ...patch };
  setState({ chats: { ...state.chats, [sid]: next } });
}

/**
 * 往某个会话的对话里追加一条消息。
 * @param {string} sid 会话 id。
 * @param {object} message 消息（视图模型）。
 * @returns {void}
 */
function appendChatMessage(sid, message) {
  patchChat(sid, { messages: [...chatOf(sid).messages, message] });
}

/**
 * 把流式文本增量并进"当前回合"（没有就新建一个）。
 * @param {string} sid 会话 id。
 * @param {string} text 增量文本。
 * @returns {void}
 */
function appendTurnText(sid, text) {
  const messages = chatOf(sid).messages.slice();
  const last = messages[messages.length - 1];
  if (last !== undefined && last.kind === 'turn' && last.streaming === true) {
    messages[messages.length - 1] = { ...last, text: last.text + text };
  } else {
    messages.push({ role: 'assistant', kind: 'turn', text, calls: [], streaming: true });
  }
  patchChat(sid, { messages });
}

/** 思考文本在客户端保留的最大字符数（截尾：结论在最后）。 */
const MAX_REASONING_CHARS = 8000;

/**
 * 把流式"思考"增量并进当前回合（没有就新建一个）。
 *
 * 思考不落进 llm history（只是给人看的进度），所以单独一个字段，长度截尾
 * 保留——思考几万字时既不该撑爆内存，也没必要全留。
 * @param {string} sid 会话 id。
 * @param {string} text 增量文本。
 * @returns {void}
 */
function appendTurnReasoning(sid, text) {
  const messages = chatOf(sid).messages.slice();
  const last = messages[messages.length - 1];
  const merged = `${last !== undefined && last.kind === 'turn' ? last.reasoning ?? '' : ''}${text}`;
  const kept = merged.length > MAX_REASONING_CHARS ? merged.slice(-MAX_REASONING_CHARS) : merged;
  if (last !== undefined && last.kind === 'turn' && last.streaming === true) {
    messages[messages.length - 1] = { ...last, reasoning: kept };
  } else {
    messages.push({ role: 'assistant', kind: 'turn', text: '', calls: [], reasoning: kept, streaming: true });
  }
  patchChat(sid, { messages });
}

/**
 * 给当前回合追加一个工具调用卡片。
 * @param {string} sid 会话 id。
 * @param {object} call 工具调用（{id, name, command, arguments}）。
 * @returns {void}
 */
function appendTurnCall(sid, call) {
  const messages = chatOf(sid).messages.slice();
  const last = messages[messages.length - 1];
  const card = {
    id: call.id,
    name: call.name,
    command: call.command,
    arguments: call.arguments,
    // 只有 Host 明确要求确认的卡片才停在 awaiting；自动执行的直接算 running
    // （danger 档下同一个回合里可能两种都有）。
    status: call.needsConfirm === true ? 'awaiting' : 'running',
    dangerous: call.dangerous === true,
    ok: null,
    output: '',
    timedOut: false,
  };
  if (last !== undefined && last.kind === 'turn' && last.streaming === true) {
    messages[messages.length - 1] = { ...last, calls: [...last.calls, card] };
  } else {
    messages.push({ role: 'assistant', kind: 'turn', text: '', calls: [card], streaming: true });
  }
  patchChat(sid, { messages });
}

/**
 * 按 id 找到某个 call 并打补丁。
 * @param {string} sid 会话 id。
 * @param {string} callId 工具调用 id。
 * @param {object} patch 补丁。
 * @returns {void}
 */
function patchCall(sid, callId, patch) {
  const messages = chatOf(sid).messages.slice();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.kind !== 'turn') continue;
    const callIndex = (message.calls ?? []).findIndex((call) => call.id === callId);
    if (callIndex === -1) continue;
    const calls = message.calls.slice();
    calls[callIndex] = { ...calls[callIndex], ...patch };
    messages[index] = { ...message, calls };
    patchChat(sid, { messages });
    return;
  }
}

/**
 * 把视图模型推导成 llm history。
 * @param {object[]} messages 视图模型消息。
 * @returns {object[]} llm history。
 */
function buildChatHistory(messages, picked = { provider: '', model: '' }) {
  /** @type {object[]} */
  const history = [];
  for (const message of messages) {
    if (message.role === 'user') {
      history.push({ role: 'user', content: String(message.content ?? '') });
      continue;
    }
    if (message.kind !== 'turn') continue;
    /** @type {object[]} */
    const blocks = [];
    // 思考块是签名载体：有 replayState 就必须把它放回第一位（顺序也是契约）。
    if (message.replayState !== undefined) blocks.push({ type: 'reasoning', text: '' });
    if (typeof message.text === 'string' && message.text !== '') {
      blocks.push({ type: 'text', text: message.text });
    }
    for (const call of message.calls ?? []) {
      blocks.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments });
    }
    if (blocks.length > 0) {
      history.push({
        role: 'assistant',
        content: blocks,
        source: message.replayState === undefined
          ? { kind: 'model', provider: picked.provider, model: picked.model }
          : { kind: 'model', provider: picked.provider, model: picked.model, replayState: message.replayState },
      });
    }
    for (const call of message.calls ?? []) {
      if (call.resultContent === undefined) continue;
      history.push({
        role: 'tool',
        toolCallId: call.id,
        content: call.resultContent,
        isError: call.resultError === true,
      });
    }
  }
  return history;
}

/**
 * 读 SSE 流（fetch + ReadableStream；POST 没有 EventSource）。
 * @param {object} response fetch 响应。
 * @param {(event: object) => void} onEvent 事件回调。
 * @returns {Promise<void>}
 */
async function readChatStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      // `data: ` 开头的才是事件帧；`: ping` / 注释直接忽略。
      if (frame.startsWith('data: ')) {
        try {
          onEvent(JSON.parse(frame.slice(6)));
        } catch {
          // 半包 JSON：丢，下一帧会带上完整状态。
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }
}

/**
 * 处理一个对话事件（流式增量落进视图模型）。
 * @param {string} sid 会话 id。
 * @param {object} event 事件。
 * @returns {void}
 */
function handleChatEvent(sid, event) {
  if (event?.type === 'model') {
    setState({ llm: { ...state.llm, picked: { provider: event.provider, model: event.model } } });
    return;
  }
  if (event?.type === 'retry') {
    // 通道抖动，Host 正在退避重试：让用户看到"还在动"，而不是又一段空白。
    patchChat(sid, { retrying: { attempt: Number(event.attempt) || 1, max: Number.isInteger(event.maxRetries) ? event.maxRetries : null } });
    return;
  }
  if (event?.type === 'reasoning' && typeof event.text === 'string') {
    patchChat(sid, { retrying: null });
    appendTurnReasoning(sid, event.text);
    return;
  }
  if (event?.type === 'text' && typeof event.text === 'string') {
    patchChat(sid, { retrying: null });
    appendTurnText(sid, event.text);
    return;
  }
  if (event?.type === 'tool-call') {
    appendTurnCall(sid, event);
    return;
  }
  if (event?.type === 'tool-result') {
    patchCall(sid, event.id, {
      status: event.ok === true ? 'done' : 'failed',
      ok: event.ok === true,
      output: typeof event.output === 'string' ? event.output : '',
      timedOut: event.timedOut === true,
    });
    return;
  }
  if (event?.type === 'error') {
    patchChat(sid, { streaming: false, pending: false, slow: false, retrying: null, error: typeof event.message === 'string' ? event.message : 'unknown error' });
    // 模型级失败：把**刚失败的那个通道**记进回避表，再挑一个不同的健康通道
    // 顶上——否则 localStorage 里的坏选择会把用户钉死在同一个错误上，而
    // "挑第一个可用通道"在没有 unavailable 标记时恰好又会挑回它自己
    // （2026-10-24 真机：DeepSeek 官方通道 transport failed 后下拉纹丝不动）。
    // 会话级错误（会话没了/历史为空）不在此列，与模型无关。
    const sessionLevel = new Set(['unknown-session', 'empty-history', 'chat-unavailable']);
    const code = typeof event.code === 'string' ? event.code : '';
    if (sessionLevel.has(code) === false) {
      const failed = state.llm.picked.provider;
      rememberAvoid(failed);
      const healthy = pickHealthy(state.llm.providers, avoidProviders);
      // 候选本身也在回避表里 = 没有别的通道可选（pickHealthy 的最后一级会
      // 把坏通道还回来）。这时候切过去只会在两个坏通道之间来回弹，不如
      // 原地报错让用户自己决定。
      if (healthy.provider !== '' && healthy.provider !== failed && avoidProviders.includes(healthy.provider) === false) {
        // 让下拉也能看出"这条通道刚炸过"：标上不可用（仍可手动选回）。
        setState({
          llm: {
            ...state.llm,
            picked: healthy,
            providers: state.llm.providers.map((row) => (row.id === failed ? { ...row, unavailable: '调用失败' } : row)),
          },
        });
        try {
          localStorage.setItem(LS_MODEL, JSON.stringify(healthy));
        } catch {
          // 忽略。
        }
        actions.showToast(t('chatAutoSwitched', { model: healthy.model }));
        return 'channel-switched';
      }
      if (healthy.provider === '') {
        // 一个能用的都没有：别装作切过了，明说。
        actions.showToast(t('chatNoHealthy'));
      }
    }
    return;
  }
  if (event?.type === 'finish') {
    // tool-call = 人工确认模式下回合暂停，等用户逐条执行/跳过后续跑。
    // 其余 reason（stop / max-rounds / aborted）= 回合结束。
    //
    // 暂停**不是**流式：`streaming` 只表示"有在途请求"。暂停用 `pending`
    // 单独记，否则输入区会一直显示"停止"、消息区一直显示"思考中"，而
    // resolveToolCall 开头的 streaming 守卫会把"执行"按钮也一起挡死。
    const awaiting = event.reason === 'tool-call';
    const replayState = event.replayState === undefined ? undefined : event.replayState;
    // 这轮跑通了：把"调用失败"标记与回避记录撤掉——它现在能用了。否则下拉里
    // 会一直挂着"（调用失败）"，用户以为还坏着（2026-10-24 用户就是照这个
    // 标签来问"为什么我的 deepseek 会失败"）。
    if (event.reason !== 'aborted') {
      const provider = state.llm.picked.provider;
      const marked = state.llm.providers.some((row) => row.id === provider && row.unavailable === '调用失败');
      if (marked === true || avoidProviders.includes(provider) === true) {
        forgetAvoid(provider);
        setState({
          llm: {
            ...state.llm,
            providers: state.llm.providers.map((row) => (row.id === provider ? { ...row, unavailable: undefined } : row)),
          },
        });
      }
    }
    const messages = chatOf(sid).messages.slice();
    const last = messages[messages.length - 1];
    if (last !== undefined && last.kind === 'turn' && last.streaming === true) {
      messages[messages.length - 1] = { ...last, streaming: false, ...replayState === undefined ? {} : { replayState } };
      patchChat(sid, { messages, streaming: false, pending: awaiting, slow: false, retrying: null });
    } else {
      patchChat(sid, { streaming: false, pending: awaiting, slow: false, retrying: null });
    }
  }
}

/**
 * 这一轮是否"什么都没产出"（没有正文、没有命令卡）。
 *
 * 只有这种情况才适合换通道后自动重发：已经有内容时重发，模型看到的是
 * "自己说过的话"，会接着写而不是重新回答，反而更乱。
 * @param {string} sid 会话 id。
 * @returns {boolean} 没产出返回 true。
 */
function producedNothing(sid) {
  const last = chatOf(sid).messages.at(-1);
  if (last === undefined || last.kind !== 'turn') return true;
  const hasText = typeof last.text === 'string' && last.text !== '';
  const hasCalls = Array.isArray(last.calls) && last.calls.length > 0;
  return hasText === false && hasCalls === false;
}

/**
 * 跑一个对话回合：POST /chat 收 SSE，事件落进 state.chats[sid]。
 * @param {string} sid 会话 id。
 * @param {{retried?: boolean}} [options] retried=true 表示这是通道切换后的自动重发。
 * @returns {Promise<void>}
 */
async function runChatTurn(sid, options = {}) {
  const current = chatOf(sid);
  if (chatAbort !== null) return; // 同一会话只允许一个在途回合
  chatAbort = new AbortController();
  patchChat(sid, { streaming: true, pending: false, slow: false, retrying: null, error: null });
  // 看门狗：60s 没事件只提示"还在等"，180s 才断开。
  // 为什么不是 60s 直接掐：思考型模型单是思考就可能超过 60s，且部分通道
  // 在首个正文前会把 reasoning 整个缓冲住（一个事件都不吐）。60s 硬掐等于
  // 把能答的回合变成超时——同一模型在原生对话里能答、在右栏必挂，就是这么
  // 来的（2026-10-24 真机）。真挂死的特征是**连心跳都没有**，180s 足够。
  chatLastEventAt = Date.now();
  let watchdogFired = false;
  const controller = chatAbort;
  const watchdog = setInterval(() => {
    const silent = Date.now() - chatLastEventAt;
    if (silent > WATCHDOG_HARD_MS) {
      watchdogFired = true;
      controller.abort();
      return;
    }
    if (silent > WATCHDOG_SLOW_MS && chatOf(sid).slow !== true) patchChat(sid, { slow: true });
  }, 5000);
  try {
    const response = await fetch(`${API}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        sid,
        messages: buildChatHistory(current.messages, state.llm.picked),
        approval: state.chatApproval,
        provider: state.llm.picked.provider,
        model: state.llm.picked.model,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const data = await response.json();
        if (typeof data?.error === 'string') message = data.error;
      } catch {
        // 非 JSON 错误体：用状态码。
      }
      patchChat(sid, { streaming: false, error: message });
      return;
    }
    let switched = false;
    await readChatStream(response, (event) => {
      chatLastEventAt = Date.now();
      // 有动静就把"还在等"的提示撤掉（reasoning 增量也算动静）。
      if (chatOf(sid).slow === true) patchChat(sid, { slow: false });
      if (handleChatEvent(sid, event) === 'channel-switched') switched = true;
    });
    patchChat(sid, { streaming: false });
    // 通道级失败换了通道：**自动重发一次**，别让用户为一次通道故障手动重发
    // （2026-10-24 真机：切换其实成功了，但红字留在气泡里，用户以为还是不行）。
    // 只在"这一轮什么都没产出"时重发：已经有正文/命令卡的话，重发会让模型
    // 接着写而不是重答，反而更乱。
    if (switched === true && options.retried !== true && producedNothing(sid) === true) {
      clearInterval(watchdog);
      chatAbort = null;
      await runChatTurn(sid, { retried: true });
      return;
    }
  } catch (error) {
    if (watchdogFired === true) {
      patchChat(sid, { streaming: false, pending: false, slow: false, error: t('chatWatchdog') });
    } else {
      // AbortError 是用户点"停止"：静默收尾，不当成错误展示。
      patchChat(sid, {
        streaming: false,
        pending: false,
        slow: false,
        error: error?.name === 'AbortError' ? null : (error?.message ?? String(error)),
      });
    }
  } finally {
    clearInterval(watchdog);
    chatAbort = null;
  }
}

/** toast 自动消失的定时器句柄。 */
let toastTimer = null;
/** 主机状态轮询定时器句柄。 */
let pollTimer = null;

/**
 * 连（或重连）某个运行时的 SSE 流。
 *
 * 断线不依赖 EventSource 自带重连：那会用初始 URL（since=0）全量重放。
 * 这里按 rt.seq 续传，只补缺失的分片。
 * @param {object} rt 运行时。
 * @returns {void}
 */
function connectStream(rt) {
  if (rt.es !== null) return;
  const url = `${API}/stream?sid=${encodeURIComponent(rt.sid)}&since=${rt.seq}`;
  const source = new EventSource(url);
  rt.es = source;

  // 连上就把退避计数归零：否则一次成功握手后，retry 只增不减，下次偶发
  // 断线会直接从长退避开始，用户白等。
  source.onopen = () => {
    rt.retry = 0;
  };

  source.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof frame.seq !== 'number' || frame.seq <= rt.seq) return;
    rt.seq = frame.seq;
    if (typeof frame.chunk === 'string' && frame.chunk !== '') {
      rt.term.write(base64ToBytes(frame.chunk));
    }
  };

  // 回放缺口：Host 的滚动缓冲裁掉了 since 之前的字节。记进 state，左栏
  // 该主机显示"回放缺口"标记——用户少看了一段屏幕，必须有个地方说。
  source.addEventListener('meta', (event) => {
    let meta;
    try {
      meta = JSON.parse(event.data);
    } catch {
      return;
    }
    if (meta?.truncated !== true) return;
    setState({ gaps: { ...state.gaps, [rt.sid]: meta } });
  });

  // 会话终结：主机侧发了 exit，重连没有意义，停在最后一屏。
  source.addEventListener('exit', () => {
    source.close();
    rt.es = null;
  });

  source.onerror = () => {
    source.close();
    rt.es = null;
    rt.retry = Math.min(rt.retry + 1, 6);
    const delay = Math.min(2 ** (rt.retry - 1) * 1000, MAX_RETRY_MS);
    setTimeout(() => {
      // 期间运行时可能已被 LRU 销毁。
      if (runtimes.get(rt.sid) === rt) connectStream(rt);
    }, delay);
  };
}

/**
 * 把键盘 / 尺寸 / 聚焦事件接到 HTTP 端点上。
 * @param {object} rt 运行时。
 * @returns {void}
 */
function wireRuntime(rt) {
  rt.term.onData((data) => {
    void actions.postInput(rt.sid, new TextEncoder().encode(data));
  });
  rt.term.onResize(({ cols, rows }) => {
    void actions.postResize(rt.sid, cols, rows);
  });
  // 聚焦上报：xterm 6.0 的**公开 API 移除了 onFocus**（内部 CoreBrowserTerminal
  // 还有但没暴露，2026-10-24 真机实测：无条件调用会让每次打开会话都抛
  // TypeError，整个视图被启动台错误边界兜成"此应用加载失败"）。特性检测 +
  // textarea 的 DOM focus 事件兜底——聚焦只影响模型侧工具的默认目标会话，
  // 丢不得，但更不能让视图崩。
  const reportFocus = () => {
    void actions.postFocus(rt.sid);
  };
  if (typeof rt.term.onFocus === 'function') {
    rt.term.onFocus(reportFocus);
  } else {
    const textarea = rt.term.textarea;
    if (textarea !== undefined && textarea !== null && typeof textarea.addEventListener === 'function') {
      textarea.addEventListener('focus', reportFocus);
    }
  }
}

/**
 * LRU 淘汰：超出上限时销毁"最久未用**且没有开着的标签**"的运行时。
 *
 * 三条不变量：
 * 1. 候选集里**排除有标签的 sid**——用户正在看的终端绝不能当场变白；
 * 2. 按 `lastUsed` 升序挑最旧的那个，逐个销毁直到回到上限；
 * 3. 若候选集空了（所有 runtime 都有标签）就**停手并允许超限**：那是用户
 *    显式开了 9 个以上标签的结果，不是泄漏，等他自己关标签即可。
 *
 * 只在"新建 runtime 之后"调用：`runtimes` 只会因为新建而变大（关标签不删
 * runtime），所以每次新建后收敛一次就足以保证表不会无限增长。
 * @returns {void}
 */
function evictRuntimes() {
  while (runtimes.size > MAX_KEPT_RUNTIMES) {
    const tabbed = new Set(state.tabs);
    let oldest = null;
    for (const rt of runtimes.values()) {
      if (tabbed.has(rt.sid)) continue;
      if (oldest === null || rt.lastUsed < oldest.lastUsed) oldest = rt;
    }
    // 没有可淘汰的候选：全部都有标签，允许超限。
    if (oldest === null) return;
    destroyRuntime(oldest.sid);
  }
}

/**
 * 销毁一个运行时（仅 LRU 淘汰路径会走到；正常使用永不调用）。
 *
 * 必须是**完整**销毁：漏掉任何一步都会留下一条 SSE 长连接、一棵游离的
 * xterm DOM 或一个还在跑的渲染器。
 * @param {string} sid 会话 id。
 * @returns {void}
 */
function destroyRuntime(sid) {
  const rt = runtimes.get(sid);
  if (rt === undefined) return;
  runtimes.delete(sid);
  rt.es?.close();
  rt.wrap.remove();
  rt.term.dispose();
}

/**
 * 取（或创建）某个 sid 的终端运行时。
 *
 * xterm 的 DOM 一旦 open() 就固定在自己的 wrapper 里，之后只由组件做
 * appendChild / remove，组件生命周期与它无关（设计 §2.5 L3）。命中已有
 * runtime 时刷新 `lastUsed`（LRU 依据），**绝不重建**——重建会丢掉滚动
 * 缓冲和续传游标。
 *
 * 唯一的销毁路径是 `evictRuntimes()`（超限 + 该 sid 没有开着的标签）。
 * 被淘汰的 sid 再次打开会走"新建 + `EventSource(since=0)` 全量回放"的
 * 兜底路径，屏幕能补回来。
 * @param {string} sid 会话 id。
 * @returns {object} 运行时。
 */
export function getRuntime(sid) {
  const existing = runtimes.get(sid);
  if (existing !== undefined) {
    existing.lastUsed = Date.now();
    return existing;
  }

  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%;height:100%';
  const term = new Terminal({
    theme: terminalTheme(),
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    convertEol: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(wrap);

  /** @type {object} */
  const rt = {
    sid,
    wrap,
    term,
    fit,
    /** 已应用到终端上的最大 seq（续传游标）。 */
    seq: 0,
    /** 卸载前是否有焦点，重挂载时还回来。 */
    hadFocus: false,
    /** @type {EventSource|null} */
    es: null,
    /** SSE 重连次数（退避用）。 */
    retry: 0,
    lastUsed: Date.now(),
  };
  runtimes.set(sid, rt);
  evictRuntimes();
  connectStream(rt);
  wireRuntime(rt);
  return rt;
}

/**
 * 当前保活的运行时数量（诊断 + 单测断言用）。
 * @returns {number} runtimes 表大小。
 */
export function runtimeCount() {
  return runtimes.size;
}

/**
 * 全部动作。组件只调这里，不直接碰 state。
 */
export const actions = {
  /**
   * 拉一次主机表 + 会话状态；首次加载时把 Host 侧已经开着的会话收养进标签条。
   * @returns {Promise<void>}
   */
  async loadHosts() {
    try {
      const payload = await actions._get('/hosts');
      const sessions = indexSessions(payload.sessions);
      const hosts = payload.hosts ?? [];
      // 只保留服务端确实还认识的会话：Host 重启或用户在别处关掉后，本地
      // 标签不该继续装作存在。`hosts[].sid` 也算"认识"——一次响应里
      // sessions 与 hosts 由同一快照生成，两边取并集可以避开字段缺失。
      const known = new Set(Object.keys(sessions));
      for (const host of hosts) {
        if (typeof host?.sid === 'string' && host.sid !== '') known.add(host.sid);
      }
      let tabs = state.tabs.filter((sid) => known.has(sid));
      // 首刷收养：config.autoOpenFirst 让 Host 侧先开了一个会话（设计 §2.3），
      // 客户端此时 tabs 还是空的，得把它变成第一个标签，否则用户看不到终端。
      if (tabs.length === 0) {
        const autoSid = hosts.find((host) => typeof host?.sid === 'string' && host.sid !== '')?.sid ?? null;
        if (autoSid !== null && known.has(autoSid)) tabs = [autoSid];
      }
      let activeSid = state.activeSid;
      if (activeSid === null || !known.has(activeSid)) activeSid = tabs[0] ?? null;
      setState({ hosts, sessions, tabs, activeSid });
    } catch {
      // 首刷失败：保留空表，左栏显示"加载中…"，下一轮轮询会纠正。
    }
  },

  /**
   * 轮询用：只更新状态，不改用户已选中的会话，也**不裁标签**。
   *
   * 不裁的理由是竞态：轮询请求可能在 `openSession` 之前发出、之后返回，
   * 若按它的 sessions 裁标签，刚开的标签会被上一帧快照误删。标签的回收
   * 只由 closeSession / deleteHost / loadHosts 三个显式路径负责。
   * @returns {Promise<void>}
   */
  async refreshHosts() {
    try {
      const payload = await actions._get('/hosts');
      const sessions = indexSessions(payload.sessions);
      setState({ hosts: payload.hosts ?? state.hosts, sessions });
    } catch {
      // 轮询失败保留上一次数据；下一轮轮询会纠正。
    }
  },

  /**
   * 开始轮询主机状态（view 挂载时调）。幂等。
   * @returns {void}
   */
  startPolling() {
    if (pollTimer !== null) return;
    const tick = async () => {
      if (pollTimer === null) return;
      await actions.refreshHosts();
      // stopPolling 可能发生在 await 期间。
      if (pollTimer !== null) pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    pollTimer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
  },

  /**
   * 停止轮询（view 卸载时调）。
   * @returns {void}
   */
  stopPolling() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  },

  /**
   * 视图销毁：启动台协议 `onTeardown` 的处理（关标签 / 启动台卸载都会调）。
   *
   * 不处理的后果很直接：Host 侧的 SSH 连接还活着（进程里挂着 socket），
   * 客户端这侧的 xterm + EventSource 也还挂着——关掉卡片只是看不见了。
   * 2026-10-25 协议新增 onTeardown，本插件此前未接。
   *
   * 顺序有讲究：协议要求 handler **同步返回**（关闭动画不能卡在网络上），
   * 所以本地状态与 runtime 先归零，关连接的 POST 逐个 fire-and-forget。
   * @param {string} reason 触发原因（`tab-closed` / `launcher-disposed`）。
   * @returns {void}
   */
  teardownAll(reason) {
    const sids = state.tabs.slice();
    // 同步：先停轮询（否则 teardown 后还在打 /hosts），再摘全部 runtime
    // （EventSource + xterm DOM + 渲染器，一个都不能留），最后状态归零。
    actions.stopPolling();
    for (const sid of sids) destroyRuntime(sid);
    setState({ tabs: [], activeSid: null, sessions: {}, chats: {} });
    // 异步：逐个通知 Host 关连接。失败无所谓——Host 侧进程退出时这些
    // 会话反正也没了，本地状态已经不再引用它们。
    for (const sid of sids) {
      void actions._request('POST', '/close', { sid }).catch(() => {});
    }
  },

  /**
   * 选中一个会话（左栏点击）。
   * @param {string|null} sid 会话 id。
   * @returns {void}
   */
  setActiveSid(sid) {
    setState({ activeSid: sid });
    if (sid !== null) void actions.postFocus(sid);
  },

  /**
   * 确保某个 sid 在标签条里（顺序追加到末尾），不改变激活项。
   *
   * 用途：模型侧 `ssh_open` 工具也能开会话，那些会话第一次出现在轮询结果里
   * 时客户端还没有标签；用户点一下左栏那一行，标签要跟着出现，否则"能看到
   * 终端但没有标签可关"。
   * @param {string|null} sid 会话 id。
   * @returns {void}
   */
  ensureTab(sid) {
    if (typeof sid !== 'string' || sid === '') return;
    if (state.tabs.includes(sid)) return;
    setState({ tabs: [...state.tabs, sid] });
  },

  /**
   * 当前激活标签所属的主机 id。
   * @returns {string|null} 主机 id；无激活会话时回落第一台主机，再没有就是 null。
   */
  activeHostId() {
    const sid = state.activeSid;
    if (sid !== null) {
      const session = state.sessions[sid];
      const fromSession = session?.host?.id;
      if (typeof fromSession === 'string' && fromSession !== '') return fromSession;
      const fromHost = state.hosts.find((host) => host.sid === sid)?.id;
      if (typeof fromHost === 'string' && fromHost !== '') return fromHost;
    }
    return state.hosts[0]?.id ?? null;
  },

  /**
   * 给一台主机开一个新标签（POST /open，一主机多会话，设计 §2.5）。
   *
   * 会话 id 由 Host 生成（sid 单调计数），客户端拿到就直接追加到标签条末尾
   * 并激活；重复 sid 不会产生第二个标签。
   * @param {string} hostId 主机 id。
   * @returns {Promise<string|null>} 新会话 sid；失败返回 null。
   */
  async openSession(hostId) {
    if (typeof hostId !== 'string' || hostId === '') {
      actions.showToast(t('noHostForTab'));
      return null;
    }
    try {
      const payload = await actions._request('POST', '/open', { hostId });
      const sid = typeof payload?.sid === 'string' && payload.sid !== '' ? payload.sid : null;
      if (sid === null) throw new Error('open returned no sid');
      const sessions = { ...state.sessions };
      if (payload?.session !== null && typeof payload?.session === 'object') sessions[sid] = payload.session;
      const tabs = state.tabs.includes(sid) ? state.tabs : [...state.tabs, sid];
      setState({ tabs, sessions, activeSid: sid });
      void actions.postFocus(sid);
      void actions.refreshHosts();
      return sid;
    } catch (error) {
      actions.showToast(describeError(error));
      return null;
    }
  },

  /**
   * 关掉一个标签（POST /close）。
   *
   * **刻意不 dispose runtime**：xterm 实例、滚动缓冲、SSE 续传游标全留在
   * `runtimes` 里（设计 §2.5 的 L2/L3），重新打开同一会话直接复用，屏幕
   * 还在原处。只有 LRU 淘汰路径才真销毁。
   * @param {string} sid 会话 id。
   * @returns {Promise<void>}
   */
  async closeSession(sid) {
    if (typeof sid !== 'string' || sid === '') return;
    try {
      await actions._request('POST', '/close', { sid });
    } catch {
      // Host 侧可能已经关掉了（进程退出 / 别的窗口操作）：本地照样摘标签，
      // 否则用户会看到一个永远关不掉的标签。
    }
    const index = state.tabs.indexOf(sid);
    const tabs = index === -1 ? state.tabs : state.tabs.filter((item) => item !== sid);
    let activeSid = state.activeSid;
    if (activeSid === sid) {
      // 优先右侧邻居，右侧没有就取左侧；`Math.min(index, len-1)` 同时覆盖空表。
      activeSid = tabs.length === 0 ? null : tabs[Math.min(Math.max(index, 0), tabs.length - 1)];
    }
    setState({ tabs, activeSid });
    void actions.refreshHosts();
  },

  /**
   * 标签条上的 `+`：给当前主机再开一个会话。
   * @returns {Promise<void>}
   */
  async openNewTab() {
    const hostId = actions.activeHostId();
    if (hostId === null) {
      actions.showToast(t('noHostForTab'));
      return;
    }
    await actions.openSession(hostId);
  },

  /**
   * 新增主机（POST /hosts，主机 id 由服务端生成，客户端不得指定）。
   * @param {object} values 表单值。
   * @returns {Promise<object|null>} 服务端返回的 HostView。
   */
  async createHost(values) {
    const payload = await actions._request('POST', '/hosts', toHostBody(values, true));
    await actions.refreshHosts();
    return payload?.host ?? null;
  },

  /**
   * 改主机（PATCH /hosts/<id>）。auth 里的秘密留空 = 不改密文。
   * @param {string} hostId 主机 id。
   * @param {object} values 表单值。
   * @param {boolean} [includeAuth] 是否携带 auth（缺省 true）。
   * @returns {Promise<object|null>} 服务端返回的 HostView。
   */
  async updateHost(hostId, values, includeAuth = true) {
    const payload = await actions._request(
      'PATCH',
      `/hosts/${encodeURIComponent(hostId)}`,
      toHostBody(values, includeAuth),
    );
    await actions.refreshHosts();
    return payload?.host ?? null;
  },

  /**
   * 删主机：**先关掉它的全部会话，再删主机**（设计 §2.4 的三步在 Host 侧
   * 完成，客户端这半步保证会话先停、否则 Host 会拒绝/留下孤儿 PTY）。
   * @param {string} hostId 主机 id。
   * @returns {Promise<boolean>} 是否成功。
   */
  async deleteHost(hostId) {
    if (typeof hostId !== 'string' || hostId === '') return false;
    // 1) 收集这台主机的全部会话：会话表里带 host.id 的都算，主机行上的 sid 兜底。
    const sids = new Set();
    for (const session of Object.values(state.sessions)) {
      if (session?.host?.id === hostId && typeof session.sid === 'string') sids.add(session.sid);
    }
    const rowSid = state.hosts.find((host) => host.id === hostId)?.sid;
    if (typeof rowSid === 'string' && rowSid !== '') sids.add(rowSid);

    // 2) 逐个 POST /close —— 顺序在 await 里，删主机一定排在它们之后。
    for (const sid of sids) {
      try {
        await actions._request('POST', '/close', { sid });
      } catch {
        // 会话可能已经是终态：关不掉不该阻塞删除。
      }
    }

    // 3) 再删主机。
    try {
      await actions._request('DELETE', `/hosts/${encodeURIComponent(hostId)}`);
    } catch (error) {
      actions.showToast(describeError(error));
      return false;
    }

    // 4) 本地收尾：摘掉这些 sid 的标签（runtime 仍保活，等 LRU 处理）。
    const tabs = state.tabs.filter((sid) => !sids.has(sid));
    const activeSid =
      state.activeSid !== null && sids.has(state.activeSid) ? (tabs[0] ?? null) : state.activeSid;
    setState({ tabs, activeSid });
    await actions.refreshHosts();
    actions.showToast(t('hostDeleted'));
    return true;
  },

  /**
   * 打开主机表单弹层。
   * @param {'create'|'edit'} [mode] 模式。
   * @param {object|null} [host] 编辑时的 HostView。
   * @returns {void}
   */
  openForm(mode = 'create', host = null) {
    const editing = mode === 'edit' && host !== null && typeof host === 'object';
    // 服务端给的是规范值（pass/key/none）；万一拿到旧值或空值，兜底到 pass，
    // 否则编辑一台私钥主机会错误地显示密码框。
    const authKind = editing && AUTH_KINDS.includes(host.authKind) ? host.authKind : DEFAULT_AUTH_KIND;
    setState({
      form: {
        mode: editing ? 'edit' : 'create',
        hostId: editing ? host.id : null,
        /** 打开表单时的认证方式：用于判断"认证方式变了没有"。 */
        originalAuthKind: editing ? authKind : null,
        values: {
          label: editing ? String(host.label ?? '') : '',
          host: editing ? String(host.host ?? '') : '',
          port: editing ? String(host.port ?? 22) : '22',
          username: editing ? String(host.username ?? '') : '',
          authKind,
          // 秘密永远空：从不下发到客户端，没有可回填的东西。
          password: '',
          privateKey: '',
        },
        error: null,
        busy: false,
      },
    });
  },

  /**
   * 关掉主机表单弹层（丢弃未保存的输入）。
   * @returns {void}
   */
  closeForm() {
    setState({ form: null });
  },

  /**
   * 改表单里的一个字段。
   * @param {string} name 字段名。
   * @param {string} value 新值。
   * @returns {void}
   */
  setFormField(name, value) {
    const form = state.form;
    if (form === null) return;
    setState({ form: { ...form, values: { ...form.values, [name]: value }, error: null } });
  },

  /**
   * 提交表单（新增 / 编辑）。成功后关弹层并刷新主机表。
   * @returns {Promise<boolean>} 是否成功。
   */
  async submitForm() {
    const form = state.form;
    if (form === null || form.busy) return false;
    setState({ form: { ...form, busy: true, error: null } });
    try {
      if (form.mode === 'edit' && form.hostId !== null) {
        await actions.updateHost(form.hostId, form.values, shouldSendAuth(form));
      } else {
        await actions.createHost(form.values);
      }
      setState({ form: null });
      actions.showToast(t('hostSaved'));
      return true;
    } catch (error) {
      // 弹层不关：用户改完还能再提交一次。
      setState({ form: { ...state.form, busy: false, error: describeError(error) } });
      return false;
    }
  },

  /**
   * 拉某个会话的上下文（M3 方案 A：右栏上下文卡的数据源）。
   *
   * Host 侧的 `/context` 是并行开发的，拿不到就记成 'unavailable'，UI 显示
   * 「暂无上下文」——绝不因为一个可选接口把右栏打崩。
   * @param {string|null} sid 会话 id。
   * @param {{force?: boolean}} [options] force=true 时忽略缓存。
   * @returns {Promise<void>}
   */
  async loadContext(sid, options = {}) {
    if (sid === null || sid === undefined || sid === '') return;
    const cached = state.contexts[sid];
    if (options.force !== true && cached !== undefined && cached.status === 'ready') return;
    setState({ contexts: { ...state.contexts, [sid]: { status: 'loading', data: cached?.data ?? null } } });
    try {
      const payload = await actions._get(`/context?sid=${encodeURIComponent(sid)}`);
      setState({ contexts: { ...state.contexts, [sid]: { status: 'ready', data: payload } } });
    } catch {
      setState({ contexts: { ...state.contexts, [sid]: { status: 'unavailable', data: null } } });
    }
  },

  /**
   * 强制刷新上下文卡（用户点「刷新」）。
   * @param {string|null} sid 会话 id。
   * @returns {Promise<void>}
   */
  async refreshContext(sid) {
    await actions.loadContext(sid, { force: true });
  },

  /**
   * 拉模型清单（右栏下拉 + "未配置模型"降级判断）。
   *
   * picked 的恢复顺序：localStorage 里的旧选择（仍在清单里才用）→ patch
   * 配置的默认（Host 下发）→ 第一个有模型的 provider 的第一个模型。
   * @returns {Promise<void>}
   */
  async loadLlm() {
    try {
      const data = await actions._get('/llm');
      if (data?.available !== true) {
        setState({ llm: { status: 'unavailable', providers: [], picked: { provider: '', model: '' } } });
        return;
      }
      const providers = Array.isArray(data.providers) ? data.providers : [];
      let picked = { provider: '', model: '' };
      try {
        const saved = JSON.parse(localStorage.getItem(LS_MODEL) ?? 'null');
        if (saved !== null && typeof saved === 'object') picked = { provider: String(saved.provider ?? ''), model: String(saved.model ?? '') };
      } catch {
        // localStorage 不可用/脏数据：按默认走。
      }
      const known = providers.find((row) => row.id === picked.provider);
      // 本地记住的选择若落在"已知不可用"的通道上（如未登录的 DeepSeek 官方
      // 通道）或**刚调用失败过**的通道上，视同无效——否则每次启动都被钉死在
      // 坏通道上（2026-10-24 真机）。
      const knownUsable = known !== undefined
        && known.unavailable === undefined
        && avoidProviders.includes(known.id) === false
        && (known.models ?? []).some((model) => model.id === picked.model);
      if (!knownUsable) {
        const configuredRaw = providers.find((row) => row.id === data.default?.provider);
        const configured = configuredRaw?.unavailable !== undefined || avoidProviders.includes(configuredRaw?.id ?? '')
          ? undefined
          : configuredRaw;
        const fromConfig = configured?.models?.find((model) => model.id === data.default?.model) ?? configured?.models?.[0] ?? null;
        picked = fromConfig !== null && configured !== undefined
          ? { provider: configured.id, model: fromConfig.id }
          : pickHealthy(providers, avoidProviders);
      }
      setState({ llm: { status: 'ready', providers, picked } });
    } catch {
      setState({ llm: { status: 'unavailable', providers: [], picked: { provider: '', model: '' } } });
    }
  },

  /**
   * 切换模型（右栏下拉）。选择持久化到 localStorage。
   * @param {string} provider provider id。
   * @param {string} model model id。
   * @returns {void}
   */
  setChatModel(provider, model) {
    // 用户手动选的通道就是"我愿意再试"：把它从回避表里放出来。
    forgetAvoid(provider);
    setState({ llm: { ...state.llm, picked: { provider, model } } });
    try {
      localStorage.setItem(LS_MODEL, JSON.stringify({ provider, model }));
    } catch {
      // 隐私模式下 localStorage 会抛：不影响当次选择。
    }
  },

  /**
   * 设置授权档位（auto | danger | always）。持久化到 localStorage。
   * @param {string} approval 档位。
   * @returns {void}
   */
  setApproval(approval) {
    if (APPROVALS.includes(approval) === false) return;
    setState({ chatApproval: approval });
    try {
      localStorage.setItem(LS_APPROVAL, approval);
    } catch {
      // 忽略：当场生效，重启后回默认。
    }
  },

  /**
   * 从 localStorage 恢复授权档位（view 挂载时调一次）。
   *
   * 迁移：老版本存的是布尔开关 `dsh-ssh:chatAutoExec`（'1' = 全自动），
   * 读到就换算成 auto/always，然后清掉旧键，别让两套偏好并存。
   * @returns {void}
   */
  restoreChatPrefs() {
    try {
      const saved = localStorage.getItem(LS_APPROVAL);
      if (saved !== null && APPROVALS.includes(saved)) {
        setState({ chatApproval: saved });
        return;
      }
      const legacy = localStorage.getItem(LS_AUTO_EXEC_LEGACY);
      if (legacy !== null) {
        setState({ chatApproval: legacy === '1' ? 'auto' : 'always' });
        localStorage.removeItem(LS_AUTO_EXEC_LEGACY);
      }
    } catch {
      // 忽略。
    }
  },

  /**
   * 发一条大白话（当前会话）。流式渲染由 runChatTurn 负责。
   * @param {string} text 用户输入。
   * @returns {Promise<void>}
   */
  async sendChat(text) {
    const sid = state.activeSid;
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (sid === null || trimmed === '') return;
    const chat = chatOf(sid);
    // pending 时不能发新消息：历史里会留下没有 tool 结果的 tool-call，
    // wire 校验必然拒绝，整轮白跑。先让用户把命令卡处理掉。
    if (chat.streaming === true || chat.pending === true) return;
    appendChatMessage(sid, { role: 'user', content: trimmed });
    await runChatTurn(sid);
  },

  /**
   * 人工确认模式下，用户对某条命令点"执行/跳过"。
   *
   * 执行走 `POST /chat/exec`（Host 侧 marker 捕获，与自动执行同一份实现）；
   * 跳过则回一条 isError 的 tool 结果，让模型知道"用户不跑"。
   * 一个回合里的命令全部有归属后，自动续跑对话。
   * @param {string} sid 会话 id。
   * @param {string} callId 工具调用 id。
   * @param {boolean} run true=执行，false=跳过。
   * @returns {Promise<void>}
   */
  async resolveToolCall(sid, callId, run) {
    const chat = chatOf(sid);
    if (chat.streaming === true) return;
    /** @type {object|null} */
    let target = null;
    for (const message of chat.messages) {
      if (message.kind !== 'turn') continue;
      const call = (message.calls ?? []).find((item) => item.id === callId);
      if (call !== undefined) { target = call; break; }
    }
    if (target === null || target.status !== 'awaiting') return;

    if (run !== true) {
      patchCall(sid, callId, {
        status: 'skipped',
        ok: null,
        resultContent: t('chatUserSkipped'),
        resultError: true,
      });
    } else {
      patchCall(sid, callId, { status: 'running' });
      try {
        const outcome = await actions._request('POST', '/chat/exec', {
          sid,
          command: target.command,
        });
        patchCall(sid, callId, {
          status: outcome?.ok === true ? 'done' : 'failed',
          ok: outcome?.ok === true,
          output: typeof outcome?.output === 'string' ? outcome.output : '',
          timedOut: outcome?.timedOut === true,
          resultContent: typeof outcome?.output === 'string' ? outcome.output : '',
          resultError: outcome?.ok !== true,
        });
      } catch (error) {
        patchCall(sid, callId, {
          status: 'failed',
          ok: false,
          output: describeError(error),
          resultContent: describeError(error),
          resultError: true,
        });
      }
    }

    // 全部命令都有归属后续跑，否则等用户把剩下的点完。
    const messages = chatOf(sid).messages;
    let pending = false;
    for (const message of messages) {
      if (message.kind !== 'turn') continue;
      for (const call of message.calls ?? []) {
        if (call.resultContent === undefined) pending = true;
      }
    }
    if (pending !== true) await runChatTurn(sid);
  },

  /**
   * 停止当前回合（中断 SSE；Host 侧 AbortSignal 会让模型轮收尾）。
   * @returns {void}
   */
  stopChat() {
    if (chatAbort !== null) chatAbort.abort();
  },

  /**
   * 折叠 / 展开左栏主机列表。
   * @returns {void}
   */
  toggleHosts() {
    setState({ hostsCollapsed: state.hostsCollapsed !== true });
  },

  /**
   * 单击主机：只选中高亮，不发起连接（连接走双击或「+ 标签」按钮）。
   * @param {string} hostId 主机 id。
   * @returns {void}
   */
  selectHost(hostId) {
    setState({ selectedHostId: hostId });
  },

  /**
   * 折叠 / 展开右栏。状态在模块级，view 卸载重挂后保持。
   * @returns {void}
   */
  toggleChat() {
    setState({ chatOpen: !state.chatOpen });
  },

  /**
   * 弹一个短 toast（M0 用于"+ 添加主机"的占位反馈）。
   * @param {string} text 文案。
   * @returns {void}
   */
  showToast(text) {
    if (toastTimer !== null) clearTimeout(toastTimer);
    setState({ toast: { text, at: Date.now() } });
    toastTimer = setTimeout(() => {
      toastTimer = null;
      setState({ toast: null });
    }, 2600);
  },

  /**
   * 写键盘字节。
   * @param {string} sid 会话 id。
   * @param {Uint8Array} bytes 原始字节。
   * @returns {Promise<void>}
   */
  async postInput(sid, bytes) {
    try {
      await actions._post('/input', { sid, data: bytesToBase64(bytes) });
    } catch {
      // 输入是尽力而为：网络抖动不该把按键变成未捕获的 Promise 异常。
    }
  },

  /**
   * 上报终端尺寸。
   * @param {string} sid 会话 id。
   * @param {number} cols 列数。
   * @param {number} rows 行数。
   * @returns {Promise<void>}
   */
  async postResize(sid, cols, rows) {
    try {
      await actions._post('/resize', { sid, cols, rows });
    } catch {
      // 尺寸上报失败：下次 fit 会再报一次。
    }
  },

  /**
   * 上报聚焦。
   * @param {string} sid 会话 id。
   * @returns {Promise<void>}
   */
  async postFocus(sid) {
    try {
      await actions._post('/focus', { sid });
    } catch {
      // 聚焦上报失败：模型侧工具会回落到 Host 记的 activeSid。
    }
  },

  /**
   * GET 一个端点并解析 JSON。
   * @param {string} path 端点路径。
   * @returns {Promise<object>} 响应体。
   */
  async _get(path) {
    const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
    return response.json();
  },

  /**
   * POST 一个 JSON 端点。
   * @param {string} path 端点路径。
   * @param {object} body 请求体。
   * @returns {Promise<void>}
   */
  async _post(path, body) {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`POST ${path} -> ${response.status}`);
  },

  /**
   * 通用请求：支持 GET/POST/PATCH/DELETE，失败时抛出带 `code`/`status` 的错误。
   *
   * 错误体是 `{error, code}`（设计 §4；M0 只有 `error`，所以 code 可能为
   * null）。带上 code 是为了让 UI 能按错误码给一句人话，而不是把英文
   * 服务端消息直接糊到用户脸上。
   * @param {string} method HTTP 方法。
   * @param {string} path 端点路径（含前导 /）。
   * @param {object} [body] 请求体；GET/DELETE 不传。
   * @returns {Promise<object>} 响应体（解析失败按空对象处理）。
   */
  async _request(method, path, body) {
    /** @type {object} */
    const init = { method, headers: { accept: 'application/json' } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${API}${path}`, init);
    let data = {};
    try {
      data = await response.json();
    } catch {
      // 204 / 空体：保持 {}。
      data = {};
    }
    if (!response.ok) {
      const message = typeof data?.error === 'string' ? data.error : `${method} ${path} -> ${response.status}`;
      const error = new Error(message);
      error.code = typeof data?.code === 'string' ? data.code : null;
      error.status = response.status;
      throw error;
    }
    return data ?? {};
  },
};
