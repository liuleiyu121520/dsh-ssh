/**
 * 人工确认回合的暂停态回归：`finish{tool-call}` 之后必须"可点执行"。
 *
 * 2026-10-24 真机：模型第一轮几乎总是调 `run_command`（system prompt 就要求
 * "先跑只读命令确认现状"），回合以 `finish{reason:'tool-call'}` 暂停。旧实现
 * 把"等用户确认"也记成 `streaming: true`，于是：
 *   1. 输入区一直显示"停止"，消息区一直显示"思考中"；
 *   2. `resolveToolCall` 开头的 `streaming === true` 守卫直接 return ——
 *      用户点"执行"没有任何反应，回合永久卡死。
 * 本文件锁死修好后的语义：暂停 ≠ 流式。
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
globalThis.EventSource = class { constructor() { this.closed = false; } addEventListener() {} removeEventListener() {} close() {} };

/**
 * 把若干 SSE 帧做成一帧到底的响应体（回合正常结束）。
 * @param {object[]} events 事件对象。
 * @returns {ReadableStream} 响应体。
 */
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

/** @type {Array<{url: string, init: object}>} 收到的请求。 */
const calls = [];
/** @type {object[][]} 每次 POST /chat 的事件剧本。 */
const script = [
  [
    { type: 'model', provider: 'p1', model: 'm1' },
    { type: 'tool-call', id: 'c1', name: 'run_command', command: 'df -h /', arguments: '{"command":"df -h /"}', needsConfirm: true },
    { type: 'finish', reason: 'tool-call' },
  ],
  [
    { type: 'model', provider: 'p1', model: 'm1' },
    { type: 'text', text: '根分区用了 63%。' },
    { type: 'finish', reason: 'stop' },
  ],
];

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  calls.push({ url: target, init });
  if (target.includes('/api/dsh-ssh/hosts')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        hosts: [{ id: 'h-1', sid: 's1', label: 't', host: '1.2.3.4', port: 22, username: 'u', authKind: 'pass', hasSecret: true }],
        sessions: [{ sid: 's1', status: 'open', host: { id: 'h-1', label: 't' } }],
        activeSid: 's1',
      }),
    };
  }
  if (target.includes('/api/dsh-ssh/llm')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ available: true, providers: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', label: 'M1' }] }], default: { provider: 'p1', model: 'm1' } }),
    };
  }
  if (target.includes('/api/dsh-ssh/chat/exec')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, output: 'Filesystem 63%', timedOut: false }) };
  }
  if (target.includes('/api/dsh-ssh/chat')) {
    const next = script.shift() ?? [];
    return { ok: true, status: 200, body: frames(next) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { actions, getState } = await import('../src/client/store.js');

test('回合因工具调用暂停后，点"执行"必须真的跑（不能卡在思考中）', async () => {
  await actions.loadHosts();
  await actions.loadLlm();
  const sid = getState().activeSid;
  assert.equal(sid, 's1');

  await actions.sendChat('看看磁盘');

  const paused = getState().chats.s1;
  assert.equal(paused.streaming, false, '暂停态不应再算"流式中"（否则永远显示思考中/停止）');
  assert.equal(paused.pending, true, '暂停态要单独标记，用来锁住输入框');

  const turn = paused.messages.at(-1);
  const card = turn.calls[0];
  assert.equal(card.status, 'awaiting', '命令卡应停在待确认');

  // 用户点"执行"：旧实现在这里 return，什么都不会发生。
  await actions.resolveToolCall('s1', card.id, true);

  const execCall = calls.find((call) => call.url.includes('/chat/exec'));
  assert.ok(execCall !== undefined, '点执行必须真的请求 /chat/exec');
  const resumed = calls.filter((call) => call.url.endsWith('/api/dsh-ssh/chat'));
  assert.equal(resumed.length, 2, '执行完必须续跑一轮对话（第二次 POST /chat）');

  const done = getState().chats.s1;
  assert.equal(done.pending, false, '续跑结束应清掉暂停标记');
  assert.equal(done.streaming, false, '回合结束不该还是流式中');
  const cards = done.messages.flatMap((message) => (message.kind === 'turn' ? message.calls ?? [] : []));
  assert.equal(cards[0].status, 'done', '命令卡应变成已完成');
  assert.ok(String(done.messages.at(-1).text).includes('63%'), '模型的收尾文本要落地');
});
