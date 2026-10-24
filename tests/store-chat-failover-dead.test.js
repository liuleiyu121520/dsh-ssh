/**
 * "所有通道都坏"的回归：不许在两个坏通道之间来回弹。
 *
 * 换通道后会自动重发一次；如果新通道也失败，回避表里就有两个通道了，
 * `pickHealthy` 的最后一级会把坏通道还回来——不设防的话就会 A→B→A→B
 * 无限切换（每次都配一条 toast），比原地报错更糟。
 *
 * 契约：候选本身在回避表里 → 不切，原地报错（错误里带通道前缀，用户自己
 * 决定换哪个）；自动重发最多一次。
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

const disk = new Map();
globalThis.localStorage = {
  getItem: (key) => (disk.has(key) ? disk.get(key) : null),
  setItem: (key, value) => { disk.set(key, String(value)); },
  removeItem: (key) => { disk.delete(key); },
  clear: () => { disk.clear(); },
};

const PROVIDERS = [
  { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' }] },
  { id: 'our-free-model', name: 'Our Free Model', models: [{ id: 'z-ai/glm-5.3', label: 'GLM 5.3' }] },
];

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

/** 每一次 /chat 都失败，错误里回显本次用的通道（模拟真机的前缀）。 */
let chatCalls = 0;
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
      json: async () => ({ available: true, providers: PROVIDERS, default: { provider: '', model: '' } }),
    };
  }
  if (target.includes('/api/dsh-ssh/chat')) {
    chatCalls += 1;
    const body = JSON.parse(String(init.body ?? '{}'));
    const provider = String(body.provider ?? '');
    const model = String(body.model ?? '');
    return {
      ok: true,
      status: 200,
      body: frames([
        { type: 'accepted' },
        { type: 'model', provider, model },
        { type: 'error', code: 'TRANSPORT', message: `[${provider} / ${model}] DeepSeek Messages transport failed` },
      ]),
    };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { actions, getState } = await import('../src/client/store.js');

test('两个通道都坏时只自动重发一次，不在两个坏通道之间来回弹', async () => {
  await actions.loadHosts();
  await actions.loadLlm();

  await actions.sendChat('看看 nginx 部署的站点');

  assert.equal(chatCalls, 2, '首次 + 一次自动重发，不能再多');
  const state = getState();
  assert.equal(state.llm.picked.provider, 'our-free-model', '停在最后试过的那个通道上');
  assert.deepEqual(
    JSON.parse(disk.get('dsh-ssh:chatAvoid')).sort(),
    ['deepseek-account', 'our-free-model'],
    '两条坏通道都要进回避表',
  );
  assert.match(state.chats.s1.error, /our-free-model/, '错误要指向真正失败的那个通道');
  assert.equal(state.chats.s1.streaming, false, '收尾后不能还挂在流式中');
});
