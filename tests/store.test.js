/**
 * store.js 的 LRU 淘汰测试（设计 §2.5 边界 4：上限 8，超出按 LRU 真销毁）。
 *
 * xterm / FitAddon 用 module.registerHooks 换成 tests/stubs 下的替身，
 * document / EventSource / getComputedStyle 用全局桩替换——不起浏览器，
 * 验证的是"建 9 个 runtime，最久未用的被销毁、新建的存活"这条不变量。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const stubDir = fileURLToPath(new URL('./stubs', import.meta.url));

// 必须在 import store.js 之前注册：把两个 xterm 包重定向到替身模块。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@xterm/xterm') {
      return { url: pathToFileURL(`${stubDir}/xterm-stub.mjs`).href, shortCircuit: true };
    }
    if (specifier === '@xterm/addon-fit') {
      return { url: pathToFileURL(`${stubDir}/fit-stub.mjs`).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

/** 假时钟：LRU 按 lastUsed 排序，用可控时间戳保证确定性。 */
let fakeNow = 1_000_000;
const realDateNow = Date.now;
Date.now = () => fakeNow;

/** @type {any[]} 所有被创建的 EventSource（含 close 记录）。 */
const sources = [];

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
    sources.push(this);
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener(type, listener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== listener);
  }

  close() {
    this.closed = true;
  }
};

const { getRuntime, getState, actions, runtimeCount, MAX_KEPT_RUNTIMES } = await import(
  '../src/client/store.js'
);
/**
 * xterm 替身本体：与 store.js 里 `@xterm/xterm` 解析到**同一个模块实例**
 * （同一 URL），所以钩它的 prototype 就能观察到真实的 dispose 顺序。
 */
const { Terminal: TerminalStub } = await import('./stubs/xterm-stub.mjs');

/** 建一个 runtime 并把假时钟往前拨，保证 lastUsed 严格递增。 */
function createRuntime(sid) {
  const rt = getRuntime(sid);
  fakeNow += 1000;
  return rt;
}

test('LRU: creating a 9th runtime destroys the least-recently-used one, the new one survives', () => {
  /** @type {Map<string, any>} */
  const created = new Map();
  for (let index = 1; index <= 9; index += 1) {
    created.set(`s${index}`, createRuntime(`s${index}`));
  }

  // 上限 8：s1（最久未用）必须被真销毁。
  assert.equal(created.get('s1').term.disposed, true, 'oldest runtime must be disposed');
  assert.equal(created.get('s1').es.closed, true, 'oldest runtime SSE must be closed');
  // 新建的 s9 必须存活——evictRuntimes 在 runtimes.set 之后调用，不能误伤新会话。
  assert.equal(created.get('s9').term.disposed, false, 'newest runtime must survive its own eviction');
  assert.equal(created.get('s8').term.disposed, false, 'second-newest runtime must survive');

  // 重新打开被淘汰的 s1：走"新建"路径，且把新的最久未用者（s2）淘汰掉。
  const revived = getRuntime('s1');
  fakeNow += 1000;
  assert.notEqual(revived, created.get('s1'), 'evicted runtime is gone from the table, a fresh one is built');
  assert.equal(revived.term.disposed, false);
  assert.equal(created.get('s2').term.disposed, true, 'after revival, s2 is now the oldest and gets evicted');
  assert.equal(created.get('s9').term.disposed, false, 's9 must still be alive');
});

test('LRU: touching an old runtime refreshes its recency and spares it from eviction', () => {
  // 接着上一个测试的表态：s1(复活)、s3..s9 共 8 个在表。
  const s3source = sources.find((source) => source.url.includes('sid=s3'));
  const s4source = sources.find((source) => source.url.includes('sid=s4'));
  assert.ok(s3source !== undefined && s4source !== undefined, 'fixture: s3/s4 streams exist');

  const touched = getRuntime('s3');
  fakeNow += 1000;
  assert.equal(touched.term.disposed, false);

  // s3 刚被 touch 过，现在建 s10 -> 应淘汰 s4（未 touch 的最久者），而不是 s3。
  const fresh = getRuntime('s10');
  fakeNow += 1000;
  assert.equal(fresh.term.disposed, false, 'newest runtime survives');
  assert.equal(s3source.closed, false, 'recently touched runtime must not be evicted');
  assert.equal(s4source.closed, true, 'the untouched oldest runtime is evicted instead (SSE closed)');
  assert.equal(sources.find((source) => source.url.includes('sid=s9')).closed, false, 's9 still alive');
});

test('runtimes keep their xterm DOM wrapper open (never disposed on the normal path)', () => {
  const rt = getRuntime('s5');
  // open() 只发生一次；wrapper 与 term 实例在同一 runtime 上长期存活。
  assert.notEqual(rt.term.openedInto, null, 'xterm.open was called into the runtime wrapper');
  assert.equal(rt.wrap.isConnected, false, 'wrapper starts detached; Terminal.jsx moves it in/out');
  const term = rt.term;
  const again = getRuntime('s5');
  assert.equal(again.term, term, 'same sid must return the very same xterm instance (no re-open)');
  assert.equal(term.disposed, false);
});

test('meta frame records the replay gap into state (P1-C client half)', () => {
  const rt = getRuntime('sMeta');
  const source = sources.find((item) => item.url.includes('sid=sMeta'));
  assert.ok(source !== undefined, 'fixture: sMeta stream exists');

  // 没有 meta 之前没有缺口记录。
  assert.equal(getState().gaps.sMeta, undefined);

  // 模拟 Host 发来的 meta 帧（P1-C 的 Wire 格式）。
  const meta = { truncated: true, firstSeq: 5, dropped: 4, since: 1 };
  for (const listener of source.listeners.meta ?? []) listener({ data: JSON.stringify(meta) });

  assert.deepEqual(getState().gaps.sMeta, meta, 'gap must reach module state so the host list can mark it');

  // 坏 JSON 不能把监听器炸掉。
  for (const listener of source.listeners.meta ?? []) listener({ data: 'not json' });
  assert.deepEqual(getState().gaps.sMeta, meta, 'malformed meta is ignored, previous gap stays');
});

test('successful reconnect resets the backoff counter (P2-2)', () => {
  const rt = getRuntime('sRetry');
  const source = sources.find((item) => item.url.includes('sid=sRetry'));
  assert.ok(source !== undefined, 'fixture: sRetry stream exists');

  // 断线一次：退避计数 +1。
  source.onerror();
  assert.equal(rt.retry, 1, 'an error bumps the backoff counter');

  // 重连成功（onopen）：计数归零，下次偶发断线从短退避开始。
  source.onopen();
  assert.equal(rt.retry, 0, 'onopen must reset the backoff counter');
});

// 收尾：还原 Date.now，避免污染同进程后续测试文件（node --test 每文件独立进程，双保险）。
test('cleanup: restore Date.now', () => {
  Date.now = realDateNow;
  assert.equal(Date.now(), realDateNow());
});

// ───────────────────────────────────────────────────────────────────────────
// M1：多标签 + 主机 CRUD + 上下文卡（T05 验收 1/2/3/4）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 装一个记录调用顺序的 fetch 桩（store 是唯一碰 fetch 的地方，所以桩住
 * globalThis.fetch 就等于桩住了整个客户端网络层）。
 * @param {(method: string, path: string, body: object|undefined) => ({status?: number, data?: object}|Promise<object>)} handler 应答函数。
 * @returns {{calls: string[], restore: () => void}} 调用记录与还原函数。
 */
function installFetch(handler) {
  /** @type {string[]} */
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = String(url);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push(`${method} ${path}`);
    const result = (await handler(method, path, body)) ?? {};
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.data ?? {},
    };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

test('tabs: one tab per session, kept in open order, newest activated', async () => {
  let counter = 0;
  const stub = installFetch((method, path) => {
    if (method === 'POST' && path.endsWith('/open')) {
      counter += 1;
      const sid = `tab${counter}`;
      return { data: { sid, session: { sid, host: { id: 'h1', label: 'box' }, status: 'open' } } };
    }
    return { data: { hosts: [], sessions: [] } };
  });
  try {
    await actions.openSession('h1');
    await actions.openSession('h1');
    await actions.openSession('h1');
  } finally {
    stub.restore();
  }

  assert.deepEqual(getState().tabs, ['tab1', 'tab2', 'tab3'], 'tabs preserve the order sessions were opened');
  assert.equal(getState().activeSid, 'tab3', 'the newest session becomes active');

  // 验收 1：一台主机开 3 个标签 → 3 份运行时，且切换标签不换实例。
  const runtimes = ['tab1', 'tab2', 'tab3'].map((sid) => getRuntime(sid));
  assert.ok(runtimeCount() >= 3, 'three sessions must own three runtimes');
  assert.equal(new Set(runtimes.map((rt) => rt.term)).size, 3, 'each session owns its own xterm instance');
  const firstTerm = runtimes[0].term;
  actions.setActiveSid('tab2');
  actions.setActiveSid('tab1');
  assert.equal(getRuntime('tab1').term, firstTerm, 'switching tabs must not rebuild the xterm instance');
});

test('tabs: closing a tab keeps the runtime alive and reuses the same instance', async () => {
  const stub = installFetch(() => ({ data: { ok: true } }));
  try {
    const before = getRuntime('tab2');
    const term = before.term;

    await actions.closeSession('tab2');
    assert.deepEqual(getState().tabs, ['tab1', 'tab3'], 'only the closed sid leaves the tab strip');
    // 验收 2：关标签 ≠ 关终端。runtime 与 SSE 都还在。
    assert.equal(before.term.disposed, false, 'closing a tab must NOT dispose the xterm instance');
    assert.equal(before.es.closed, false, 'the SSE stream stays open so output keeps buffering');
    assert.equal(getRuntime('tab2').term, term, 'reopening the session reuses the very same instance');

    // 关掉当前激活的标签：activeSid 必须纠正到幸存标签，不能留一个失效 sid。
    await actions.closeSession('tab3');
    assert.deepEqual(getState().tabs, ['tab1']);
    assert.equal(getState().activeSid, 'tab1', 'activeSid is corrected to a surviving tab');

    // 全部关光 -> null。
    await actions.closeSession('tab1');
    assert.deepEqual(getState().tabs, []);
    assert.equal(getState().activeSid, null);
  } finally {
    stub.restore();
  }
});

test('host form: the password field is always empty, edit mode included', async () => {
  const { t } = await import('../src/client/locales.js');

  actions.openForm('edit', {
    id: 'h1',
    label: 'box',
    host: '10.0.0.1',
    port: 2222,
    username: 'root',
    authKind: 'pass',
    hasSecret: true,
  });
  const form = getState().form;
  assert.equal(form.mode, 'edit');
  assert.equal(form.hostId, 'h1');
  assert.equal(form.values.label, 'box');
  assert.equal(form.values.port, '2222');
  assert.equal(form.values.username, 'root');
  // 验收 3：编辑时密码框 value 必须是 ''（秘密从不下发到客户端）。
  assert.equal(form.values.password, '', 'edit mode must never pre-fill the password');
  assert.equal(t('passwordKeepPlaceholder'), '留空保持不变', 'the edit-mode placeholder is the "leave blank to keep" copy');

  actions.setFormField('password', 'typed-secret');
  assert.equal(getState().form.values.password, 'typed-secret', 'typing still works');

  // 重新打开表单：任何残留都必须清掉，否则会把上一台的密码带进下一台。
  actions.openForm('create', null);
  assert.equal(getState().form.values.password, '');
  assert.equal(getState().form.values.port, '22');
  assert.equal(getState().form.mode, 'create');

  actions.closeForm();
  assert.equal(getState().form, null);
});

test('deleteHost: POST /close for every session happens before DELETE /hosts/<id>', async () => {
  let hostsPayload = {
    hosts: [
      { id: 'h9', label: 'box', host: '10.0.0.9', port: 22, username: 'root', authKind: 'pass', hasSecret: true, sid: 'tab9', status: 'open', error: null },
    ],
    sessions: [{ sid: 'tab9', host: { id: 'h9', label: 'box' }, status: 'open' }],
    activeSid: 'tab9',
  };
  const stub = installFetch((method, path) => {
    if (method === 'GET' && path.endsWith('/hosts')) return { data: hostsPayload };
    if (method === 'DELETE') {
      hostsPayload = { hosts: [], sessions: [], activeSid: null };
      return { data: { ok: true, closed: ['tab9'] } };
    }
    return { data: { ok: true, sid: 'tab9' } };
  });

  try {
    await actions.loadHosts();
    assert.deepEqual(getState().tabs, ['tab9'], 'the auto-opened session is adopted as the first tab');
    await actions.deleteHost('h9');
  } finally {
    stub.restore();
  }

  const closeIndex = stub.calls.indexOf('POST /api/dsh-ssh/close');
  const deleteIndex = stub.calls.indexOf('DELETE /api/dsh-ssh/hosts/h9');
  assert.ok(closeIndex !== -1, `expected a POST /close call, got: ${stub.calls.join(' | ')}`);
  assert.ok(deleteIndex !== -1, `expected a DELETE call, got: ${stub.calls.join(' | ')}`);
  // 验收 4：顺序断言 —— 先关会话，再删主机。
  assert.ok(closeIndex < deleteIndex, 'sessions must be closed before the host row is deleted');
  assert.ok(!getState().tabs.includes('tab9'), 'the deleted host loses its tab');
});

test('submitForm: PATCH omits auth when the secret is left blank, includes it when typed', async () => {
  /** @type {object[]} */
  const bodies = [];
  const stub = installFetch((method, path, body) => {
    if (method === 'PATCH' || (method === 'POST' && path.endsWith('/hosts'))) {
      bodies.push(body);
      return { data: { host: { id: 'h2' } } };
    }
    return { data: { hosts: [], sessions: [] } };
  });
  const editHost = {
    id: 'h2',
    label: 'box',
    host: '1.2.3.4',
    port: 22,
    username: 'root',
    authKind: 'pass',
    hasSecret: true,
  };
  try {
    // 1) 只改标签、密码留空 → 整个 auth 省略（Host 侧 ct 字节级不变）。
    actions.openForm('edit', editHost);
    assert.equal(await actions.submitForm(), true);
    assert.equal(bodies[0].auth, undefined, 'blank secret + unchanged kind must omit auth entirely');
    assert.equal(bodies[0].label, 'box');

    // 2) 填了新密码 → 必须带上，且只带 password。
    actions.openForm('edit', editHost);
    actions.setFormField('password', 'new-secret');
    assert.equal(await actions.submitForm(), true);
    assert.deepEqual(bodies[1].auth, { kind: 'pass', password: 'new-secret' });

    // 3) 认证方式改成免密 → 必须显式带 kind='none'（Host 据此删掉密文）。
    actions.openForm('edit', editHost);
    actions.setFormField('authKind', 'none');
    assert.equal(await actions.submitForm(), true);
    assert.deepEqual(bodies[2].auth, { kind: 'none' });

    // 4) 线上取值是短名 pass/key/none（长名会让 GET /hosts 响应体里出现
    //    "password" 字样，打红验收那条 grep）。旧值一律归一化成 pass。
    actions.openForm('create', null);
    assert.equal(getState().form.values.authKind, 'pass', 'new form defaults to the canonical kind');
    actions.setFormField('authKind', 'password');
    assert.equal(await actions.submitForm(), true);
    assert.deepEqual(bodies[3].auth, { kind: 'pass' }, 'legacy "password" is normalized to "pass"');

    // 私钥主机：编辑时表单必须认得出 key，才能显示私钥框而不是密码框。
    actions.openForm('edit', { ...editHost, authKind: 'key' });
    assert.equal(getState().form.values.authKind, 'key');
    actions.setFormField('privateKey', '-----BEGIN OPENSSH PRIVATE KEY-----');
    assert.equal(await actions.submitForm(), true);
    assert.deepEqual(bodies[4].auth, { kind: 'key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----' });
  } finally {
    stub.restore();
  }
  assert.equal(getState().form, null, 'a successful submit closes the dialog');
});

test('context card data degrades gracefully when /context is unavailable (M3)', async () => {
  const failing = installFetch(() => ({ status: 404, data: { error: 'not found', code: 'unknown-session' } }));
  try {
    await actions.loadContext('tabCtx', { force: true });
  } finally {
    failing.restore();
  }
  assert.equal(getState().contexts.tabCtx.status, 'unavailable', 'a missing endpoint must not throw');
  assert.equal(getState().contexts.tabCtx.data, null);

  const working = installFetch(() => ({
    data: { sid: 'tabCtx', host: 'box', status: 'open', tail: 'line1\nline2', gap: null },
  }));
  try {
    await actions.refreshContext('tabCtx');
  } finally {
    working.restore();
  }
  assert.equal(getState().contexts.tabCtx.status, 'ready');
  assert.equal(getState().contexts.tabCtx.data.tail, 'line1\nline2');
});

// ───────────────────────────────────────────────────────────────────────────
// M0 §2.5 边界 4：真 LRU 上限（QA Round 1 —— maxTabs 从死配置变成真约束）
//
// 三个不变量，缺一条就会出事：
// 1. 表不会无限增长（关标签保活 + 反复开关不同主机 = 泄漏）；
// 2. 有开着的标签的 runtime **绝不**销毁（正在看的终端变白不可接受）；
// 3. 被淘汰的 sid 重开时走"新建 + since=0 全量回放"的兜底路径。
// ───────────────────────────────────────────────────────────────────────────

/** 跨测试共享：LRU 测试里建出来的 runtime（sid -> runtime）。 */
let lruCreated = new Map();

test('LRU cap: tab-less runtimes are evicted oldest-first, tabbed ones are never touched', () => {
  // 假时钟抬到比真实时间还大：本测试新建的 runtime 一定比此前测试留下的新，
  // 于是"先淘汰历史遗留、再淘汰本次建的"这件事是确定的，断言不依赖 P 的值。
  let clock = 9_000_000_000_000;
  Date.now = () => clock;

  /** @type {Map<string, any>} */
  const created = new Map();
  /** term 实例 -> sid，用来把 dispose 调用还原成 sid。 */
  const sidByTerm = new Map();
  /** @type {any[]} 真实的销毁顺序。 */
  const disposeOrder = [];

  // 钩住替身的 dispose：只有这样才能断言"淘汰顺序"，而不是只看最终谁死了。
  const originalDispose = TerminalStub.prototype.dispose;
  TerminalStub.prototype.dispose = function patchedDispose() {
    disposeOrder.push(this);
    originalDispose.call(this);
  };

  try {
    for (let index = 1; index <= 12; index += 1) {
      const sid = `k${index}`;
      // k5..k12 开着标签；k1..k4 是"关掉了标签、runtime 仍按设计保活"的那些。
      if (index >= 5) actions.ensureTab(sid);
      const rt = getRuntime(sid);
      created.set(sid, rt);
      sidByTerm.set(rt.term, sid);
      clock += 1000;
    }
  } finally {
    TerminalStub.prototype.dispose = originalDispose;
  }
  lruCreated = created;

  // 验收 1：12 个 runtime、其中 8 个有标签 -> 表收敛到 8，多的 4 个被真销毁。
  assert.equal(runtimeCount(), MAX_KEPT_RUNTIMES, 'the runtimes table must converge to the cap');
  for (const sid of ['k5', 'k6', 'k7', 'k8', 'k9', 'k10', 'k11', 'k12']) {
    const rt = created.get(sid);
    assert.equal(rt.term.disposed, false, `${sid} has an open tab: it must never be disposed`);
    assert.equal(rt.es.closed, false, `${sid} SSE must stay open (its tab is visible)`);
  }
  for (const sid of ['k1', 'k2', 'k3', 'k4']) {
    const rt = created.get(sid);
    assert.equal(rt.term.disposed, true, `${sid} is tab-less and over the cap: must be disposed`);
    // 只从 Map 里删是不够的：SSE 长连接和 xterm 的 DOM 都要真的收掉。
    assert.equal(rt.es.closed, true, `${sid} SSE must be closed (no leaked long connection)`);
  }

  // 验收 4：淘汰顺序 = lastUsed 升序（最近用过的最后被淘汰）。
  const order = disposeOrder.map((term) => sidByTerm.get(term)).filter((sid) => sid !== undefined);
  assert.deepEqual(order, ['k1', 'k2', 'k3', 'k4'], 'eviction order must be oldest-first (LRU)');
});

test('LRU cap: a destroyed session reopens as a brand new runtime replaying from since=0', async () => {
  let clock = 9_100_000_000_000;
  Date.now = () => clock;

  // 腾一个位置：关掉 k5 的标签（它的 runtime 随即变成可淘汰候选）。
  const stub = installFetch(() => ({ data: { ok: true } }));
  try {
    await actions.closeSession('k5');
  } finally {
    stub.restore();
  }
  assert.equal(getState().tabs.includes('k5'), false, 'fixture: k5 tab is closed');

  const old = lruCreated.get('k1');
  assert.equal(old.term.disposed, true, 'fixture: k1 was evicted by the previous test');

  const fresh = getRuntime('k1');
  clock += 1000;

  // 验收 3：新 runtime、新 xterm 实例，SSE 从 since=0 全量回放（兜底路径）。
  assert.notEqual(fresh, old, 'an evicted session must be rebuilt, not resurrected');
  assert.notEqual(fresh.term, old.term, 'the xterm instance must be brand new');
  assert.equal(fresh.term.disposed, false, 'the rebuilt runtime is alive');
  assert.equal(fresh.seq, 0, 'the replay cursor restarts at 0');
  const k1Source = sources.filter((source) => source.url.includes('sid=k1')).at(-1);
  assert.ok(k1Source !== undefined, 'the rebuilt runtime must open a new SSE stream');
  assert.ok(k1Source.url.includes('since=0'), `full replay must start at since=0, got: ${k1Source.url}`);
  assert.equal(runtimeCount(), MAX_KEPT_RUNTIMES, 'rebuilding must evict a tab-less runtime to stay at the cap');
});

test('LRU cap: with more tabs than the cap, visible runtimes are never destroyed (overshoot allowed)', async () => {
  let clock = 9_200_000_000_000;
  Date.now = () => clock;

  // 把 k6..k12 的标签也关掉：它们的 runtime 仍保活，成为可淘汰候选。
  const stub = installFetch(() => ({ data: { ok: true } }));
  try {
    for (const sid of ['k6', 'k7', 'k8', 'k9', 'k10', 'k11', 'k12']) await actions.closeSession(sid);
  } finally {
    stub.restore();
  }
  assert.deepEqual(getState().tabs, [], 'fixture: no tab is open');

  /** @type {Map<string, any>} */
  const created = new Map();
  try {
    for (let index = 1; index <= 9; index += 1) {
      const sid = `m${index}`;
      actions.ensureTab(sid);
      const rt = getRuntime(sid);
      created.set(sid, rt);
      clock += 1000;
    }
  } finally {
    Date.now = realDateNow;
  }

  // 验收 2：9 个标签都开着 -> 允许超到 9，但一个可见终端都不许销毁。
  assert.equal(getState().tabs.length, 9, 'fixture: nine tabs are open');
  assert.equal(runtimeCount(), 9, 'all tab-less runtimes are gone, only the 9 visible ones remain');
  for (const [sid, rt] of created) {
    assert.equal(rt.term.disposed, false, `${sid} has an open tab: destroying it would blank a visible terminal`);
    assert.equal(rt.es.closed, false, `${sid} SSE must stay open`);
  }
  // 代价：候选集被抽干后，先前那些 tab-less 的 runtime 全被淘汰了。
  for (const sid of ['k6', 'k7', 'k8', 'k9', 'k10', 'k11', 'k12']) {
    assert.equal(lruCreated.get(sid).term.disposed, true, `${sid} was tab-less and had to go`);
  }
});
