#!/usr/bin/env node
/**
 * 对话链路端到端验证：真实 HTTP + 真实路由 + 真实 chat 服务 + 真实 llm 包
 * （假 adapter 当模型）+ 真实 ssh2 会话。
 *
 * 覆盖单测到不了的那一层：SSE 帧格式、/chat/exec 前缀路由、模型挑选、
 * marker 捕获在**真 ssh 会话**上的表现。
 *
 * 用法（口令走环境变量，绝不落文件）：
 *   E2E_PASSWORD='***' node scripts/chat-e2e.mjs
 *   E2E_HOST=120.53.14.173 E2E_PORT=22 E2E_USER=root E2E_PASSWORD='***' node scripts/chat-e2e.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

const HARNESS_ROOT = process.env.DSH_HARNESS_ROOT ?? '/Users/leiyu/code/pre-study/deepseek-harness';
const P = join(HARNESS_ROOT, 'packages');
const PLUGIN_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const E2E_HOST = process.env.E2E_HOST ?? '120.53.14.173';
const E2E_PORT = Number(process.env.E2E_PORT ?? 22);
const E2E_USER = process.env.E2E_USER ?? 'root';
const E2E_PASSWORD = process.env.E2E_PASSWORD ?? '';

/** 断言结果表。 */
const results = [];
/**
 * 记一条断言。
 * @param {string} name 名称。
 * @param {boolean} ok 是否通过。
 * @param {string} [detail] 失败细节。
 */
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === '' ? '' : `\n      ↳ ${detail}`}`);
}

/** 等一个条件成立（轮询）。
 * @param {string} what 描述。
 * @param {() => Promise<boolean>} probe 探针。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<boolean>} 是否等到。
 */
async function waitFor(what, probe, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await probe()) return true;
    } catch {
      // 探测本身失败（连接拒绝等）：继续等。
    }
    if (Date.now() > deadline) {
      console.log(`      (等待超时: ${what})`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** 读 SSE 流，把事件收成数组。
 * @param {string} url 地址。
 * @param {object} init fetch init。
 * @returns {Promise<object[]>} 事件数组。
 */
async function readSse(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  /** @type {object[]} */
  const events = [];
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (frame.startsWith('data: ')) {
        try {
          events.push(JSON.parse(frame.slice(6)));
        } catch {
          // 半包：丢。
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }
  return events;
}

/** JSON 请求。
 * @param {string} url 地址。
 * @param {object} [init] fetch init。
 * @returns {Promise<{status: number, body: object}>} 响应。
 */
async function jsonRequest(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    // 空体。
  }
  return { status: response.status, body };
}

/** 假 adapter 的剧本：第 N 次调用返回第 N 轮（越界重复最后一轮）。 */
const script = [
  // 第一轮：文本 + 一个 run_command 工具调用。
  async function* round1() {
    yield { type: 'text-delta', index: 0, text: '先看看根分区：' };
    yield { type: 'tool-call-delta', index: 1, id: 'e2e-call-1', name: 'run_command', argumentsDelta: '{"command":"df -h /"}' };
    yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'e2e-call-1', name: 'run_command', arguments: '{"command":"df -h /"}' } };
    yield { type: 'finish', reason: 'tool_calls' };
  },
  // 第二轮：拿到工具结果后的文本收尾。
  async function* round2() {
    yield { type: 'text-delta', index: 0, text: '根分区上面就是这些，结论自己看。' };
    yield { type: 'finish', reason: 'stop' };
  },
];

/** 假 adapter：满足 llm 包 registerAdapter 契约的最小实现。 */
const fakeAdapter = {
  calls: 0,
  providerInfo: (provider) => ({ id: provider, name: 'E2E Fake' }),
  providerRetryPolicy: () => undefined,
  imageRequestPricing: () => undefined,
  listModels: async (provider) => [{ provider, id: 'e2e-model', name: 'E2E Model' }],
  resolveModel: async (provider, model) => ({ provider, id: model, name: model }),
  prepareCall: async (provider, model) => {
    const round = script[Math.min(fakeAdapter.calls, script.length - 1)];
    fakeAdapter.calls += 1;
    return {
      model: { provider, id: model, name: model },
      stream: (options) => round(options),
    };
  },
};

async function main() {
  if (E2E_PASSWORD === '') {
    console.error('缺少 E2E_PASSWORD 环境变量（真机 ssh 口令，不落文件）');
    process.exit(2);
  }
  const dshHome = await mkdtemp(join(os.tmpdir(), 'dsh-ssh-chat-e2e-'));
  const [cordis, web, storage, json, domain, cred, llm] = await Promise.all([
    import(join(HARNESS_ROOT, 'vendor/cordis/lib/index.js')),
    import(join(P, 'host/webserver/lib/index.js')),
    import(join(P, 'storage/storage/lib/index.js')),
    import(join(P, 'storage/storage-json/lib/index.js')),
    import(join(P, 'storage/storage-domain/lib/index.js')),
    import(join(P, 'credentials/credentials-local/lib/index.js')),
    import(join(P, 'llm/llm/lib/index.js')),
  ]);
  const { apply } = await import(join(PLUGIN_ROOT, 'lib/index.js'));

  const ctx = new cordis.Context();
  ctx.provide('connection', { requestRejection: () => undefined });
  await ctx.plugin(web.WebServer, { host: '127.0.0.1', port: 0 });
  await ctx.plugin(storage.Storage, {});
  // 真 storage-json 插件：inject ['storage']，provide storage.json 服务键——
  // storage-domain 的 backend:'json' 等的就是它（手动往 hub 注册不够）。
  await ctx.plugin({ name: json.name, inject: json.inject, apply: json.apply }, { root: join(dshHome, 'storages') });
  await ctx.plugin(cred.LocalCredentialProvider, { dshHome, watch: false });
  // storage-domain 是 ESM 命名导出（apply/inject/name），cordis 不认命名空间，
  // 摊成普通插件对象再挂（与真 dsh 的装载形状一致）。
  await ctx.plugin({ name: domain.name, inject: domain.inject, apply: domain.apply }, { backend: 'json' });
  await ctx.plugin(llm.default, {});
  ctx.llm.registerAdapter(['e2e'], fakeAdapter);

  const dispose = await apply(ctx, { autoOpenFirst: false, chat: {} });
  await dispose.ready;
  const origin = ctx.webServer.getOrigin();
  const base = `${origin}/api/dsh-ssh`;
  console.log(`\n[e2e] WebServer ${origin}\n`);

  try {
    // 1) 对话半挂上：/llm 可用且看得到 e2e provider。
    const llmReady = await waitFor('chat half mounted', async () => {
      const res = await jsonRequest(`${base}/llm`);
      return res.status === 200 && res.body.available === true;
    });
    check('GET /llm 可用且列出 e2e provider', llmReady);
    if (!llmReady) return;
    const llmInfo = await jsonRequest(`${base}/llm`);
    check('e2e provider 的模型在清单里', (llmInfo.body.providers ?? []).some((row) => row.id === 'e2e'
      && (row.models ?? []).some((model) => model.id === 'e2e-model')));

    // 2) 建主机 + 开会话（真 ssh2）。
    const created = await jsonRequest(`${base}/hosts`, {
      method: 'POST',
      body: JSON.stringify({
        label: 'e2e-chat',
        host: E2E_HOST,
        port: E2E_PORT,
        username: E2E_USER,
        auth: { kind: 'password', password: E2E_PASSWORD },
      }),
    });
    check('POST /hosts 201', created.status === 201, JSON.stringify(created.body));
    if (created.status !== 201) return;
    const hostId = created.body.host?.id ?? '';
    const opened = await jsonRequest(`${base}/open`, { method: 'POST', body: JSON.stringify({ hostId }) });
    check('POST /open 200', opened.status === 200, JSON.stringify(opened.body));
    if (opened.status !== 200) return;
    const sid = opened.body.sid;
    const connected = await waitFor('ssh session open', async () => {
      const res = await jsonRequest(`${base}/hosts`);
      return (res.body.sessions ?? []).some((session) => session.sid === sid && session.status === 'open');
    }, 20000);
    check('会话状态到 open（真 ssh2 连通）', connected);
    if (!connected) return;

    // 3) 人工确认回合：文本 + 工具调用暂停，不执行。
    const turn1 = await readSse(`${base}/chat`, {
      method: 'POST',
      body: JSON.stringify({
        sid,
        autoExecute: false,
        provider: 'e2e',
        model: 'e2e-model',
        messages: [{ role: 'user', content: '看看磁盘' }],
      }),
    });
    const types1 = turn1.map((event) => event.type);
    check('第一轮事件序列 = model/text/tool-call/finish',
      JSON.stringify(types1) === JSON.stringify(['model', 'text', 'tool-call', 'finish']),
      JSON.stringify(types1));
    const call = turn1.find((event) => event.type === 'tool-call');
    check('工具调用是 df -h / 且带 arguments', call?.command === 'df -h /' && typeof call?.arguments === 'string');
    check('人工确认模式 finish.reason = tool-call', turn1.at(-1)?.reason === 'tool-call');

    // 4) 手动执行一条命令（/chat/exec，marker 捕获）。
    const markerText = `dsh-chat-e2e-${Date.now()}`;
    const exec1 = await jsonRequest(`${base}/chat/exec`, {
      method: 'POST',
      body: JSON.stringify({ sid, command: `echo ${markerText}` }),
    });
    check('POST /chat/exec 执行 echo 成功', exec1.status === 200 && exec1.body.ok === true
      && String(exec1.body.output).includes(markerText),
      `status=${exec1.status} ok=${exec1.body.ok} timedOut=${exec1.body.timedOut} output=${JSON.stringify(exec1.body.output).slice(0, 600)}`);

    // 5) 带工具结果续跑：模型第二轮文本收尾。
    const turn2 = await readSse(`${base}/chat`, {
      method: 'POST',
      body: JSON.stringify({
        sid,
        autoExecute: false,
        provider: 'e2e',
        model: 'e2e-model',
        messages: [
          { role: 'user', content: '看看磁盘' },
          { role: 'assistant', content: [{ type: 'text', text: '先看看根分区：' }, { type: 'tool-call', id: 'e2e-call-1', name: 'run_command', arguments: '{"command":"df -h /"}' }] },
          { role: 'tool', toolCallId: 'e2e-call-1', content: exec1.body.output ?? '', isError: false },
          { role: 'user', content: '继续' },
        ],
      }),
    });
    const types2 = turn2.map((event) => event.type);
    check('续跑事件序列 = model/text/finish',
      JSON.stringify(types2) === JSON.stringify(['model', 'text', 'finish']),
      JSON.stringify(types2));
    check('续跑 finish.reason = stop', turn2.at(-1)?.reason === 'stop');

    // 6) 未知 provider 回退到 e2e（挑选逻辑在真链路上再验一次）。
    const turn3 = await readSse(`${base}/chat`, {
      method: 'POST',
      body: JSON.stringify({
        sid,
        autoExecute: false,
        provider: 'no-such',
        model: 'no-such',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    check('未知 provider 回退到 e2e/e2e-model',
      turn3[0]?.type === 'model' && turn3[0]?.provider === 'e2e' && turn3[0]?.model === 'e2e-model',
      JSON.stringify(turn3[0]));
  } finally {
    try {
      await dispose();
    } catch {
      // 卸载失败不影响结论。
    }
    await rm(dshHome, { recursive: true, force: true });
  }

  const failed = results.filter((row) => !row.ok);
  console.log(`\n[e2e] ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[e2e] 未预期异常: ${error?.stack ?? error}`);
  process.exit(1);
});
