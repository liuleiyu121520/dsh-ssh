/**
 * 混合批次（自动执行 + 需确认）之后的死锁回归（2026-10-30 真机）。
 *
 * 症状：AI 提示一条危险命令，用户点"执行"，命令跑了、输出也回来了，但之后
 * **输入框一直锁着**，底部提示"先处理上方的命令卡（执行或跳过）"——可屏幕上
 * 已经没有待处理的卡片了。
 *
 * 根因两条，缺一条都复现不出来：
 * 1. 自动执行的那批命令由 Host 发 `tool-result` 事件，客户端这条分支没写
 *    `resultContent`；
 * 2. `resolveToolCall` 用"还有没有 resultContent 为空的 call"判断 pending，
 *    于是那条自动执行的卡片永远算"没归属" → pending 永远为真 → 不续跑。
 *
 * 契约：
 * - `tool-result` 事件必须把结果写进 `resultContent`（history 要用它拼 tool
 *   结果，缺了下一轮请求会被 wire 校验打回）；
 * - pending 只看卡片状态（awaiting / 执行中），不看有没有结果；
 * - 最后一张卡片处理完必须清 pending 并续跑下一轮。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const stubDir = fileURLToPath(new URL('./stubs', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@xterm/xterm') return { url: pathToFileURL(`${stubDir}/xterm6-stub.mjs`).href, shortCircuit: true };
    if (specifier === '@xterm/addon-fit') return { url: pathToFileURL(`${stubDir}/fit-stub.mjs`).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

function makeElement() {
  return { style: {}, children: [], isConnected: false, appendChild() {}, remove() {} };
}
globalThis.document = { createElement: () => makeElement(), getElementById: () => null, head: makeElement(), documentElement: makeElement(), activeElement: null };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.EventSource = class {
  constructor() { this.closed = false; }
  addEventListener() {}
  removeEventListener() {}
  close() {}
};

const disk = new Map();
globalThis.localStorage = {
  getItem: (key) => (disk.has(key) ? disk.get(key) : null),
  setItem: (key, value) => { disk.set(key, String(value)); },
  removeItem: (key) => { disk.delete(key); },
  clear: () => { disk.clear(); },
};

/** 一帧到底的 SSE 响应体。 */
function frames(events) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * 一批命令：自动执行的第一条（Host 直接跑），第二条危险命令等用户确认。
 *
 * id 带轮次前缀：同一份 stub 会被"发消息"重复调用，id 撞车会让
 * resolveToolCall 找到上一轮那张已经终态的卡片（真机上 Host 生成的 id 是
 * 唯一的，测试要自己保证这一点）。
 * @param {number} round 第几次 POST /chat。
 * @returns {object[]} 事件序列。
 */
function batchEvents(round) {
  return [
    { type: 'accepted' },
    { type: 'model', provider: 'p1', model: 'm1' },
    { type: 'text', text: '先看证书目录，再跑检查脚本。' },
    { type: 'tool-call', id: `r${round}-c1`, name: 'run_command', command: 'ls /etc/pki/nginx', arguments: '{"command":"ls /etc/pki/nginx"}' },
    { type: 'tool-result', id: `r${round}-c1`, ok: true, output: 'a.pem\nb.pem', content: 'a.pem\nb.pem\n（完整输出，比预览长）' },
    { type: 'tool-call', id: `r${round}-c2`, name: 'run_command', command: 'bash cert-check.sh', arguments: '{"command":"bash cert-check.sh"}', needsConfirm: true, dangerous: true },
    { type: 'finish', reason: 'tool-call' },
  ];
}

/** 续跑那一轮的收尾事件。 */
const FOLLOW_UP_EVENTS = [
  { type: 'accepted' },
  { type: 'text', text: '证书都还在有效期内。' },
  { type: 'finish', reason: 'stop' },
];

/** 记录 /chat 被调用了几次（第二次必须是用户点执行后的续跑）。 */
let chatCalls = 0;
/** 记录客户端 POST /chat 时带的 history（检查 tool 结果有没有拼回去）。 */
let lastHistory = null;

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.includes('/hosts')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        hosts: [{ id: 'h1', sid: 's1', label: 'A', host: '1.2.3.4', port: 22, username: 'u', authKind: 'pass', hasSecret: true }],
        sessions: [{ sid: 's1', status: 'open', host: { id: 'h1', label: 'A' } }],
        activeSid: 's1',
      }),
    };
  }
  if (target.includes('/llm')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        available: true,
        providers: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', label: 'M1' }] }],
        default: { provider: 'p1', model: 'm1' },
      }),
    };
  }
  if (target.includes('/chat/exec')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, output: 'all ok', preview: 'all ok', timedOut: false }) };
  }
  if (target.includes('/chat')) {
    chatCalls += 1;
    if (options.body !== undefined) lastHistory = JSON.parse(options.body).messages ?? null;
    // 奇数次 POST = 用户新消息（跑一批命令），偶数次 = 用户点执行/跳过后的续跑。
    return { ok: true, status: 200, body: frames(chatCalls % 2 === 1 ? batchEvents(chatCalls) : FOLLOW_UP_EVENTS) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { actions, getState } = await import('../src/client/store.js');

test('混合批次：点执行后必须清掉 pending 并续跑下一轮', async () => {
  await actions.loadHosts();
  await actions.loadLlm();
  await actions.sendChat('检查一下证书');

  const chat = getState().chats.s1;
  const turn = chat.messages.filter((message) => message.kind === 'turn')[0];
  assert.deepEqual(turn.calls.map((call) => call.id), ['r1-c1', 'r1-c2']);
  // 自动执行的那条：结果必须写进 resultContent（history 靠它拼 tool 消息）。
  assert.equal(turn.calls[0].status, 'done');
  assert.equal(turn.calls[0].resultContent, 'a.pem\nb.pem\n（完整输出，比预览长）');
  assert.equal(turn.calls[0].resultError, false);
  // 危险命令等确认 → 整个对话处于 pending。
  assert.equal(turn.calls[1].status, 'awaiting');
  assert.equal(chat.pending, true);
  assert.equal(chatCalls, 1);

  // 用户点"执行"。
  await actions.resolveToolCall('s1', 'r1-c2', true);

  const after = getState().chats.s1;
  const handled = after.messages.filter((message) => message.kind === 'turn')[0];
  assert.equal(handled.calls[1].status, 'done', '卡片要落到终态');
  assert.equal(handled.calls[1].resultContent, 'all ok', '执行结果要进 history');
  // 死锁点：这里如果还是 true，输入框就再也发不出消息。
  assert.equal(after.pending, false, '最后一张卡片处理完必须解锁输入框');
  assert.equal(chatCalls, 2, '必须自动续跑下一轮');
  assert.equal(after.streaming, false);

  // 续跑时带上去的 history 必须"有 tool-call 就有 tool 结果"。
  assert.ok(Array.isArray(lastHistory));
  const callIds = new Set();
  const resultIds = new Set();
  for (const message of lastHistory) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool-call') callIds.add(block.id);
    }
    if (message.role === 'tool') resultIds.add(message.toolCallId);
  }
  assert.deepEqual([...callIds].sort(), ['r1-c1', 'r1-c2']);
  assert.deepEqual([...resultIds].sort(), ['r1-c1', 'r1-c2'], '每个 tool-call 都要有对应的 tool 结果');
});

test('用户点"跳过"同样解锁（跳过也要补一条 isError 的 tool 结果）', async () => {
  const before = chatCalls;
  await actions.sendChat('再来一次');
  const round = before + 1;

  const chat = getState().chats.s1;
  const lastTurn = chat.messages.filter((message) => message.kind === 'turn').at(-1);
  assert.equal(lastTurn.calls[1].id, `r${round}-c2`);
  assert.equal(lastTurn.calls[1].status, 'awaiting');

  await actions.resolveToolCall('s1', `r${round}-c2`, false);
  const after = getState().chats.s1;
  assert.equal(after.pending, false);
  assert.equal(chatCalls, round + 1, '跳过之后也要续跑');
  const skipped = after.messages.flatMap((message) => message.calls ?? []).find((call) => call.id === `r${round}-c2`);
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.resultError, true, '跳过要以 isError 的 tool 结果回给模型');
});
