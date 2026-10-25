/**
 * 多轮工具循环的渲染顺序回归（2026-10-25 真机）。
 *
 * 症状：一个回合里模型跑了四轮命令，右栏看到的是"一整篇结论在最上面、
 * 四张命令卡全堆在下面"——最新的那句话被顶出可视区。
 *
 * 根因：auto 模式下 Host 在**一次** runTurn 里循环多轮，只发一个 finish；
 * 客户端把流式增量全并进同一条 turn 消息（text 一个字段、calls 一个数组），
 * 渲染时自然变成"先全部正文、再全部卡片"。
 *
 * 契约（对齐原生对话：一个 assistant 消息 = 一次模型响应）：
 * 1. Host 在每轮之间发 `round` 事件，客户端据此把当前 turn 封口；
 * 2. 于是 messages = [user, turn(正文A+卡), turn(正文B)]，顺序就是发生顺序；
 * 3. `round` 带的 replayState 要落在**被它封口的那条**消息上（思考签名
 *    属于各自的模型响应，续轮时官方通道要求原样回传）。
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

/** Host 侧一个"跑了两轮工具"的回合会吐出的事件序列。 */
const ROUND_EVENTS = [
  { type: 'accepted' },
  { type: 'model', provider: 'p1', model: 'm1' },
  { type: 'text', text: '先看看磁盘。' },
  { type: 'tool-call', id: 'c1', name: 'run_command', command: 'df -h' },
  { type: 'tool-result', id: 'c1', ok: true, output: '/dev/disk1s1 500G' },
  { type: 'round', replayState: { signature: 'sig-round-1' } },
  { type: 'text', text: '再看内存。' },
  { type: 'tool-call', id: 'c2', name: 'run_command', command: 'free -h' },
  { type: 'tool-result', id: 'c2', ok: true, output: 'Mem: 3.9G' },
  { type: 'round', replayState: { signature: 'sig-round-2' } },
  { type: 'text', text: '结论：磁盘和内存都正常。' },
  { type: 'finish', reason: 'stop', replayState: { signature: 'sig-final' } },
];

globalThis.fetch = async (url) => {
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
  if (target.includes('/chat')) return { ok: true, status: 200, body: frames(ROUND_EVENTS) };
  return { ok: true, status: 200, json: async () => ({}) };
};

const { actions, getState } = await import('../src/client/store.js');

test('多轮工具循环：正文与命令卡按发生顺序分段，结论在最后', async () => {
  await actions.loadHosts();
  await actions.loadLlm();
  await actions.sendChat('看看机器状态');

  const messages = getState().chats.s1.messages;
  assert.equal(messages[0].role, 'user', '第一条是用户消息');

  const turns = messages.filter((message) => message.kind === 'turn');
  assert.equal(turns.length, 3, `两轮工具 + 一轮收尾 = 3 段，实际 ${turns.length}`);

  assert.equal(turns[0].text, '先看看磁盘。');
  assert.deepEqual(turns[0].calls.map((call) => call.id), ['c1'], '第一段只带第一条命令');
  assert.equal(turns[0].streaming, false);

  assert.equal(turns[1].text, '再看内存。');
  assert.deepEqual(turns[1].calls.map((call) => call.id), ['c2']);

  assert.equal(turns[2].text, '结论：磁盘和内存都正常。', '收尾的结论必须是最后一段');
  assert.deepEqual(turns[2].calls, [], '收尾段没有命令卡');

  // 渲染顺序：正文A → 卡A → 正文B → 卡B → 结论（不再是"全部正文 + 全部卡片"）。
  const shape = turns.map((turn) => `${turn.text === '' ? '-' : 'text'}${(turn.calls ?? []).length === 0 ? '' : `+${turn.calls.length}call`}`);
  assert.deepEqual(shape, ['text+1call', 'text+1call', 'text']);

  // 思考签名跟着轮边界走：每条消息拿自己的那份。
  assert.deepEqual(turns[0].replayState, { signature: 'sig-round-1' });
  assert.deepEqual(turns[1].replayState, { signature: 'sig-round-2' });
  assert.deepEqual(turns[2].replayState, { signature: 'sig-final' });

  // 回合结束后不再是 streaming，输入区可以继续用。
  assert.equal(getState().chats.s1.streaming, false);
});
