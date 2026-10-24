/**
 * 对话服务：右栏 AI 助手（自然语言 → 读面板 → 生成命令 → 执行）。
 *
 * ── 与 dsh 的集成方式 ────────────────────────────────────────────────────
 * 只经 `ctx.get('llm')`（cordis 服务名 `llm`，LlmRuntime）调用宿主模型能力，
 * **不 import 任何 @deepseek-ai/* 包**（与 src/tools.js 同一条纪律：第三方
 * 插件 import 宿主内部包会带来第二份副本与版本漂移）。已核实的调用契约：
 * - `llm.listProviders()` → `[{id, name}]`（translator 插件用法）；
 * - `llm.listModels(provider)` → `[{id, ...}]`；
 * - `llm.prepareCall({provider, model, ...})` → `{config, stream(options)}`，
 *   stream **只能分发一次**，每轮对话要重新 prepareCall；
 * - `stream(options)` 的 options 必须与 prepareCall 的 config 同参
 *   （callConfigEquals 校验），即 `{provider, model, messages, system, tools, signal}`；
 * - 消息块运行时形状（按真实 adapter 的 wire 映射核实，dsh-our-free-model
 *   src/messages.js）：文本 `{type:'text', text}`；assistant 的工具调用
 *   `{type:'tool-call', id, name, arguments}`（arguments 是 JSON 字符串）；
 *   工具结果消息 `{role:'tool', toolCallId, content: string|blocks, isError}`。
 *   `id`/`source` 只是 Session 日志字段，adapter 不读——手搓消息不需要它们。
 *
 * ── 无状态回合 + 可恢复循环 ─────────────────────────────────────────────
 * Host 不存对话历史：客户端每轮 POST 完整 messages，Host 跑"模型轮"直到
 * 文本收尾或工具调用。autoExecute=false（默认）时遇到工具调用就流式吐给
 * 客户端、以 finish{reason:'tool-call'} 结束；用户点"执行"后客户端把
 * `{role:'tool', toolCallId, content}` 追加进 history 再 POST，循环继续。
 * autoExecute=true 时 Host 当场执行并续跑，直到文本收尾或 maxToolRounds。
 *
 * ── 安全边界 ────────────────────────────────────────────────────────────
 * - 命令只在用户已建好的 SSH 会话 PTY 里跑，不新开连接、不碰 vault；
 * - 默认人工确认执行；自动执行是显式开关，且只对当前会话有效；
 * - 执行有超时（默认 30s，超时发 Ctrl+C 并返回部分输出）；
 * - 输出喂给模型前做 ANSI 清洗 + 截断，system prompt 不含任何秘密。
 */
import { randomBytes } from 'node:crypto';

/** 喂给模型的输出最大字符数（超出截断尾部并标注）。 */
const MAX_OUTPUT_CHARS = 6000;
/** 工具结果回给客户端做预览的最大字符数。 */
const MAX_PREVIEW_CHARS = 1200;
/** 单轮请求里最大的"模型轮"数（含工具续跑），防无限循环。 */
const MAX_TOOL_ROUNDS = 6;
/** 默认命令超时（毫秒）与硬上限。 */
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
/** 交互式命令超时后先发 Ctrl+C，再等这么久收尾。 */
const ABORT_GRACE_MS = 400;
/** 终端尾部进 system prompt 的默认行数。 */
const DEFAULT_CONTEXT_LINES = 60;
/** history 长度上限（条），超出丢最旧的（system 由 Host 每轮重建，不占位）。 */
const MAX_HISTORY = 30;

/** 聊天用的工具定义（裸 JSON Schema，与 tools.js 同一套约束）。 */
const CHAT_TOOLS = Object.freeze([
  {
    name: 'run_command',
    description:
      '在用户当前聚焦的 SSH 会话里执行一条 shell 命令并返回捕获的输出。' +
      '适用于查看状态、排查问题、执行运维操作。命令必须是单次非交互命令；' +
      '交互式程序（vim/top/less）会超时，不要调用。',
    parameters: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        command: Object.freeze({
          type: 'string',
          description: '要执行的 shell 命令（单行；需要管道/重定向直接写）',
        }),
        timeout_seconds: Object.freeze({
          type: 'integer',
          description: '超时秒数，默认 30，最大 120',
          default: 30,
        }),
      }),
      required: Object.freeze(['command']),
      additionalProperties: false,
    }),
  },
]);

/**
 * 造一个带错误码的 Error。
 * @param {string} code 错误码。
 * @param {string} message 原因（不含秘密）。
 * @returns {Error} 带 code 的 Error。
 */
function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 去掉 ANSI/VT 转义序列，只留可读文本。
 *
 * 覆盖 CSI（颜色/光标）、OSC（标题，含 BEL 或 ST 结尾）、以及杂项单字符
 * 转义。不清洗的话模型看到的是 `\x1b[32m` 噪声，token 白烧。
 * @param {string} text 原始文本。
 * @returns {string} 清洗后的文本。
 */
export function stripAnsi(text) {
  return String(text ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC ... BEL / ESC \
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[@-Z\\-_]/g, '') // 单字符转义（含 ESC \ 结尾残留）
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // 其余控制字符（保留 \t \n \r）
}

/**
 * 截断文本：保留尾部（命令输出通常结论在最后），标注省略量。
 * @param {string} text 原文。
 * @param {number} maxChars 上限。
 * @returns {string} 截断后文本。
 */
function truncateTail(text, maxChars) {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `[…省略前 ${omitted} 字符…]\n${text.slice(-maxChars)}`;
}

/**
 * 把任意 history 消息归一成 adapter 认识的形状。
 *
 * 客户端发来的消息：`{role, content}`，content 是 string 或块数组；assistant
 * 可能带 `{type:'tool-call', id, name, arguments}` 块；工具结果是
 * `{role:'tool', toolCallId, content, isError}`。Host 只做形状补齐，
 * 不改写语义。
 *
 * `system` 角色一律丢弃：system prompt 由 Host 每轮现场重建（含最新终端
 * 尾部），客户端发来的 system 只会造成重复甚至过期信息。
 *
 * assistant 消息必须补 `source`：真 runtime 的 `forAdapter()` 会读
 * `message.source.replayState`，缺 source 直接 TypeError，被包装成终态
 * finish——表现为"模型一声不响就结束了"（2026-10-24 真机 E2E 实测）。
 * `replayState` 缺席时该字段是直通，provider/model 取值不影响分发。
 * @param {unknown[]} history 客户端 history。
 * @param {{provider?: string, model?: string}} [source] assistant 消息的来源标注。
 * @returns {object[]} 归一后的消息数组（全新对象）。
 */
export function normalizeHistory(history, source = {}) {
  if (!Array.isArray(history)) return [];
  const origin = { kind: 'model', provider: String(source.provider ?? ''), model: String(source.model ?? '') };
  /** @type {object[]} */
  const out = [];
  for (const raw of history) {
    if (raw === null || typeof raw !== 'object') continue;
    const role = raw.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    if (role === 'tool') {
      const toolCallId = typeof raw.toolCallId === 'string' ? raw.toolCallId : '';
      if (toolCallId === '') continue; // 没有 callId 的工具结果只会让 wire 校验失败
      out.push({
        role: 'tool',
        toolCallId,
        content: normalizeContent(raw.content),
        isError: raw.isError === true,
      });
      continue;
    }
    if (role === 'assistant') {
      // 只有 assistant 需要 source：真 runtime 的 forAdapter 只读 assistant 的
      // source.replayState，user/tool 消息的 source 没有消费者。
      out.push({ role, content: normalizeContent(raw.content), source: origin });
      continue;
    }
    out.push({ role, content: normalizeContent(raw.content) });
  }
  // 超长就丢最旧的：system 每轮由 Host 重建，不在 history 里。
  return out.slice(-MAX_HISTORY);
}

/**
 * 归一 content：string 原样；数组只保留 text/tool-call 块。
 * @param {unknown} content 原始 content。
 * @returns {string|object[]} 归一后的 content。
 */
function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  /** @type {object[]} */
  const blocks = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (
      block.type === 'tool-call' &&
      typeof block.name === 'string' &&
      typeof block.arguments === 'string'
    ) {
      blocks.push({
        type: 'tool-call',
        id: String(block.id ?? ''),
        name: block.name,
        arguments: block.arguments,
      });
    }
  }
  return blocks.length === 0 ? '' : blocks;
}

/**
 * 组装 system prompt：静态人设 + 当前环境 + 终端尾部。
 * @param {object} params 参数。
 * @param {object} params.session 会话记录（内部形态）。
 * @param {string} params.tail 终端尾部文本（已 ANSI 清洗）。
 * @param {boolean} params.autoExecute 是否自动执行（影响措辞）。
 * @returns {string} system prompt。
 */
function buildSystemPrompt({ session, tail, autoExecute }) {
  const host = session.host ?? {};
  const lines = [
    '你是 dsh-ssh 内置的 SSH 运维助手，运行在用户的远程终端面板旁。',
    '你可以通过 run_command 工具在用户当前的 SSH 会话里执行命令，输出会回传给你。',
    '',
    '当前环境：',
    `- 主机: ${String(host.label ?? '')} (${String(host.host ?? '')}:${String(host.port ?? 22)})`,
    `- 用户: ${String(host.username ?? '')}`,
    `- 会话状态: ${String(session.status ?? 'unknown')}，终端 ${session.cols ?? '?'}x${session.rows ?? '?'}`,
    '',
    '工作准则：',
    '1. 先用一两条只读命令确认现状，再给结论；不要臆测输出。',
    '2. 破坏性操作（删除、重启服务、改配置）必须先说明影响，等用户确认。',
    '3. 回复用简体中文，命令用 markdown 代码块；结论先行，步骤从简。',
    '4. 命令要非交互、单行；需要交互的用非交互替代写法。',
    autoExecute
      ? '5. 当前是自动执行模式：你调用的 run_command 会被立即执行，请对每条命令有把握。'
      : '5. 当前是人工确认模式：你提出的命令会展示给用户，由用户决定是否执行。',
    '',
    '终端最后几十行输出（可能不完整，以命令实测为准）：',
    '```',
    tail === '' ? '(暂无输出)' : tail,
    '```',
  ];
  return lines.join('\n');
}

/**
 * 从 stream chunk 流里攒一个回合的结果。
 *
 * 文本增量立刻经 onEvent 吐出去（SSE 流式）；工具调用块在 block-end 时
 * 成块收齐（arguments 是完整 JSON 字符串）。
 * @param {AsyncIterable<object>} chunks llm stream。
 * @param {(event: object) => void} onEvent 事件回调。
 * @returns {Promise<{text: string, toolCalls: object[], finishReason: string}>} 回合结果。
 */
async function consumeStream(chunks, onEvent) {
  let text = '';
  /** @type {Map<number, {id: string, name: string, args: string}>} */
  const pending = new Map();
  /** @type {object[]} */
  const toolCalls = [];
  let finishReason = 'stop';
  for await (const chunk of chunks ?? []) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      onEvent({ type: 'text', text: chunk.text });
      continue;
    }
    if (chunk.type === 'tool-call-delta') {
      const slot = pending.get(chunk.index) ?? { id: '', name: '', args: '' };
      if (typeof chunk.id === 'string' && chunk.id !== '') slot.id = chunk.id;
      if (typeof chunk.name === 'string' && chunk.name !== '') slot.name = chunk.name;
      if (typeof chunk.argumentsDelta === 'string') slot.args += chunk.argumentsDelta;
      pending.set(chunk.index, slot);
      continue;
    }
    if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
      const call = {
        id: String(chunk.block.id ?? ''),
        name: String(chunk.block.name ?? ''),
        arguments: typeof chunk.block.arguments === 'string' ? chunk.block.arguments : '{}',
      };
      if (call.id !== '' && call.name !== '') toolCalls.push(call);
      continue;
    }
    if (chunk.type === 'finish' && typeof chunk.reason === 'string') {
      finishReason = chunk.reason;
    }
  }
  // delta 攒了但没等到 block-end 的（异常截断）：能救一个是一个。
  for (const slot of pending.values()) {
    if (slot.name !== '' && !toolCalls.some((call) => call.id === slot.id && slot.id !== '')) {
      toolCalls.push({ id: slot.id || `call-${randomBytes(6).toString('hex')}`, name: slot.name, arguments: slot.args || '{}' });
    }
  }
  return { text, toolCalls, finishReason };
}

/**
 * 解析工具入参：容错 JSON，缺字段给默认。
 * @param {string} raw arguments JSON 字符串。
 * @returns {{command: string, timeoutMs: number}} 解析结果。
 */
function parseToolArgs(raw) {
  /** @type {object} */
  let args = {};
  try {
    const parsed = JSON.parse(typeof raw === 'string' && raw !== '' ? raw : '{}');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
  } catch {
    // 模型吐了非法 JSON：按空参数走，command 缺失会得到明确报错。
  }
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  const rawTimeout = Number.parseInt(String(args.timeout_seconds ?? ''), 10);
  const seconds = Number.isInteger(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, MAX_TIMEOUT_MS / 1000) : DEFAULT_TIMEOUT_MS / 1000;
  return { command, timeoutMs: seconds * 1000 };
}

/**
 * 在会话 PTY 里执行一条命令并捕获输出。
 *
 * 捕获原理（marker 回显）：
 *   1. 先 `service.subscribe` 挂监听，再发送 `<command>\n`；
 *   2. 紧接着发送 `printf '%s %s\n' '<marker>' "$?"\n`——PTY 输入是行缓冲
 *      队列，shell 只有在命令跑完后才会读到这一行，所以 marker 行天然是
 *      "命令输出结束"的分界线（命令若自己读 stdin 会把 marker 行吃掉，
 *       此时只能等超时，属已知限制）；
 *   3. 监听里把字节拼成文本，找到 `^<marker> (\d+)$` 行即完成，`$?` 就
 *      是退出码；
 *   4. 超时：发 `\x03`（Ctrl+C），宽限 400ms 后带着部分输出返回。
 *
 * 输出在送给模型前已 stripAnsi；回给客户端另有一份截断预览。
 * @param {object} params 参数。
 * @param {object} params.service SshSessionService。
 * @param {string} params.sid 会话 id。
 * @param {string} params.command 命令。
 * @param {number} params.timeoutMs 超时。
 * @returns {Promise<{ok: boolean, timedOut: boolean, output: string, preview: string}>} 执行结果。
 */
export async function executeInSession({ service, sid, command, timeoutMs }) {
  const session = service.get(sid); // 不存在会抛 SessionNotFoundError
  if (session.status === 'closed' || session.status === 'error') {
    throw codedError('unknown-session', `session ${sid} is ${session.status}; reconnect first`);
  }
  const marker = `__DSH_${randomBytes(8).toString('hex')}__`;
  /** @type {string[]} */
  const parts = [];
  let done = false;
  let exitCode = null;
  let timedOut = false;

  const unsubscribe = service.subscribe(sid, (event) => {
    if (event?.kind !== 'data' || done) return;
    // 与 store.js 同一纪律：分片拼完再一次性解码，避免多字节 UTF-8 被劈。
    parts.push(Buffer.from(event.data, 'base64').toString('utf8'));
    const joined = parts.join('');
    // marker 行匹配：只要求"marker + 空格 + 退出码 + 行尾空白到文本末尾"。
    // **不能**要求前面是 \n——真终端的 marker 行前往往是 \r（bracketed
    // paste 的 \e[?2004l\r 包装、\r\n 行尾），要求 \n 会永远匹配不上，
    // 表现为"输出全有了却超时"（2026-10-24 真机 E2E 实测的坑）。
    const match = joined.match(new RegExp(`${marker} (\\d+)\\s*$`));
    if (match !== null) {
      exitCode = Number.parseInt(match[1], 10);
      done = true;
    }
  });

  const finish = () => {
    unsubscribe();
    const raw = parts.join('');
    // marker 行本身不属于命令输出：从 marker 最后一次出现处截断（比正则
    // 替换稳——行尾可能是 \r\n 也可能是裸 \r）。
    const cut = raw.lastIndexOf(marker);
    const cleaned = cut === -1 ? raw : raw.slice(0, cut);
    const output = truncateTail(stripAnsi(cleaned).trim(), MAX_OUTPUT_CHARS);
    const preview = truncateTail(stripAnsi(cleaned).trim(), MAX_PREVIEW_CHARS);
    return { ok: exitCode === 0 && !timedOut, timedOut, output, preview };
  };

  try {
    service.send(sid, `${command}\n`);
    service.send(sid, `printf '%s %s\\n' '${marker}' "$?"\n`);
  } catch (error) {
    unsubscribe();
    throw codedError('unknown-session', `session ${sid} cannot accept input: ${error.message}`);
  }

  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS);
  while (!done && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  if (!done) {
    // 交互式命令/长任务：Ctrl+C 打断，给 shell 一点时间吐 marker。
    timedOut = true;
    try {
      service.send(sid, '\x03');
    } catch {
      // 会话可能已经断了：忽略，走部分输出返回。
    }
    const grace = Date.now() + ABORT_GRACE_MS;
    while (!done && Date.now() < grace) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  return finish();
}

/**
 * 造对话服务。
 * @param {object} options 参数。
 * @param {object} options.service SshSessionService（会话 + 终端缓冲）。
 * @param {object|null} [options.llm] cordis `llm` 服务（LlmRuntime）；缺失时对话不可用。
 * @param {object} [options.config] patch config 里的 `chat` 段。
 * @param {(message: string) => void} [options.logger] 日志函数。
 * @returns {object} 对话服务。
 */
export function createChatService(options = {}) {
  const service = options.service;
  if (service === undefined || service === null) {
    throw new TypeError('dsh-ssh chat: service is required');
  }
  const llm = options.llm ?? null;
  const config = options.config ?? {};
  const logger = typeof options.logger === 'function' ? options.logger : () => {};
  const contextLines = Number.isInteger(config.maxContextLines) && config.maxContextLines > 0 ? config.maxContextLines : DEFAULT_CONTEXT_LINES;
  const defaultProvider = typeof config.provider === 'string' && config.provider !== '' ? config.provider : '';
  const defaultModel = typeof config.model === 'string' && config.model !== '' ? config.model : '';

  /**
   * 模型可用性 + 可选清单（UI 下拉用）。
   * @returns {Promise<object>} `{available, providers: [{id, name, models: [{id, label}]}], default: {provider, model}, reason?}`。
   */
  const describeModels = async () => {
    if (llm === null || typeof llm.listProviders !== 'function') {
      return { available: false, providers: [], default: { provider: '', model: '' }, reason: 'llm-unavailable' };
    }
    /** @type {object[]} */
    const providers = [];
    try {
      const rows = llm.listProviders() ?? [];
      for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id : '';
        if (id === '') continue;
        /** @type {object[]} */
        let models = [];
        if (typeof llm.listModels === 'function') {
          const list = (await llm.listModels(id)) ?? [];
          models = list
            .map((model) => ({
              id: String(model?.id ?? model?.model ?? ''),
              label: String(model?.label ?? model?.name ?? model?.id ?? ''),
            }))
            .filter((model) => model.id !== '');
        }
        providers.push({ id, name: String(row?.name ?? id), models });
      }
    } catch (error) {
      logger(`chat: list providers failed: ${error?.message ?? error}`);
      return { available: false, providers: [], default: { provider: '', model: '' }, reason: 'llm-error' };
    }
    if (providers.length === 0) {
      return { available: false, providers: [], default: { provider: '', model: '' }, reason: 'no-provider' };
    }
    return { available: true, providers, default: { provider: defaultProvider, model: defaultModel } };
  };

  /**
   * 选一个可用的 provider/model：请求指定 > patch 配置 > 第一个有模型的 provider。
   * @param {string} wantedProvider 请求里的 provider。
   * @param {string} wantedModel 请求里的 model。
   * @param {object[]} providers describeModels 的 providers。
   * @returns {{provider: string, model: string}|null} 选择结果；无可用返回 null。
   */
  const pickModel = (wantedProvider, wantedModel, providers) => {
    const byId = (id) => providers.find((row) => row.id === id) ?? null;
    const wanted = byId(wantedProvider);
    if (wanted !== null) {
      const model = wanted.models.find((row) => row.id === wantedModel) ?? wanted.models[0] ?? null;
      if (model !== null) return { provider: wanted.id, model: model.id };
    }
    const configured = byId(defaultProvider);
    if (configured !== null) {
      const model = configured.models.find((row) => row.id === defaultModel) ?? configured.models[0] ?? null;
      if (model !== null) return { provider: configured.id, model: model.id };
    }
    for (const row of providers) {
      const model = row.models[0] ?? null;
      if (model !== null) return { provider: row.id, model: model.id };
    }
    return null;
  };

  /**
   * 跑一个"用户回合"：模型轮循环，事件经 onEvent 流式吐出。
   *
   * 结束条件：模型给出纯文本收尾（finish{reason:'stop'}）；或 autoExecute=false
   * 时出现工具调用（finish{reason:'tool-call'}，等客户端回传结果再续）；
   * 或超过 maxToolRounds / 模型报错。
   * @param {object} params 参数。
   * @param {string} params.sid 会话 id。
   * @param {object[]} params.messages 客户端 history（已含最新 user 消息）。
   * @param {boolean} params.autoExecute 是否立即执行工具。
   * @param {string} [params.provider] 指定 provider。
   * @param {string} [params.model] 指定 model。
   * @param {AbortSignal} [params.signal] 取消信号。
   * @param {(event: object) => void} params.onEvent 事件回调。
   * @returns {Promise<void>} 完成即 resolve（错误也以事件形式发出，不抛）。
   */
  const runTurn = async ({ sid, messages, autoExecute, provider, model, signal, onEvent }) => {
    const emit = (event) => {
      try {
        onEvent(event);
      } catch {
        // 回调抛错不该中断对话流（SSE 连接断了会走 signal 路径）。
      }
    };
    try {
      service.get(sid); // 会话不存在：明确的 404 语义
      const inventory = await describeModels();
      if (inventory.available !== true) {
        emit({ type: 'error', code: 'llm-unavailable', message: '宿主没有可用的模型服务（llm），请在 dsh 里配置模型后重试' });
        return;
      }
      const picked = pickModel(typeof provider === 'string' ? provider : '', typeof model === 'string' ? model : '', inventory.providers);
      if (picked === null) {
        emit({ type: 'error', code: 'llm-no-model', message: '没有可用模型：宿主未注册任何 provider 或模型列表为空' });
        return;
      }
      emit({ type: 'model', provider: picked.provider, model: picked.model });

      const session = service.get(sid);
      const tail = stripAnsi(service.readText(sid, contextLines).text);
      const system = buildSystemPrompt({ session, tail, autoExecute: autoExecute === true });
      const history = normalizeHistory(messages, picked);
      if (history.length === 0) {
        emit({ type: 'error', code: 'empty-history', message: '对话历史为空' });
        return;
      }

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        if (signal?.aborted === true) {
          emit({ type: 'finish', reason: 'aborted' });
          return;
        }
        const prepared = await llm.prepareCall({ provider: picked.provider, model: picked.model });
        const result = await consumeStream(
          prepared.stream({
            // 必须把 prepareCall 返回的 config 原样带回：runtime 在这里做
            // callConfigEquals 校验（provider/model/reasoningEffort/
            // temperature/maxTokens/stop），adapter 物化出的默认值（如
            // GLM-5.3 的 reasoningEffort）不在入参里就抛
            // INVALID_PREPARED_CALL（2026-10-24 真机实测）。
            ...prepared.config,
            messages: history,
            system,
            tools: CHAT_TOOLS,
            signal,
          }),
          emit,
        );
        if (result.toolCalls.length === 0 || result.finishReason === 'error') {
          if (result.finishReason === 'error') {
            emit({ type: 'error', code: 'llm-error', message: '模型调用失败，请重试或切换模型' });
            return;
          }
          emit({ type: 'finish', reason: 'stop' });
          return;
        }
        // 只有 run_command 一个工具；别的名字按错误结果回给模型。
        /** assistant 消息的来源标注：真 runtime 的 forAdapter 要读 source。 */
        const modelSource = { kind: 'model', provider: picked.provider, model: picked.model };
        /** @type {object[]} */
        const assistantBlocks = [];
        if (result.text !== '') assistantBlocks.push({ type: 'text', text: result.text });
        for (const call of result.toolCalls) {
          assistantBlocks.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments });
        }
        history.push({ role: 'assistant', content: assistantBlocks, source: modelSource });

        /** 人工确认模式下，本批命令是否在等用户（全部吐完再暂停）。 */
        let paused = false;
        for (const call of result.toolCalls) {
          const args = parseToolArgs(call.arguments);
          if (call.name !== 'run_command' || args.command === '') {
            const message = call.name !== 'run_command'
              ? `unknown tool: ${call.name}`
              : 'run_command 缺少 command 参数';
            history.push({ role: 'tool', toolCallId: call.id, content: message, isError: true });
            emit({ type: 'tool-result', id: call.id, ok: false, output: message });
            continue;
          }
          emit({ type: 'tool-call', id: call.id, name: call.name, command: args.command, arguments: call.arguments });
          if (autoExecute !== true) {
            // 人工确认：本批全部命令先展示给用户，回合到此暂停；客户端逐条
            // 执行/跳过后带 tool 结果再次 POST，循环从下一轮继续。
            paused = true;
            continue;
          }
          const outcome = await executeInSession({ service, sid, command: args.command, timeoutMs: args.timeoutMs });
          const content = outcome.timedOut === true
            ? `${outcome.output}\n[超时：命令未在限定时间内结束，已发送 Ctrl+C]`
            : outcome.output;
          history.push({ role: 'tool', toolCallId: call.id, content, isError: !outcome.ok });
          emit({ type: 'tool-result', id: call.id, ok: outcome.ok, output: outcome.preview, timedOut: outcome.timedOut === true });
        }
        if (paused === true) {
          emit({ type: 'finish', reason: 'tool-call' });
          return;
        }
      }
      emit({ type: 'finish', reason: 'max-rounds' });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'chat-failed';
      logger(`chat: turn failed: ${code} ${error?.message ?? error}`);
      emit({ type: 'error', code, message: error?.message ?? String(error) });
    }
  };

  return {
    describeModels,
    runTurn,
    /** 绑死本服务的会话表：路由层调用时不用再传 service。 */
    executeInSession: (args) => executeInSession({ ...args, service }),
  };
}
