/**
 * 视图销毁回归：启动台协议 `onTeardown`（v1.2）。
 *
 * 2026-10-25：启动台新增"关卡片时同步通知插件销毁"（`onTeardown(handler)`，
 * 关标签 → `tab-closed`，启动台卸载 → `launcher-disposed`）。本插件此前未接
 * 这个 prop——关掉卡片只是看不见了，Host 侧的 SSH 连接、客户端的 xterm +
 * EventSource 全都变成孤儿。
 *
 * 契约：
 * 1. teardownAll 必须给**每个**开着的会话发一次 POST /close（一个都不能漏）；
 * 2. 客户端状态归零：tabs / activeSid / sessions / chats——连接即将全断，
 *    这些索引再留着只会指向不存在的东西；
 * 3. 轮询必须停（否则销毁后还在打 /hosts）；
 * 4. handler 同步返回：网络请求 fire-and-forget，不等 HTTP。
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
globalThis.document = {
  createElement: () => makeElement(),
  getElementById: () => null,
  head: makeElement(),
  documentElement: makeElement(),
  activeElement: null,
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
/** EventSource 桩：记录 close() 被调了几次（销毁不能漏关长连接）。 */
const esClosed = [];
globalThis.EventSource = class {
  constructor() { this.closed = false; }
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; esClosed.push(this); }
};

const disk = new Map();
globalThis.localStorage = {
  getItem: (key) => (disk.has(key) ? disk.get(key) : null),
  setItem: (key, value) => { disk.set(key, String(value)); },
  removeItem: (key) => { disk.delete(key); },
  clear: () => { disk.clear(); },
};

/** 收到的请求登记簿：`{method, path, body}`。 */
const requests = [];

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const method = init.method ?? 'GET';
  let body = null;
  if (typeof init.body === 'string') {
    try { body = JSON.parse(init.body); } catch { body = null; }
  }
  requests.push({ method, path: target, body });
  if (target.includes('/api/dsh-ssh/hosts')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        hosts: [
          { id: 'h-1', sid: 's1', label: 'A', host: '1.2.3.4', port: 22, username: 'u', authKind: 'pass', hasSecret: true },
          { id: 'h-2', sid: 's2', label: 'B', host: '5.6.7.8', port: 22, username: 'u', authKind: 'pass', hasSecret: true },
        ],
        sessions: [
          { sid: 's1', status: 'open', host: { id: 'h-1', label: 'A' } },
          { sid: 's2', status: 'open', host: { id: 'h-2', label: 'B' } },
        ],
        activeSid: 's1',
      }),
    };
  }
  if (target.includes('/api/dsh-ssh/open')) {
    // Host 侧按 hostId 开会话并回 sid；桩按 h-N → sN 映射。
    const sid = String(body?.hostId ?? '').replace('h-', 's');
    return { ok: true, status: 200, json: async () => ({ sid, session: { sid, status: 'open' } }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { actions, getState } = await import('../src/client/store.js');

/** openSession 要从 state.hosts 里找主机，先把主机表拉起来。 */
async function boot() {
  await actions.loadHosts();
}

test('teardownAll 给每个开着的会话发一次 POST /close', async () => {
  requests.length = 0;
  // 开两个会话（openSession 依赖 /hosts 的桩返回）。
  await boot();
  await actions.openSession('h-1');
  await actions.openSession('h-2');
  assert.equal(getState().tabs.length, 2, '前置：应有两个标签');

  requests.length = 0;
  actions.teardownAll('tab-closed');
  // 请求是 fire-and-forget：给 microtask 队列一个排空的机会。
  await Promise.resolve();
  await Promise.resolve();

  const closes = requests.filter((row) => row.method === 'POST' && row.path.endsWith('/close'));
  assert.equal(closes.length, 2, `两个会话都要关，实际 ${closes.length}`);
  const closedSids = closes.map((row) => row.body.sid).sort();
  assert.deepEqual(closedSids, ['s1', 's2']);
});

test('teardownAll 把客户端状态归零', async () => {
  await boot();
  await actions.openSession('h-1');
  assert.ok(getState().tabs.length > 0, '前置：有标签');

  actions.teardownAll('launcher-disposed');

  const state = getState();
  assert.deepEqual(state.tabs, [], '标签要清空');
  assert.equal(state.activeSid, null, '活动会话要清空');
  assert.deepEqual(state.sessions, {}, '会话索引要清空');
  assert.deepEqual(state.chats, {}, '对话历史要清空（连接没了，历史也没意义）');
});

test('teardownAll 之后轮询不再打 /hosts', async () => {
  await boot();
  await actions.openSession('h-1');
  actions.teardownAll('tab-closed');

  requests.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    requests.filter((row) => row.path.includes('/hosts')).length,
    0,
    '轮询必须已停，否则销毁后还在打 /hosts',
  );
});

test('teardownAll 是幂等的：没有会话时再调一次不炸也不发请求', async () => {
  actions.teardownAll('tab-closed');
  await Promise.resolve();
  requests.length = 0;
  actions.teardownAll('tab-closed');
  await Promise.resolve();
  assert.equal(requests.filter((row) => row.method === 'POST').length, 0);
});

// ── teardownForReason：按 reason 分流（2026-10-25 真机） ──────────────────
//
// 启动台把页面整个卸载时也会调 onTeardown（reason `launcher-disposed`）——
// 切到别的会话就触发。那不是"用户不要连接了"，一律 teardownAll 会让
// "打开标签 → 切走 → 切回来" 的连接与屏幕全部丢失。

test('teardownForReason：launcher-disposed 不动连接与标签', async () => {
  await boot();
  await actions.openSession('h-1');
  const before = getState();
  assert.equal(before.tabs.length, 1, '前置：有一个标签');

  requests.length = 0;
  actions.teardownForReason('launcher-disposed');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    requests.filter((row) => row.method === 'POST' && row.path.endsWith('/close')).length,
    0,
    '页面卸载不能关 SSH 连接',
  );
  const after = getState();
  assert.deepEqual(after.tabs, before.tabs, '标签要留着');
  assert.equal(after.activeSid, before.activeSid, '激活会话要留着');
  assert.notDeepEqual(after.sessions, {}, '会话索引要留着');
});

test('teardownForReason：tab-closed 才真拆', async () => {
  await boot();
  await actions.openSession('h-2');
  const sids = getState().tabs.slice();
  assert.ok(sids.length > 0, '前置：有标签');

  requests.length = 0;
  actions.teardownForReason('tab-closed');
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(
    requests.filter((row) => row.method === 'POST' && row.path.endsWith('/close')).length,
    sids.length,
    '关卡片要把每个会话都关掉',
  );
  assert.deepEqual(getState().tabs, [], '状态归零');
});

test('teardownForReason：未知 reason 保守不动', async () => {
  await boot();
  await actions.openSession('h-1');
  requests.length = 0;
  actions.teardownForReason('');
  await Promise.resolve();
  assert.equal(requests.filter((row) => row.method === 'POST').length, 0);
  assert.equal(getState().tabs.length, 1);
  // 收尾：别把状态留给后续用例。
  actions.teardownAll('tab-closed');
  await Promise.resolve();
});
