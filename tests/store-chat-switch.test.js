/**
 * 通道失败的自动切换回归：**必须换到"另一个"通道**。
 *
 * 2026-10-24 真机截图：右栏选 DeepSeek-V4.1-Flash（deepseek-account）→
 * `[deepseek-account / deepseek-flash] DeepSeek Messages transport failed`，
 * 而模型下拉**纹丝不动**、也没有任何提示。原因是 pickHealthy 只过滤
 * `unavailable` 标记，而 deepseek-account 恰好是清单里第一个——"自动切换"
 * 于是把用户从坏通道切到同一个坏通道，`healthy === picked` 让整段逻辑空转。
 *
 * 修好后的契约：
 * 1. 失败的通道进回避表（内存 + localStorage，重启也记得）；
 * 2. 自动切到清单里第一个**不同的**可用通道，并写回 localStorage；
 * 3. 重新挂载（loadLlm）时不再把坏通道恢复成默认选择；
 * 4. 用户手动选回它 → 视为"愿意再试"，从回避表里放出来。
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

/** 内存版 localStorage（Node 默认没有；store 的持久化要靠它）。 */
const disk = new Map();
globalThis.localStorage = {
  getItem: (key) => (disk.has(key) ? disk.get(key) : null),
  setItem: (key, value) => { disk.set(key, String(value)); },
  removeItem: (key) => { disk.delete(key); },
  clear: () => { disk.clear(); },
};

/** 预置：用户之前选的就是那个坏通道。 */
disk.set('dsh-ssh:chatModel', JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-flash' }));

/** 两个通道：第一个是"官方账号通道"（调用会失败），第二个是能用的。 */
const PROVIDERS = [
  { id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' }] },
  { id: 'our-free-model', name: 'Our Free Model', models: [{ id: 'z-ai/glm-5.3', label: 'GLM 5.3' }] },
];

/**
 * 造一帧到底的 SSE 响应体。
 * @param {object[]} events 事件。
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

/** /chat 被调用了几次（1 = 首次，2 = 换通道后的自动重发）。 */
let chatCalls = 0;

globalThis.fetch = async (url) => {
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
      json: async () => ({ available: true, providers: PROVIDERS, default: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
    };
  }
  if (target.includes('/api/dsh-ssh/chat')) {
    chatCalls += 1;
    // 第一次：真机上的那一帧（transport failed，带通道前缀）。
    if (chatCalls === 1) {
      return {
        ok: true,
        status: 200,
        body: frames([
          { type: 'accepted' },
          { type: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
          { type: 'error', code: 'TRANSPORT', message: '[deepseek-account / deepseek-flash] DeepSeek Messages transport failed' },
        ]),
      };
    }
    // 第二次（换通道后的自动重发）：新通道正常回答。
    return {
      ok: true,
      status: 200,
      body: frames([
        { type: 'accepted' },
        { type: 'model', provider: 'our-free-model', model: 'z-ai/glm-5.3' },
        { type: 'text', text: 'nginx 站点在 /etc/nginx/conf.d。' },
        { type: 'finish', reason: 'stop' },
      ]),
    };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { actions, getState } = await import('../src/client/store.js');

test('通道调用失败后必须切到另一个通道，并记住别再选它', async () => {
  await actions.loadHosts();
  await actions.loadLlm();
  assert.equal(getState().llm.picked.provider, 'deepseek-account', '初始应恢复本地选择');

  await actions.sendChat('看看 nginx 部署的站点');

  const after = getState();
  assert.equal(
    after.llm.picked.provider,
    'our-free-model',
    '失败后必须换到另一个通道（旧实现会挑回 deepseek-account，下拉纹丝不动）',
  );
  assert.equal(after.llm.picked.model, 'z-ai/glm-5.3');
  // 选择要写回本地，否则下次启动又回到坏通道。
  assert.deepEqual(JSON.parse(disk.get('dsh-ssh:chatModel')), { provider: 'our-free-model', model: 'z-ai/glm-5.3' });
  // 回避表落盘。
  assert.deepEqual(JSON.parse(disk.get('dsh-ssh:chatAvoid')), ['deepseek-account']);
  // 用户要被告知"已经换过了，重发一次"。
  assert.ok(after.toast !== null && String(after.toast.text).includes('z-ai/glm-5.3'), `应有切换提示，实际：${JSON.stringify(after.toast)}`);
  // 换通道后自动重发：用户不用手动再发一次，红字也不该留在气泡里。
  assert.equal(chatCalls, 2, '换通道后必须自动重发一次');
  assert.equal(after.chats.s1.error, null, '重发成功后错误条要消失');
  const answer = after.chats.s1.messages.at(-1);
  assert.match(String(answer.text), /nginx/, '重发要真的拿到新通道的回答');
});

test('重新挂载时不会把回避表里的通道恢复成默认', async () => {
  // 模拟"重启 app"：本地记着坏通道，但回避表也在。
  disk.set('dsh-ssh:chatModel', JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-flash' }));
  await actions.loadLlm();
  assert.equal(getState().llm.picked.provider, 'our-free-model', '回避表里的通道不能再被自动选中');
});

test('用户手动选回坏通道 = 愿意再试，从回避表放出', async () => {
  actions.setChatModel('deepseek-account', 'deepseek-flash');
  assert.equal(getState().llm.picked.provider, 'deepseek-account');
  assert.deepEqual(JSON.parse(disk.get('dsh-ssh:chatAvoid')), [], '手动选择应清掉该通道的回避记录');
});
