/**
 * 对话历史的浏览器侧持久层（sessionStorage）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * Host 半是**无状态回合**（见 src/chat.js 头注释）：历史只活在客户端的
 * `state.chats` 里。于是只要客户端模块重新求值（插件热更新、页面刷新），
 * 对话就整段消失——而终端不会，因为它的字节流在 Host 的滚动缓冲里，重挂载
 * 会自动回放。2026-10-30 用户就撞上了这个不对称：AI 正在跑任务，热更新之后
 * 右侧会话没了，只剩终端还在。
 *
 * ── 为什么是 sessionStorage，不是 localStorage ───────────────────────────
 * - 需求只是"跨一次页面重载/热更新活下来"，不需要跨应用重启；
 * - 命令输出可能带敏感信息（env、日志、连接串），不该长期留在磁盘上；
 * - 每个标签页一份，不会出现两个窗口互相覆盖同一份历史。
 * 代价：关掉标签页就没了——这与"会话本身也没了"是一致的。
 *
 * ── 存什么、不存什么 ────────────────────────────────────────────────────
 * 只存视图模型的 `messages`。`streaming` / `pending` / `error` 这些瞬时态
 * 不存：重载后没有在途请求，存下来只会让 UI 永远转圈。`pending` 由
 * 「还有没有没归属的 tool-call」重新推导（与 resolveToolCall 同一判据）。
 */

/** 每个会话的键前缀（后面接 sid）。 */
export const CHAT_KEY_PREFIX = 'dsh-ssh:chat:';
/** 索引键：sid 列表，最近写的在前——用来做容量淘汰。 */
export const CHAT_INDEX_KEY = 'dsh-ssh:chat:index';
/** 每个会话最多存多少条消息（够看上下文，又不会把 quota 吃满）。 */
export const MAX_STORED_MESSAGES = 40;
/** 单会话序列化后的字符上限（UTF-16 长度近似；超了从最旧的开始丢）。 */
export const MAX_STORED_CHARS = 160 * 1024;
/** 最多同时保留几个会话的历史。 */
export const MAX_STORED_SESSIONS = 8;

/**
 * 读索引（坏的/缺失的一律当空表：这个索引只影响淘汰顺序，不该让恢复失败）。
 * @param {Storage|null} storage 存储句柄。
 * @returns {string[]} sid 列表，最近写的在前。
 */
function readIndex(storage) {
  if (storage === null) return [];
  try {
    const parsed = JSON.parse(storage.getItem(CHAT_INDEX_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string' && item !== '') : [];
  } catch {
    return [];
  }
}

/**
 * 写索引。
 * @param {Storage|null} storage 存储句柄。
 * @param {string[]} sids sid 列表。
 * @returns {void}
 */
function writeIndex(storage, sids) {
  if (storage === null) return;
  try {
    storage.setItem(CHAT_INDEX_KEY, JSON.stringify(sids));
  } catch {
    // quota 满：索引写不进去不影响本次会话，下一次 save 会再试。
  }
}

/**
 * 把消息裁到存储预算内：先按条数，再按字符数（都从最旧的丢）。
 * @param {object[]} messages 视图模型消息。
 * @returns {object[]} 裁好的消息。
 */
export function trimForStorage(messages) {
  const list = Array.isArray(messages) ? messages.slice(-MAX_STORED_MESSAGES) : [];
  let payload = JSON.stringify(list);
  while (payload.length > MAX_STORED_CHARS && list.length > 1) {
    list.shift();
    payload = JSON.stringify(list);
  }
  return list;
}

/**
 * 保存某个会话的对话历史。
 *
 * 空历史 = 删除（不写空数组，省得索引里堆一堆没内容的 sid）。
 * @param {Storage|null} storage 存储句柄。
 * @param {string} sid 会话 id。
 * @param {object[]} messages 视图模型消息。
 * @returns {void}
 */
export function saveChat(storage, sid, messages) {
  if (storage === null || typeof sid !== 'string' || sid === '') return;
  const trimmed = trimForStorage(messages);
  if (trimmed.length === 0) {
    dropChat(storage, sid);
    return;
  }
  try {
    storage.setItem(CHAT_KEY_PREFIX + sid, JSON.stringify(trimmed));
  } catch {
    // quota 满：先淘汰最旧的一半再试一次，还不行就放弃（不能把右栏打崩）。
    const index = readIndex(storage);
    const kept = index.slice(0, Math.max(1, Math.floor(MAX_STORED_SESSIONS / 2)));
    for (const old of index.slice(kept.length)) {
      try {
        storage.removeItem(CHAT_KEY_PREFIX + old);
      } catch {
        // 忽略。
      }
    }
    writeIndex(storage, kept);
    try {
      storage.setItem(CHAT_KEY_PREFIX + sid, JSON.stringify(trimmed));
    } catch {
      return;
    }
  }
  const index = readIndex(storage).filter((item) => item !== sid);
  index.unshift(sid);
  writeIndex(storage, index.slice(0, MAX_STORED_SESSIONS));
}

/**
 * 删除某个会话的历史（关会话 / 删主机时调，避免存储里堆孤儿）。
 * @param {Storage|null} storage 存储句柄。
 * @param {string} sid 会话 id。
 * @returns {void}
 */
export function dropChat(storage, sid) {
  if (storage === null || typeof sid !== 'string' || sid === '') return;
  try {
    storage.removeItem(CHAT_KEY_PREFIX + sid);
  } catch {
    // 忽略。
  }
  writeIndex(storage, readIndex(storage).filter((item) => item !== sid));
}

/**
 * 把存下来的消息恢复成视图模型。
 *
 * 三件必须做的事：
 * 1. **封口**：重载时正在流式的那条 assistant 回合不会再有人往里写，标
 *    `interrupted` 让 UI 说明"被中断"，并清掉 `streaming`（否则永远转圈）；
 * 2. **补 tool 结果**：重载前状态是 `running` 的命令，结果永远回不来了。
 *    标成 failed + 一条"结果未知"的 tool 结果——既诚实，又保证
 *    buildChatHistory 产出的 history 合法（有 tool-call 就必须有 tool 结果，
 *    否则下一轮请求会被 wire 校验打回）；
 * 3. **重推 pending**：还有 `awaiting` 的卡片就回到"等用户点执行"的状态。
 *    判据是**卡片状态**而不是"有没有 tool 结果"——自动执行的命令历史上
 *    不写 resultContent，用"缺结果"判断会让恢复出来的对话一进来就锁死
 *    输入框（与 store.hasOpenCall 保持同一条规则）。
 * @param {object[]} messages 存下来的消息。
 * @param {{interruptedResult?: string}} [options] interruptedResult 是补进
 *   history 的那句"结果未知"文案（由调用方给，保持本模块无本地化依赖）。
 * @returns {{messages: object[], pending: boolean, interrupted: boolean}} 恢复后的状态。
 */
export function restoreChatState(messages, options = {}) {
  const interruptedResult = typeof options.interruptedResult === 'string' ? options.interruptedResult : '';
  const list = Array.isArray(messages) ? messages : [];
  const restored = [];
  let pending = false;
  let interrupted = false;
  list.forEach((message, index) => {
    if (message === null || typeof message !== 'object') return;
    if (message.role === 'user') {
      restored.push({ role: 'user', content: String(message.content ?? '') });
      return;
    }
    if (message.kind !== 'turn') return;
    const wasStreaming = message.streaming === true;
    const calls = [];
    for (const call of Array.isArray(message.calls) ? message.calls : []) {
      if (call === null || typeof call !== 'object') continue;
      if (call.status === 'running' && call.resultContent === undefined) {
        calls.push({
          ...call,
          status: 'failed',
          ok: false,
          resultContent: interruptedResult,
          resultError: true,
        });
        continue;
      }
      // 已经落终态却没有结果的卡片（旧版本里自动执行的那批命令就是这样）：
      // 用它的预览输出补上。不补的话，下次发消息时 history 里会有一条
      // tool-call 没有对应的 tool 结果，请求会被 wire 校验打回。
      if (call.resultContent === undefined && (call.status === 'done' || call.status === 'failed' || call.status === 'skipped')) {
        calls.push({
          ...call,
          resultContent: typeof call.output === 'string' ? call.output : '',
          resultError: call.status !== 'done',
        });
        continue;
      }
      calls.push({ ...call });
      // 判据与 store.hasOpenCall 一致：看卡片状态，不看"有没有结果"。
      if (call.status === 'awaiting') pending = true;
    }
    // 只有最后一条可能是 streaming：中间那些在 round 边界就被封口了。
    const last = index === list.length - 1;
    if (wasStreaming && last) interrupted = true;
    restored.push({
      ...message,
      streaming: false,
      calls,
      ...(wasStreaming && last ? { interrupted: true } : {}),
    });
  });
  return { messages: restored, pending, interrupted };
}

/**
 * 恢复所有会话的历史。
 *
 * 只认索引里列出的 sid：索引是唯一真相源，避免读到手工塞进去的野键。
 * @param {Storage|null} storage 存储句柄。
 * @param {{interruptedResult?: string}} [options] 透传给 restoreChatState。
 * @returns {Record<string, object>} sid -> 对话状态。
 */
export function loadAllChats(storage, options = {}) {
  /** @type {Record<string, object>} */
  const chats = {};
  if (storage === null) return chats;
  for (const sid of readIndex(storage)) {
    let raw;
    try {
      raw = storage.getItem(CHAT_KEY_PREFIX + sid);
    } catch {
      continue;
    }
    if (raw === null) continue;
    let messages;
    try {
      messages = JSON.parse(raw);
    } catch {
      continue;
    }
    const state = restoreChatState(messages, options);
    if (state.messages.length === 0) continue;
    chats[sid] = {
      messages: state.messages,
      streaming: false,
      pending: state.pending,
      slow: false,
      retrying: null,
      error: null,
    };
  }
  return chats;
}
