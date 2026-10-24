/**
 * 对话看门狗回归：两档语义。
 *
 * 背景（2026-10-24 真机）：右栏"一直思考中"，而同一个模型在原生对话里能正常
 * 回答。原因不是通道坏了，是 60s 硬超时把**健康的长思考**当成挂死掐掉了：
 * 思考型模型（reasoning effort）单是思考就可能超过 60s；部分通道（如
 * our-free-model 的 combo）在出首个正文前会把 reasoning 整个缓冲住，一个
 * 字节都不吐。原生对话没有看门狗，所以它能等出答案。
 *
 * 现在的契约：
 * - 60s 完全没动静 → 只把 `slow` 打上（UI 提示"还在等"），**不**断开；
 * - 期间只要有事件（reasoning 增量也算）→ 撤掉提示、计时归零；
 * - 180s 仍然完全没动静 → 才断开并给超时文案。
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
 * 造一个可手动推帧的 SSE 响应体。
 * @param {AbortSignal|undefined} signal 请求的取消信号。
 * @returns {{body: ReadableStream, push: (event: object) => void, close: () => void}} 句柄。
 */
function manualStream(signal) {
  const encoder = new TextEncoder();
  let controller = null;
  const body = new ReadableStream({
    start(ctrl) {
      controller = ctrl;
      // 真 fetch 的 abort 语义：signal 中止 → 流报错，pending 的 read 拒绝。
      signal?.addEventListener('abort', () => ctrl.error(new DOMException('Aborted', 'AbortError')));
    },
  });
  return {
    body,
    push: (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    close: () => controller.close(),
    abort: () => controller.error(new DOMException('Aborted', 'AbortError')),
  };
}

/** 当前测试用的对话响应体工厂（每个用例自己换）。 */
let chatBody = (signal) => manualStream(signal).body;

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
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
  if (target.includes('/api/dsh-ssh/chat')) return { ok: true, status: 200, body: chatBody(init.signal) };
  return { ok: true, status: 200, json: async () => ({}) };
};

const { actions, getState } = await import('../src/client/store.js');

/** 让微任务/IO 回调跑完（mock 定时器下 setImmediate 不受影响）。 */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 准备一个已连接会话 + 模型清单。
 * @returns {Promise<string>} 当前 sid。
 */
async function prepare() {
  await actions.loadHosts();
  await actions.loadLlm();
  const sid = getState().activeSid;
  assert.equal(sid, 's1');
  return sid;
}

test('60s 完全没动静只提示"还在等"，不掐掉健康的长思考', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  chatBody = (signal) => manualStream(signal).body;
  await prepare();

  const sendPromise = actions.sendChat('看看磁盘');
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(getState().chats.s1.streaming, true, '回合应在流式中');

  t.mock.timers.tick(61000);
  await settle();
  const slow = getState().chats.s1;
  assert.equal(slow.streaming, true, '60s 只提示，不许断开');
  assert.equal(slow.slow, true, '应打出"还在等"提示');
  assert.equal(slow.error, null, '不该报超时');

  // 继续到 181s：完全没有任何事件，才是真挂死。
  t.mock.timers.tick(120000);
  await settle();
  await sendPromise;
  const dead = getState().chats.s1;
  assert.equal(dead.streaming, false, '硬超时后必须停止流式');
  assert.equal(dead.slow, false, '收尾要清掉提示');
  assert.ok(dead.error !== null && dead.error.includes('超时'), `应显示超时文案，实际：${dead.error}`);
});

test('reasoning 增量算"有动静"：长思考不会被看门狗掐掉', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
  const handle = manualStream(undefined);
  chatBody = (signal) => {
    signal?.addEventListener('abort', () => handle.abort());
    return handle.body;
  };
  await prepare();

  const sendPromise = actions.sendChat('看看磁盘');
  t.mock.timers.tick(1000);
  await settle();

  // 70s 时模型吐了一段思考：这正是旧实现里"看不见也不计时"的事件。
  t.mock.timers.tick(70000);
  await settle();
  handle.push({ type: 'reasoning', text: '先看磁盘占用…' });
  await settle();

  const thinking = getState().chats.s1;
  assert.equal(thinking.streaming, true);
  assert.equal(thinking.slow, false, '有事件就要撤掉"还在等"');
  const turn = thinking.messages.at(-1);
  assert.equal(turn.reasoning, '先看磁盘占用…', '思考内容要进视图模型（否则用户只看到卡住）');

  // 再等 100s（累计 170s）仍在阈值内，且期间又有思考 → 不能超时。
  t.mock.timers.tick(60000);
  await settle();
  handle.push({ type: 'reasoning', text: '再看 /var。' });
  await settle();
  t.mock.timers.tick(40000);
  await settle();
  assert.equal(getState().chats.s1.streaming, true, '长思考必须继续等');
  assert.equal(getState().chats.s1.error, null);

  handle.push({ type: 'text', text: '根分区 63%。' });
  handle.push({ type: 'finish', reason: 'stop' });
  handle.close();
  await settle();
  await sendPromise;

  const done = getState().chats.s1;
  assert.equal(done.streaming, false);
  assert.equal(done.error, null);
  assert.ok(String(done.messages.at(-1).text).includes('63%'));
});
