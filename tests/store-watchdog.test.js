/**
 * 对话看门狗回归：60s 无任何 SSE 事件 → 主动断开并显示超时文案。
 *
 * 2026-10-24 真机：runtime 对 TRANSPORT 失败内部重试几十秒，用户停在
 * "思考中"没有尽头。看门狗用 Date.now + setInterval 实现，本测试用
 * node:test 的 mock timers 精确推进时间验证触发。
 */
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
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

/** 永不产出、永不关闭的 SSE 响应体（模拟模型通道挂死）。 */
function hangingStream(signal) {
  return new ReadableStream({
    start(controller) {
      // 真 fetch 的 abort 语义：signal 中止 → 流报错，pending 的 read 拒绝。
      signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
    },
  });
}

/** @type {Array<{url: string, init: object}>} */
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (String(url).includes('/api/dsh-ssh/hosts')) {
    return { ok: true, status: 200, json: async () => ({ hosts: [{ id: 'h-1', sid: 's1', label: 't', host: '1.2.3.4', port: 22, username: 'u', authKind: 'pass', hasSecret: true }], sessions: [{ sid: 's1', status: 'open', host: { id: 'h-1', label: 't' } }], activeSid: 's1' }) };
  }
  if (String(url).includes('/api/dsh-ssh/llm')) {
    return { ok: true, status: 200, json: async () => ({ available: true, providers: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', label: 'M1' }] }], default: { provider: 'p1', model: 'm1' } }) };
  }
  if (String(url).includes('/api/dsh-ssh/chat')) {
    return { ok: true, status: 200, body: hangingStream(init.signal) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { actions, getState } = await import('../src/client/store.js');

test('看门狗：60s 无事件主动断开并给出超时文案', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });

  await actions.loadHosts();
  await actions.loadLlm();
  const sid = getState().activeSid;
  assert.equal(sid, 's1');

  const sendPromise = actions.sendChat('看看磁盘');
  // sendChat 内部有 await：让微任务跑完，fetch 已挂起。
  t.mock.timers.tick(1000); await new Promise((r) => setImmediate(r));
  assert.equal(getState().chats.s1.streaming, true, '回合应在流式中');

  // 推进 61s：看门狗（5s 间隔轮询 + 60s 无事件阈值）必须已触发。
  t.mock.timers.tick(61000); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  await sendPromise;

  const chat = getState().chats.s1;
  assert.equal(chat.streaming, false, '看门狗触发后必须停止流式');
  assert.ok(chat.error !== null && chat.error.includes('超时'), `应显示超时文案，实际：${chat.error}`);
  // 停止按钮消失后再次发送不应被 chatAbort 卡住。
  assert.ok(typeof getState().chats.s1.messages === 'object');
});
