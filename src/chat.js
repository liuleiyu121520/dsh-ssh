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
import { isDangerousCommand } from './danger.js';

/** 喂给模型的输出最大字符数（超出截断尾部并标注）。 */
const MAX_OUTPUT_CHARS = 6000;
/** 工具结果回给客户端做预览的最大字符数。 */
const MAX_PREVIEW_CHARS = 1200;
/** 单轮请求里最大的"模型轮"数（含工具续跑），防无限循环。 */
const MAX_TOOL_ROUNDS = 6;
/** 一次模型调用的重试硬上限（'always' 策略也不会超过它）。 */
const HARD_MAX_RETRIES = 6;
/**
 * 面板自己的重试次数上限：**比通道策略更保守**。
 *
 * 通道的 retryPolicy 是给 agent loop 用的（后台跑、用户不在等）；右栏是有人
 * 盯着的前端，同一个确定性失败重试 5 次只是让用户干等 20 秒（DeepSeek 官方
 * 通道的默认策略就是 5 次）。面板只试 2 次：抖动基本都在这两次里恢复，恢复
 * 不了就换通道 + 自动重发。
 */
const PANEL_MAX_RETRIES = 2;
/**
 * 授权三档：
 * - `auto`   命令直接执行；
 * - `danger` 只拦危险命令（rm -rf / 重启 / 停服务…，见 src/danger.js）；
 * - `always` 每条命令都要用户点确认。
 */
const APPROVALS = Object.freeze(['auto', 'danger', 'always']);
/** 默认命令超时（毫秒）与硬上限。 */
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
/** 交互式命令超时后先发 Ctrl+C，再等这么久收尾。 */
const ABORT_GRACE_MS = 400;
/** 终端尾部进 system prompt 的默认行数。 */
const DEFAULT_CONTEXT_LINES = 60;
/** 终端尾部进 system prompt 的字符上限（行数够但单行可能极长）。 */
const MAX_TAIL_CHARS = 8000;
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
      // 客户端带回来的 replayState（思考签名）必须原样保留：续轮缺它，官方
      // 通道会拒收（2026-10-24 真机：第一轮好使、续轮必挂）。
      const replayState = raw.source !== null && typeof raw.source === 'object' ? raw.source.replayState : undefined;
      out.push({
        role,
        content: normalizeContent(raw.content),
        source: replayState === undefined ? origin : { ...origin, replayState },
      });
      continue;
    }
    out.push({ role, content: normalizeContent(raw.content) });
  }
  // 超长就丢最旧的：system 每轮由 Host 重建，不在 history 里。
  return out.slice(-MAX_HISTORY);
}

/**
 * 归一 content 成**块数组**。
 *
 * 必须永远是数组，不能是字符串：DeepSeek 官方通道的序列化器直接写
 * `message.content.flatMap(...)`（llm-deepseek/src/serialize.ts:121-122），
 * 字符串没有 flatMap → TypeError → 被 adapter 包成 `TRANSPORT`
 * → 表现为 "DeepSeek Messages transport failed"，而且**每次必失败**
 * （重试 5 次也一样）。免费通道有 `blocksOf()` 容错字符串，所以只有官方
 * 通道炸——这就是"原生能答、右栏必挂"的真正原因（2026-10-24 定位）。
 * @param {unknown} content 原始 content。
 * @returns {object[]} 块数组（可能是空数组）。
 */
function normalizeContent(content) {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];
  /** @type {object[]} */
  const blocks = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'reasoning' && typeof block.text === 'string') {
      // 思考块只作为签名载体回传（正文可以为空）。
      blocks.push({ type: 'reasoning', text: block.text });
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
  return blocks;
}

/**
 * 组装 system prompt：静态人设 + 当前环境 + 终端尾部。
 * @param {object} params 参数。
 * @param {object} params.session 会话记录（内部形态）。
 * @param {string} params.tail 终端尾部文本（已 ANSI 清洗）。
 * @param {'auto'|'danger'|'always'} params.approval 授权档位（影响措辞）。
 * @returns {string} system prompt。
 */
function buildSystemPrompt({ session, tail, approval }) {
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
    approval === 'auto'
      ? '5. 当前是自动执行模式：你调用的 run_command 会被立即执行，请对每条命令有把握。'
      : approval === 'danger'
        ? '5. 当前是"危险命令确认"模式：只读/低风险命令会自动执行，删除、重启、停服务等破坏性命令会先请用户确认。'
        : '5. 当前是人工确认模式：你提出的每条命令都会展示给用户，由用户决定是否执行。',
    '',
    '终端最后几十行输出（可能不完整，以命令实测为准）：',
    '```',
    tail === '' ? '(暂无输出)' : tail,
    '```',
  ];
  return lines.join('\n');
}

/**
 * 归一 finish reason。
 *
 * 真契约是**对象** `{kind:'stop'|'tool-calls'|'error'|'aborted'|'max-tokens',
 * failure?: {message, code}}`（dsh-llm types.ts 的 FinishReasonMap）。字符串
 * 形状是曾经的错误假设——真 adapter（dsh-our-free-model）全发对象，按字符串
 * 解析会把 error 静默吞成 stop，用户侧表现为"输入了没反应"
 * （2026-10-24 真机实测）。字符串仅作兼容保留。
 * @param {unknown} reason finish chunk 的 reason 字段。
 * @returns {{kind: string, failure: object|null}} 归一结果。
 */
function normalizeFinish(reason) {
  if (typeof reason === 'string') return { kind: reason, failure: null };
  if (reason !== null && typeof reason === 'object' && typeof reason.kind === 'string') {
    return { kind: reason.kind, failure: reason.failure ?? null };
  }
  return { kind: 'stop', failure: null };
}

/**
 * 从 stream chunk 流里攒一个回合的结果。
 *
 * 文本增量立刻经 onEvent 吐出去（SSE 流式）；工具调用块在 block-end 时
 * 成块收齐（arguments 是完整 JSON 字符串）。
 * @param {AsyncIterable<object>} chunks llm stream。
 * @param {(event: object) => void} onEvent 事件回调。
 * @returns {Promise<{text: string, reasoning: string, toolCalls: object[], finishReason: string, finishFailure: object|null}>} 回合结果。
 */
async function consumeStream(chunks, onEvent) {
  let text = '';
  let reasoning = '';
  /** @type {Map<number, {id: string, name: string, args: string}>} */
  const pending = new Map();
  /** @type {object[]} */
  const toolCalls = [];
  let finishReason = 'stop';
  let finishFailure = null;
  /** 原生 replay 元数据（思考签名）：续轮必须原样回传，否则官方通道拒收。 */
  let replayState;
  for await (const chunk of chunks ?? []) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      onEvent({ type: 'text', text: chunk.text });
      continue;
    }
    // 思考型模型（reasoning effort 生效时）先吐几十秒的 reasoning-delta 才有
    // 正文。**必须转出去**，否则客户端在整个思考期收不到任何事件：
    // 面板显示"思考中"却永远没有内容，看门狗还会把健康的长思考当挂死掐掉
    // （2026-10-24 真机：同一模型在原生对话里能答，在右栏必超时）。
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoning += chunk.text;
      onEvent({ type: 'reasoning', text: chunk.text });
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
    if (chunk.type === 'finish') {
      const finish = normalizeFinish(chunk.reason);
      finishReason = finish.kind;
      finishFailure = finish.failure;
      if (chunk.replayState !== undefined) replayState = chunk.replayState;
    }
  }
  // delta 攒了但没等到 block-end 的（异常截断）：能救一个是一个。
  for (const slot of pending.values()) {
    if (slot.name !== '' && !toolCalls.some((call) => call.id === slot.id && slot.id !== '')) {
      toolCalls.push({ id: slot.id || `call-${randomBytes(6).toString('hex')}`, name: slot.name, arguments: slot.args || '{}' });
    }
  }
  return { text, reasoning, toolCalls, finishReason, finishFailure, replayState };
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
    // 单行合成：`<command>; printf marker "$?"`——`;` 让 printf 紧跟命令，
    // `$?` 即命令退出码。**不要拆成两次 send**：两行连发时 readline 偶尔
    // 吞掉第二行的换行（bracketed paste 会话上的竞态，2026-10-24 E2E
    // 连续复现），printf 永不执行 → 必超时。合成一行后整行是一个整体，
    // shell 顺序执行，marker 天然是输出结束分界线。
    service.send(sid, `${command}; printf '%s %s\\n' '${marker}' "$?"\n`);
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
    // 补救：Ctrl+C 后 shell 回到干净提示符，补发一次 marker 行把已经产生
    // 的输出收干净（命令已被打断，rc 无意义；timedOut 已标记，输出完整
    // 比 rc 更重要——超时也要让用户/模型看到前半段输出）。
    if (!done) {
      try {
        service.send(sid, `printf '%s %s\\n' '${marker}' "$?"\n`);
      } catch {
        // 会话断了：放弃补救。
      }
      const rescue = Date.now() + 1000;
      while (!done && Date.now() < rescue) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    }
  }
  return finish();
}

/**
 * 这次失败是否该按 provider 的 retryPolicy 重试。
 *
 * 形状取自 `ResolvedRetryPolicy`（dsh-llm/retry-policy）：normal 模式只重试
 * retryableCodes 里的稳定错误码，always 模式重试一切。缺策略就当不重试。
 * @param {object|undefined} policy prepared.retryPolicy。
 * @param {{code?: string}|null|undefined} failure finish 里的 failure。
 * @param {number} attempt 已经重试过的次数（从 0 起）。
 * @returns {boolean} 是否重试。
 */
function retryable(policy, failure, attempt) {
  if (policy === undefined || policy === null) return false;
  // 自带硬上限：'always' 模式在 runtime 里是"重试到成功或取消"，但面板是
  // 一个会一直转的前端，通道彻底挂了不能无限重试（每次重试事件都会重置
  // 客户端的看门狗，等于永远不超时）。
  if (attempt >= HARD_MAX_RETRIES) return false;
  if (policy.mode === 'always') return attempt < PANEL_MAX_RETRIES;
  if (policy.mode !== 'normal') return false;
  const limit = Number.isInteger(policy.maxRetries) ? Math.min(policy.maxRetries, PANEL_MAX_RETRIES) : PANEL_MAX_RETRIES;
  if (attempt >= limit) return false;
  const code = typeof failure?.code === 'string' ? failure.code : '';
  return Array.isArray(policy.retryableCodes) && policy.retryableCodes.includes(code);
}

/**
 * 指数退避 + 对称抖动（与 runtime 的算法同义，避免多实例同时重试打爆通道）。
 * @param {object|undefined} policy prepared.retryPolicy。
 * @param {number} attempt 已经重试过的次数（从 0 起）。
 * @returns {number} 延迟毫秒。
 */
function backoffDelay(policy, attempt) {
  const initial = Number.isFinite(policy?.initialDelayMs) ? policy.initialDelayMs : 500;
  const ceiling = Number.isFinite(policy?.maxDelayMs) ? policy.maxDelayMs : 10000;
  const jitter = Number.isFinite(policy?.jitterRatio) ? policy.jitterRatio : 0.1;
  const base = Math.min(initial * 2 ** attempt, ceiling);
  const factor = 1 + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(base * factor));
}

/**
 * 可被取消的等待：用户点"停止"时立刻返回，不把回合拖在退避里。
 * @param {number} ms 毫秒。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<void>} 等待结束。
 */
async function sleep(ms, signal) {
  if (signal?.aborted === true) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
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
  /**
   * 惰性取宿主的 DeepSeek 账号服务（deepseekAccount，读登录态用）。
   * 不进 inject（铁律：可选服务缺失会让 fiber 永远 pending），每次用时解析。
   * @returns {object|undefined} deepseekAccount 服务或 undefined。
   */
  const account = typeof options.account === 'function' ? options.account : () => undefined;
  const contextLines = Number.isInteger(config.maxContextLines) && config.maxContextLines > 0 ? config.maxContextLines : DEFAULT_CONTEXT_LINES;
  const defaultProvider = typeof config.provider === 'string' && config.provider !== '' ? config.provider : '';
  const defaultModel = typeof config.model === 'string' && config.model !== '' ? config.model : '';

  /**
   * 探测宿主 DeepSeek 账号登录态。
   * @returns {Promise<string|undefined>} 'signed-out' | 'credential-stored' | undefined（服务缺位/失败）。
   */
  const probeAccount = async () => {
    const service = account();
    if (service === undefined || service === null || typeof service.getState !== 'function') return undefined;
    try {
      const view = await service.getState();
      return typeof view?.status === 'string' ? view.status : undefined;
    } catch {
      return undefined; // 探测失败不标记：宁可让用户看到真实调用错误
    }
  };

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
    // 登录态过滤：deepseek-account 未登录时其模型清单只是内置目录（无远程
    // listing），调用必失败——账号服务缺位/探测失败时不做任何标记（能力
    // 探测绝不能把正常路径打挂）。
    const status = await probeAccount();
    if (status === 'signed-out') {
      for (const row of providers) {
        if (row.id === 'deepseek-account') row.unavailable = 'DeepSeek 未登录';
      }
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
      if (row.unavailable !== undefined) continue; // 未登录等已知不可用：默认挑选跳过
      const model = row.models[0] ?? null;
      if (model !== null) return { provider: row.id, model: model.id };
    }
    // 全都不可用：退而求其次，别让用户一个模型都选不到。
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
  const runTurn = async ({ sid, messages, autoExecute, approval: approvalInput, provider, model, signal, onEvent }) => {
    // 授权三档：auto（直接跑）/ danger（危险命令才确认）/ always（每条都确认）。
    // 老客户端只发 autoExecute 布尔值，按 true→auto、false→always 兼容。
    const approval = APPROVALS.includes(approvalInput)
      ? approvalInput
      : (autoExecute === true ? 'auto' : 'always');
    const emit = (event) => {
      try {
        onEvent(event);
      } catch {
        // 回调抛错不该中断对话流（SSE 连接断了会走 signal 路径）。
      }
    };
    try {
      service.get(sid); // 会话不存在：明确的 404 语义
      // 第一帧：请求已被受理。客户端据此区分"请求没到"和"模型没回"。
      emit({ type: 'accepted' });
      const wantedProvider = typeof provider === 'string' ? provider : '';
      const wantedModel = typeof model === 'string' ? model : '';
      /** @type {{provider: string, model: string}|null} */
      let picked = null;
      if (wantedProvider !== '' && wantedModel !== '') {
        // 客户端已经明确选了通道与模型：**直接调**，不先跑清单。
        // describeModels() 是"列清单"（逐 provider listModels，部分通道会碰
        // 账号/网络），把它放在回合最前面会让用户在第一个事件之前干等；
        // 原生对话也从不为了发一条消息去列一遍清单。模型 id 不存在时
        // prepareCall 会当场报错，错误会带通道前缀透给用户，比静默等待好。
        picked = { provider: wantedProvider, model: wantedModel };
      } else {
        const inventory = await describeModels();
        if (inventory.available !== true) {
          emit({ type: 'error', code: 'llm-unavailable', message: '宿主没有可用的模型服务（llm），请在 dsh 里配置模型后重试' });
          return;
        }
        picked = pickModel(wantedProvider, wantedModel, inventory.providers);
        if (picked === null) {
          emit({ type: 'error', code: 'llm-no-model', message: '没有可用模型：宿主未注册任何 provider 或模型列表为空' });
          return;
        }
      }
      emit({ type: 'model', provider: picked.provider, model: picked.model });

      const session = service.get(sid);
      // 行数上限之外再加字符上限：终端里 `cat` 一个大文件时，60 行也可能是
      // 几百 KB，把 system prompt 撑到离谱的体积（请求体过大在代理上会被
      // 直接掐连接）。只留尾部——结论通常在最后。
      const tail = truncateTail(stripAnsi(service.readText(sid, contextLines).text), MAX_TAIL_CHARS);
      const system = buildSystemPrompt({ session, tail, approval });
      const history = normalizeHistory(messages, picked);
      if (history.length === 0) {
        emit({ type: 'error', code: 'empty-history', message: '对话历史为空' });
        return;
      }

      /** 客户端记住的通道可能已经不存在（插件升级/改名）：只回退一次。 */
      let fellBack = false;
      /**
       * 取一次 prepared call；通道/模型已不存在时回退一次清单里的健康通道。
       * @returns {Promise<object>} prepared call。
       */
      const prepareOnce = async () => {
        try {
          return await llm.prepareCall({ provider: picked.provider, model: picked.model });
        } catch (error) {
          // 通道/模型已不存在（旧的 localStorage 选择最常见）：回退到清单里
          // 第一个健康通道重试一次，别让一个过期选择把用户钉死在错误上。
          if (fellBack === true) throw error;
          fellBack = true;
          const inventory = await describeModels();
          const fallback = inventory.available === true ? pickModel('', '', inventory.providers) : null;
          if (fallback === null) throw error;
          picked = fallback;
          emit({ type: 'model', provider: picked.provider, model: picked.model });
          return llm.prepareCall({ provider: picked.provider, model: picked.model });
        }
      };
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        if (signal?.aborted === true) {
          emit({ type: 'finish', reason: 'aborted' });
          return;
        }
        let prepared;
        let result;
        // 通道级瞬时失败（TRANSPORT/TIMEOUT/SERVER…）按 adapter 自带的
        // retryPolicy 退避重试。**这一层以前完全没有**，而原生对话有
        // （dsh-llm-retry 挂在 agent loop 的失败钩子上）：同一条通道偶发抖动，
        // 原生悄悄重试两次就好了，我们一次就报错——这才是"原生能答、右栏
        // transport failed"的真正差别（2026-10-24 真机）。
        for (let attempt = 0; ; attempt += 1) {
          prepared = await prepareOnce();
          result = await consumeStream(
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
              // 原生对话每轮都带 sessionId（adapter 会映射成请求体字段 +
              // x-deepseek-harness-session-id 头）。账号通道靠它做归属/路由，
              // 我们之前一个都不带——这是与原生请求最后的形状差异
              // （2026-10-24 对照 session.v4 日志的 request/header 发现）。
              sessionId: sid,
              signal,
            }),
            emit,
          );
          if (result.finishReason !== 'error') break;
          // 已经吐出正文/命令卡就不重试：重试会把同一段话再说一遍，用户看到
          // 的是重复内容。通道级失败几乎都发生在首字节之前。
          const untouched = result.text === '' && result.toolCalls.length === 0;
          const policy = prepared.retryPolicy;
          if (untouched !== true || retryable(policy, result.finishFailure, attempt) !== true) break;
          const delayMs = backoffDelay(policy, attempt);
          emit({
            type: 'retry',
            attempt: attempt + 1,
            maxRetries: policy.mode === 'always' ? null : policy.maxRetries,
            delayMs,
            code: typeof result.finishFailure?.code === 'string' ? result.finishFailure.code : '',
          });
          logger(`chat: retrying after ${result.finishFailure?.code ?? 'error'} in ${delayMs}ms (attempt ${attempt + 1})`);
          await sleep(delayMs, signal);
          if (signal?.aborted === true) break;
        }
        if (result.toolCalls.length === 0 || result.finishReason === 'error') {
          if (result.finishReason === 'error') {
            // 真 adapter 的失败信息在 finish.failure 里（{message, code}）——
            // 吞掉它用户只会看到"没反应"。附上失败的通道与模型，用户能
            // 自己判断该换哪个（如未登录的 DeepSeek 官方通道）。
            const failure = result.finishFailure;
            const message = typeof failure?.message === 'string' && failure.message !== ''
              ? failure.message
              : '模型调用失败，请重试或切换模型';
            // status / requestId 是排障的唯一线索（"transport failed" 本身
            // 不含原因）：有就带上，没有不强编。
            const facts = [];
            if (Number.isInteger(failure?.status)) facts.push(`HTTP ${failure.status}`);
            if (typeof failure?.requestId === 'string' && failure.requestId !== '') facts.push(`req ${failure.requestId}`);
            emit({
              type: 'error',
              code: typeof failure?.code === 'string' ? failure.code : 'llm-error',
              message: `[${picked.provider} / ${picked.model}] ${message}${facts.length === 0 ? '' : `（${facts.join('，')}）`}`,
            });
            return;
          }
          if (result.finishReason === 'aborted') {
            emit({ type: 'finish', reason: 'aborted' });
            return;
          }
          if (result.text === '') {
            // 零文本零工具的空响应：必须出声，否则用户以为面板卡死。
            emit({ type: 'error', code: 'empty-response', message: `[${picked.provider} / ${picked.model}] 模型没有返回任何内容（可能当前不可用或触发了安全策略），请重试或切换模型` });
            return;
          }
          emit({
            type: 'finish',
            reason: 'stop',
            ...result.replayState === undefined ? {} : { replayState: result.replayState },
          });
          return;
        }
        // 只有 run_command 一个工具；别的名字按错误结果回给模型。
        /**
         * assistant 消息的来源标注：真 runtime 的 forAdapter 要读 source，
         * 而 `replayState`（思考签名）必须原样回传——思考型模型的多轮请求里，
         * 带 tool_use 的 assistant 轮缺了 thinking 块会被官方通道直接拒掉
         * （2026-10-24：第一轮好使、续轮必挂，就是这里丢了元数据）。
         */
        const modelSource = {
          kind: 'model',
          provider: picked.provider,
          model: picked.model,
          ...result.replayState === undefined ? {} : { replayState: result.replayState },
        };
        /** @type {object[]} */
        const assistantBlocks = [];
        // 与原生一致：思考块只作为签名载体，正文留空（签名才是服务端要的）。
        if (result.replayState !== undefined) assistantBlocks.push({ type: 'reasoning', text: '' });
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
          // danger 档：只拦危险命令；always 档：每条都拦。
          const dangerous = approval === 'danger' ? isDangerousCommand(args.command) : false;
          const needsConfirm = approval === 'always' || (approval === 'danger' && dangerous);
          emit({
            type: 'tool-call',
            id: call.id,
            name: call.name,
            command: args.command,
            arguments: call.arguments,
            ...needsConfirm ? { needsConfirm: true, dangerous } : {},
          });
          if (needsConfirm) {
            // 需要确认：命令先展示给用户，回合到此暂停；客户端逐条执行/跳过
            // 后带 tool 结果再次 POST，循环从下一轮继续。
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
          emit({
            type: 'finish',
            reason: 'tool-call',
            ...result.replayState === undefined ? {} : { replayState: result.replayState },
          });
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
