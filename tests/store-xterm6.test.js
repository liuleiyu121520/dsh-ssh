/**
 * xterm 6.0 兼容回归：公开 API 没有 onFocus，wireRuntime 不能崩。
 *
 * 2026-10-24 真机事故：xterm 6.0 的公开 Terminal 类移除了 onFocus
 * （内部 CoreBrowserTerminal 还有但没暴露），store.js 无条件调用
 * `term.onFocus()` → 每次打开会话抛 TypeError → 启动台错误边界兜住
 * → 用户看到"此应用加载失败"。本文件用无 onFocus 的替身复刻该形状，
 * 验证：① getRuntime 不抛；② 聚焦经 textarea DOM 事件兜底上报。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const stubDir = fileURLToPath(new URL('./stubs', import.meta.url));

// 必须在 import store.js 之前注册：把 xterm 重定向到无 onFocus 的替身。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@xterm/xterm') {
      return { url: pathToFileURL(`${stubDir}/xterm6-stub.mjs`).href, shortCircuit: true };
    }
    if (specifier === '@xterm/addon-fit') {
      return { url: pathToFileURL(`${stubDir}/fit-stub.mjs`).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

/** 最小 DOM 桩。 */
function makeElement() {
  return {
    style: {},
    children: [],
    isConnected: false,
    appendChild(child) {
      this.children.push(child);
      child.isConnected = true;
    },
    remove() {
      this.isConnected = false;
    },
  };
}

globalThis.document = {
  createElement: () => makeElement(),
  getElementById: () => null,
  head: makeElement(),
  documentElement: makeElement(),
  activeElement: null,
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.EventSource = class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = {};
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener() {}
  close() {
    this.closed = true;
  }
};

/** fetch 桩：记录 postFocus 调用。 */
/** @type {Array<{url: string, body: object}>} */
const posts = [];
globalThis.fetch = async (url, init = {}) => {
  posts.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
  return { ok: true, status: 200, json: async () => ({}) };
};

const { getRuntime } = await import('../src/client/store.js');

test('xterm6 替身确实没有 onFocus（本文件的前提）', async () => {
  const { Terminal } = await import('./stubs/xterm6-stub.mjs');
  const term = new Terminal({});
  assert.equal(typeof term.onFocus, 'undefined');
  assert.equal(typeof term.onData, 'function');
  assert.equal(typeof term.textarea.addEventListener, 'function');
});

test('getRuntime 在没有 onFocus 的 xterm 6 上不抛，且聚焦经 textarea 兜底', async () => {
  const rt = getRuntime('s1');
  // ① 不抛即到达这里；runtime 建起来了。
  assert.equal(rt.term.disposed, false);
  assert.equal(typeof rt.term.listeners.data, 'function', 'onData 仍要接上');
  assert.equal(typeof rt.term.listeners.resize, 'function', 'onResize 仍要接上');
  // ② 兜底路径：focus 监听器挂在 textarea 上。
  const focusListeners = rt.term.textarea.listeners.focus ?? [];
  assert.equal(focusListeners.length, 1, 'textarea 上必须有一个 focus 监听');
  // ③ 触发 focus → POST /focus 真的发出去。
  posts.length = 0;
  for (const listener of focusListeners) listener();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const focusPost = posts.find((item) => item.url.endsWith('/focus'));
  assert.ok(focusPost !== undefined, 'focus 事件必须触发 POST /focus');
  assert.equal(focusPost.body.sid, 's1');
});
