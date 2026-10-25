/**
 * 对话服务的 node --test 测试。
 *
 * 三层覆盖：
 * 1. 纯函数（stripAnsi / normalizeHistory）；
 * 2. executeInSession 的 marker 捕获（fake transport 当 shell 模拟器）；
 * 3. createChatService.runTurn 的模型轮循环（假 llm + 假 shell）：
 *    人工确认暂停、自动执行续跑、模型挑选回退、无 llm 降级。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SshSessionService } from '../src/sessions.js';
import { createFakeTransport } from '../src/transport.js';
import { createChatService, normalizeHistory, stripAnsi } from '../src/chat.js';

/** 本机测试主机。 */
const LOCAL_HOST = { id: 'local', label: '本机', host: '127.0.0.1', port: 22, username: 'tester' };

/**
 * 造一个"shell 模拟器"会话服务：send 的内容经 handler 决定回显什么。
 * @param {(data: string, echo: (out: string) => void) => void} handler 回显策略。
 * @returns {{service: SshSessionService, created: object[]}} 服务与 transport 实例表。
 */
function makeShellService(handler) {
  /** @type {object[]} */
  const created = [];
  const service = new SshSessionService({
    createTransport: (config, handlers) => {
      const transport = createFakeTransport(config, handlers);
      const originalSend = transport.send.bind(transport);
      transport.send = (data) => {
        originalSend(data);
        handler(Buffer.isBuffer(data) ? data.toString('utf8') : String(data), (out) => transport.emit(out));
      };
      created.push(transport);
      return transport;
    },
  });
  return { service, created };
}

/**
 * 标准 shell：载荷是单行 `<command>; printf marker "\0"`，收到含
 * printf 的行时回显输出 + 退出码行（与真 shell 的顺序执行一致）。
 * @param {string} output 命令输出。
 * @param {number} [code] 退出码。
 * @returns {(data: string, echo: (out: string) => void) => void} handler。
 */
function shellWith(output, code = 0) {
  return (data, echo) => {
    const match = data.match(/printf '%s %s\\n' '(__DSH_[0-9a-f]+__)'/);
    if (match !== null) echo(`${output}\n${match[1]} ${code}\n`);
  };
}

/**
 * 假 llm：按剧本依次返回各"模型轮"的 chunk 流。
 *
 * 严格模拟真 runtime 的 `prepareCall().stream()` 契约：
 * - prepareCall 物化出默认配置（这里固定 reasoningEffort:'high'，对应真
 *   adapter 给 GLM-5.3 物化 effort 的行为）；
 * - stream 入参的 provider/model/reasoningEffort/temperature/maxTokens/stop
 *   必须与 config 一致，否则抛 INVALID_PREPARED_CALL——
 *   2026-10-24 真机就是这样炸的（只传 provider+model，漏了物化默认值）。
 */
function makeFakeLlm(rounds, providers = [{ id: 'p1', name: 'P1' }], models = [{ id: 'm1', label: 'M1' }]) {
  let call = 0;
  return {
    listProviders: () => providers,
    // models 可以是数组（所有 provider 共用）或函数（按 provider 出模型）。
    listModels: async (provider) => (typeof models === 'function' ? models(provider) : models),
    prepareCall: async (config) => {
      if (providers.some((row) => row.id === config.provider) === false) {
        throw new Error(`unknown provider "${config.provider}"`);
      }
      const round = rounds[Math.min(call, rounds.length - 1)];
      call += 1;
      const resolved = { provider: config.provider, model: config.model, reasoningEffort: 'high' };
      return {
        config: resolved,
        stream: (options) => {
          for (const key of ['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens']) {
            if (options[key] !== resolved[key]) {
              throw new Error(
                `prepared LLM call config changed before adapter dispatch (${key}: ${String(options[key])} != ${String(resolved[key])})`,
              );
            }
          }
          return round();
        },
      };
    },
    calls: () => call,
  };
}

/** 文本收尾轮。 */
function* textRound() {
  yield { type: 'text-delta', index: 0, text: '磁盘还有一半空间' };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** 工具调用轮（run_command df -h）。 */
function* toolRound() {
  yield { type: 'text-delta', index: 0, text: '先看看磁盘：' };
  yield {
    type: 'tool-call-delta',
    index: 1,
    id: 'call-1',
    name: 'run_command',
    argumentsDelta: '{"command":"df -h"}',
  };
  yield {
    type: 'block-end',
    index: 1,
    block: { type: 'tool-call', id: 'call-1', name: 'run_command', arguments: '{"command":"df -h"}' },
  };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

/** 错误收尾轮：真 adapter 的失败形状（对象 reason + failure）。 */
function* errorRound() {
  yield { type: 'text-delta', index: 0, text: '半句话' };
  yield {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: { message: 'our free model does not serve "glm-5.3" on this egress', code: 'SERVER' },
    },
  };
}

/** 空响应轮：只有 finish，没有任何文本/工具（模型不可用时的静默形态）。 */
function* emptyRound() {
  yield { type: 'finish', reason: { kind: 'stop' } };
}

// ── 纯函数 ────────────────────────────────────────────────────────────

test('stripAnsi removes CSI/OSC/control sequences but keeps newlines and tabs', () => {
  const raw = '\x1b[32mgreen\x1b[0m\n\x1b]0;title\x07plain\tend\x07';
  assert.equal(stripAnsi(raw), 'green\nplain\tend');
  // 未着色的普通文本原样返回。
  assert.equal(stripAnsi('hello\nworld'), 'hello\nworld');
  assert.equal(stripAnsi(undefined), '');
});

test('normalizeHistory drops invalid shapes and keeps tool-call blocks', () => {
  const history = normalizeHistory([
    { role: 'user', content: '看看磁盘' },
    // system 一律丢弃：Host 每轮现场重建 system（含最新终端尾部）。
    { role: 'system', content: 'stale system prompt' },
    { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool-call', id: 'c1', name: 'run_command', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'c1', content: 'output', isError: false },
    { role: 'tool', content: 'no call id -> dropped' },
    { role: 'bogus', content: 'dropped' },
    null,
    'string-dropped',
  ], { provider: 'p1', model: 'm1' });
  assert.equal(history.length, 3);
  // content 一律是块数组（DeepSeek 序列化器会对它调 flatMap）。
  assert.deepEqual(history[0], { role: 'user', content: [{ type: 'text', text: '看看磁盘' }] });
  assert.equal(history[1].content.length, 2);
  assert.equal(history[1].content[1].type, 'tool-call');
  // assistant 必须带 source：真 runtime 的 forAdapter 会读 source.replayState，
  // 缺了会被包装成"模型静默结束"（2026-10-24 真机 E2E 实测）。
  assert.deepEqual(history[1].source, { kind: 'model', provider: 'p1', model: 'm1' });
  assert.deepEqual(history[2], { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'output' }], isError: false });
});

test('normalizeHistory caps length and drops system messages', () => {
  const many = [];
  for (let index = 0; index < 40; index += 1) many.push({ role: 'user', content: `m${index}` });
  many.unshift({ role: 'system', content: 'stale' });
  const history = normalizeHistory(many);
  assert.equal(history.length, 30);
  assert.deepEqual(history[0].content, [{ type: 'text', text: 'm10' }]);
  assert.deepEqual(history.at(-1).content, [{ type: 'text', text: 'm39' }]);
});

// ── executeInSession：marker 捕获 ─────────────────────────────────────

test('executeInSession captures command output and strips the marker line', async () => {
  const { service } = makeShellService(shellWith('Filesystem Size Used\n/dev/disk1s1 500G 200G'));
  service.open({ host: LOCAL_HOST });
  const chat = createChatService({ service, llm: null });
  const outcome = await chat.executeInSession({ sid: 's1', command: 'df -h', timeoutMs: 2000 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.output, 'Filesystem Size Used\n/dev/disk1s1 500G 200G');
  // marker 绝不泄漏进输出。
  assert.equal(outcome.output.includes('__DSH_'), false);
});

test('executeInSession reports non-zero exit codes as failure', async () => {
  const { service } = makeShellService(shellWith('no such file', 1));
  service.open({ host: LOCAL_HOST });
  const chat = createChatService({ service, llm: null });
  const outcome = await chat.executeInSession({ sid: 's1', command: 'ls /nope', timeoutMs: 2000 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.output, 'no such file');
});

test('executeInSession times out interactive commands with Ctrl+C and partial output', async () => {
  /** @type {string[]} */
  const echoed = [];
  const { service, created } = makeShellService((data, echo) => {
    echoed.push(data);
    // 交互式命令：只回显一行，然后装死（没有 marker 行）。
    if (data.startsWith('top;')) echo('top - 12:00:00 up 3 days\n');
  });
  service.open({ host: LOCAL_HOST });
  const chat = createChatService({ service, llm: null });
  const outcome = await chat.executeInSession({ sid: 's1', command: 'top', timeoutMs: 250 });
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.ok, false);
  assert.match(outcome.output, /top - 12:00:00/);
  // 超时后必须发过 Ctrl+C（\x03）。
  const sentText = Buffer.concat(created[0].sent).toString('utf8');
  assert.equal(sentText.includes('\x03'), true);
});

test('executeInSession rejects exited and unknown sessions', async () => {
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  // 远端自己退出（不是 close）：记录还在表里，状态是 closed。
  service.get('s1').status = 'closed';
  const chat = createChatService({ service, llm: null });
  await assert.rejects(() => chat.executeInSession({ sid: 's1', command: 'ls', timeoutMs: 500 }), /closed/);
  await assert.rejects(() => chat.executeInSession({ sid: 's404', command: 'ls', timeoutMs: 500 }), /unknown session/);
});

// ── runTurn：模型轮循环 ───────────────────────────────────────────────

test('runTurn pauses at tool calls in manual-confirm mode without executing', async () => {
  const { service, created } = makeShellService(shellWith('should not run'));
  service.open({ host: LOCAL_HOST });
  const llm = makeFakeLlm([toolRound, textRound]);
  const chat = createChatService({ service, llm });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '磁盘呢' }],
    autoExecute: false,
    onEvent: (event) => events.push(event),
  });
  const types = events.map((event) => event.type);
  assert.deepEqual(types, ['accepted', 'model', 'text', 'tool-call', 'finish']);
  assert.deepEqual(events[1], { type: 'model', provider: 'p1', model: 'm1' });
  const call = events[3];
  assert.equal(call.command, 'df -h');
  assert.equal(call.arguments, '{"command":"df -h"}');
  assert.equal(events[4].reason, 'tool-call');
  // 人工确认：PTY 里不该出现这条命令。
  assert.equal(Buffer.concat(created[0].sent).toString('utf8').includes('df -h'), false);
});

test('runTurn auto-executes tool calls and continues until text finish', async () => {
  const { service, created } = makeShellService(shellWith('/dev/disk1s1 500G 200G'));
  service.open({ host: LOCAL_HOST });
  const llm = makeFakeLlm([toolRound, textRound]);
  const chat = createChatService({ service, llm });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '磁盘呢' }],
    autoExecute: true,
    onEvent: (event) => events.push(event),
  });
  const types = events.map((event) => event.type);
  // `round` = 轮边界：客户端据此把"正文 + 命令卡"与下一轮分开渲染，
  // 否则一个回合里所有正文会被拼在顶部、命令卡全堆在下面（2026-10-25）。
  assert.deepEqual(types, ['accepted', 'model', 'text', 'tool-call', 'tool-result', 'round', 'text', 'finish']);
  const result = events[4];
  assert.equal(result.ok, true);
  assert.match(result.output, /500G 200G/);
  assert.equal(events[5].type, 'round', '轮边界要落在 tool-result 之后、下一轮正文之前');
  assert.equal(events[7].reason, 'stop');
  // 命令确实写进了 PTY，且模型轮跑了两次（工具后续跑）。
  assert.equal(Buffer.concat(created[0].sent).toString('utf8').includes('df -h'), true);
  assert.equal(llm.calls(), 2);
});

test('runTurn falls back to the first available model when the requested one is unknown', async () => {
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  const chat = createChatService({ service, llm: makeFakeLlm([textRound]) });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: 'hi' }],
    autoExecute: false,
    provider: 'no-such-provider',
    model: 'no-such-model',
    onEvent: (event) => events.push(event),
  });
  const models = events.filter((event) => event.type === 'model');
  assert.deepEqual(models.at(-1), { type: 'model', provider: 'p1', model: 'm1' }, '未知通道要回退到清单里的健康通道');
});

test('runTurn prefers the patch-configured default when the request omits a model', async () => {
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  const chat = createChatService({
    service,
    llm: makeFakeLlm([textRound], [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], [{ id: 'm1', label: 'M1' }, { id: 'm2', label: 'M2' }]),
    config: { provider: 'p2', model: 'm2' },
  });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: 'hi' }],
    autoExecute: false,
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events[1], { type: 'model', provider: 'p2', model: 'm2' });
});

test('runTurn surfaces a clear error when the session does not exist', async () => {
  const { service } = makeShellService(shellWith('x'));
  const chat = createChatService({ service, llm: makeFakeLlm([textRound]) });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's404',
    messages: [{ role: 'user', content: 'hi' }],
    autoExecute: false,
    onEvent: (event) => events.push(event),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].code, 'unknown-session');
});

// ── describeModels：模型可用性 ────────────────────────────────────────

test('describeModels reports unavailable without the llm service', async () => {
  const { service } = makeShellService(shellWith('x'));
  const chat = createChatService({ service, llm: null });
  const info = await chat.describeModels();
  assert.equal(info.available, false);
  assert.equal(info.reason, 'llm-unavailable');
});

test('describeModels lists providers and models when llm is present', async () => {
  const { service } = makeShellService(shellWith('x'));
  const chat = createChatService({
    service,
    llm: makeFakeLlm([], [{ id: 'p1', name: 'Our Free Model' }], [{ id: 'm1', label: 'GLM 5.3' }]),
  });
  const info = await chat.describeModels();
  assert.equal(info.available, true);
  assert.equal(info.providers.length, 1);
  assert.equal(info.providers[0].name, 'Our Free Model');
  assert.deepEqual(info.providers[0].models, [{ id: 'm1', label: 'GLM 5.3' }]);
});

test('describeModels marks deepseek-account unavailable when signed out', async () => {
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  const chat = createChatService({
    service,
    llm: makeFakeLlm(
      [textRound],
      [{ id: 'deepseek-account', name: 'DeepSeek Account' }, { id: 'our-free-model', name: 'Our Free Model' }],
      (provider) => provider === 'deepseek-account'
        ? [{ id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash' }]
        : [{ id: 'z-ai/glm-5.3', label: 'GLM 5.3' }],
    ),
    account: () => ({ getState: async () => ({ status: 'signed-out' }) }),
  });
  const info = await chat.describeModels();
  assert.equal(info.available, true);
  const deepseek = info.providers.find((row) => row.id === 'deepseek-account');
  assert.equal(deepseek.unavailable, 'DeepSeek 未登录');
  // 默认挑选必须跳过未登录通道，落到可用通道上。
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: 'hi' }],
    autoExecute: false,
    onEvent: (event) => events.push(event),
  });
  const model = events.find((event) => event.type === 'model');
  assert.equal(model.provider, 'our-free-model');
  assert.equal(model.model, 'z-ai/glm-5.3');
});

test('describeModels does not mark anything when the account service is absent', async () => {
  const { service } = makeShellService(shellWith('x'));
  const chat = createChatService({
    service,
    llm: makeFakeLlm([], [{ id: 'deepseek-account', name: 'DeepSeek Account' }], [{ id: 'deepseek-flash', label: 'X' }]),
  });
  const info = await chat.describeModels();
  assert.equal(info.providers[0].unavailable, undefined);
});

test('runTurn refuses to start when history is empty', async () => {
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  const chat = createChatService({ service, llm: makeFakeLlm([textRound]) });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({ sid: 's1', messages: [], autoExecute: false, onEvent: (event) => events.push(event) });
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).code, 'empty-history');
});

test('runTurn surfaces the adapter failure message from an error finish', async () => {
  // 真 adapter 的 finish 是对象 {kind:'error', failure:{message, code}}；按字符串
  // 解析会把错误吞成 stop，用户看到"没反应"（2026-10-24 真机实测）。
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  const chat = createChatService({ service, llm: makeFakeLlm([errorRound]) });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '你好' }],
    autoExecute: false,
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events.map((event) => event.type), ['accepted', 'model', 'text', 'error']);
  const error = events.at(-1);
  assert.equal(error.code, 'SERVER');
  assert.match(error.message, /does not serve "glm-5.3"/);
});

test('runTurn reports an empty model response instead of staying silent', async () => {
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  const chat = createChatService({ service, llm: makeFakeLlm([emptyRound]) });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '你好' }],
    autoExecute: false,
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events.map((event) => event.type), ['accepted', 'model', 'error']);
  assert.equal(events.at(-1).code, 'empty-response');
});

test('runTurn echoes the prepared config back into stream options', () => {
  // 直接验契约：makeFakeLlm 的 stream 会因 config 不一致抛
  // INVALID_PREPARED_CALL；旧实现（只传 provider+model）在这里必炸。
  // 动态构造一次最小 runTurn 太贵，改为静态断言 runTurn 的用法形状：
  // prepareCall 的返回值必须被展开进 stream 入参（源码级回归哨兵）。
  const source = readFileSync(new URL('../src/chat.js', import.meta.url), 'utf8');
  assert.equal(source.includes('...prepared.config'), true,
    'runTurn must spread prepared.config into stream options');
});

// ── 思考型模型：reasoning 必须转出去 ────────────────────────────────────

/** 思考 + 正文轮：reasoning effort 生效时真 adapter 的 chunk 顺序。 */
function* reasoningRound() {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' };
  yield { type: 'reasoning-delta', index: 0, text: '先看磁盘' };
  yield { type: 'reasoning-delta', index: 0, text: '占用…' };
  yield { type: 'text-delta', index: 1, text: '根分区用了 63%' };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

test('runTurn forwards reasoning deltas so long thinking is visible', async () => {
  // 旧实现只认 text-delta：整个思考期一个事件都不发，面板停在"思考中"，
  // 看门狗还会把健康的长思考当挂死掐掉（2026-10-24 真机）。
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  const chat = createChatService({ service, llm: makeFakeLlm([reasoningRound]) });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '磁盘呢' }],
    autoExecute: false,
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(
    events.map((event) => event.type),
    ['accepted', 'model', 'reasoning', 'reasoning', 'text', 'finish'],
  );
  assert.equal(events[2].text, '先看磁盘');
});

test('runTurn skips the model inventory when the client already picked a model', async () => {
  // 列清单（逐 provider listModels）可能碰账号/网络，放在回合最前面会让
  // 用户在第一个事件之前干等。客户端已给 provider+model 时不该走它。
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  const llm = {
    listProviders: () => {
      throw new Error('inventory must not be consulted when provider+model are given');
    },
    listModels: async () => [],
    prepareCall: async (config) => ({
      config: { provider: config.provider, model: config.model },
      stream: () => textRound(),
    }),
  };
  const chat = createChatService({ service, llm });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '你好' }],
    autoExecute: false,
    provider: 'p1',
    model: 'm1',
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events.map((event) => event.type), ['accepted', 'model', 'text', 'finish']);
  assert.deepEqual(events[1], { type: 'model', provider: 'p1', model: 'm1' });
});

// ── 通道级失败：按 adapter 的 retryPolicy 退避重试 ──────────────────────

/** 一次 transport 失败（首字节之前）。 */
function* transportFailure() {
  yield {
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' } },
  };
}

/** 先吐半句再失败（不该重试）。 */
function* partialThenTransport() {
  yield { type: 'text-delta', index: 0, text: '根分区' };
  yield {
    type: 'finish',
    reason: { kind: 'error', failure: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' } },
  };
}

/**
 * 造一个带 retryPolicy 的假 llm：按剧本逐次返回，并记录 prepareCall 次数。
 * @param {Array<() => AsyncIterable<object>>} rounds 每次尝试的剧本。
 * @returns {object} 假 llm。
 */
function makeRetryingLlm(rounds) {
  let call = 0;
  return {
    attempts: () => call,
    listProviders: () => [{ id: 'p1', name: 'P1' }],
    listModels: async () => [{ id: 'm1', label: 'M1' }],
    prepareCall: async (config) => {
      const round = rounds[Math.min(call, rounds.length - 1)];
      call += 1;
      return {
        config: { provider: config.provider, model: config.model },
        // 与真 adapter 的 providerRetryPolicy() 同形。
        retryPolicy: {
          mode: 'normal',
          maxRetries: 2,
          retryableCodes: ['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
          initialDelayMs: 1,
          maxDelayMs: 2,
          jitterRatio: 0,
        },
        stream: () => round(),
      };
    },
  };
}

test('runTurn retries a transport failure before the first byte, then succeeds', async () => {
  // 原生对话有 dsh-llm-retry 兜住这种抖动；我们的面板以前一次就报错，
  // 于是同一条通道"原生能答、右栏 transport failed"。
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  const llm = makeRetryingLlm([transportFailure, textRound]);
  const chat = createChatService({ service, llm });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '磁盘呢' }],
    autoExecute: false,
    provider: 'p1',
    model: 'm1',
    onEvent: (event) => events.push(event),
  });
  const types = events.map((event) => event.type);
  assert.equal(types.includes('retry'), true, '抖动时应先发 retry 事件');
  assert.equal(types.includes('error'), false, '重试成功就不该报错');
  assert.equal(events.at(-1).type, 'finish');
  assert.equal(llm.attempts(), 2, '一共两次尝试（首跑 + 一次重试）');
  const retry = events.find((event) => event.type === 'retry');
  assert.equal(retry.code, 'TRANSPORT');
  assert.equal(retry.maxRetries, 2);
});

test('runTurn does not retry once text has been emitted', async () => {
  // 已经吐了正文再重试 = 同一段话重复一遍，用户看到的是乱码式重复。
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  const llm = makeRetryingLlm([partialThenTransport, textRound]);
  const chat = createChatService({ service, llm });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '磁盘呢' }],
    autoExecute: false,
    provider: 'p1',
    model: 'm1',
    onEvent: (event) => events.push(event),
  });
  assert.equal(events.some((event) => event.type === 'retry'), false);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(llm.attempts(), 1, '不该有第二次尝试');
});

// ── content 必须是块数组（DeepSeek 官方通道的硬要求）──────────────────

test('normalizeHistory turns string content into text blocks', () => {
  // llm-deepseek 的序列化器直接 `message.content.flatMap(...)`；字符串没有
  // flatMap → TypeError → 被包成 TRANSPORT（"Messages transport failed"）。
  // 免费通道有 blocksOf() 容错，所以只有官方通道每次必挂。
  const history = normalizeHistory([
    { role: 'user', content: '看看 nginx' },
    { role: 'tool', toolCallId: 'c1', content: 'total 0', isError: false },
  ]);
  assert.deepEqual(history[0].content, [{ type: 'text', text: '看看 nginx' }]);
  assert.deepEqual(history[1].content, [{ type: 'text', text: 'total 0' }]);
  assert.equal(Array.isArray(history[0].content), true);
  assert.equal(Array.isArray(history[1].content), true);
});

test('normalizeHistory never emits a string or undefined content', () => {
  const history = normalizeHistory([
    { role: 'user', content: '' },
    { role: 'user', content: 42 },
    { role: 'assistant', content: '纯文本' },
  ]);
  for (const message of history) {
    assert.equal(Array.isArray(message.content), true, `content 必须是数组：${JSON.stringify(message)}`);
  }
});

test('runTurn hands the adapter block arrays (DeepSeek serializer shape)', async () => {
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  /** 模拟 llm-deepseek：对 content 调 flatMap，字符串会直接炸。 */
  const llm = {
    listProviders: () => [{ id: 'p1', name: 'P1' }],
    listModels: async () => [{ id: 'm1', label: 'M1' }],
    prepareCall: async (config) => ({
      config: { provider: config.provider, model: config.model },
      stream: (options) => {
        for (const message of options.messages) {
          // 这一行就是 serialize.ts:122 的行为。
          message.content.flatMap((block) => [block]);
        }
        return textRound();
      },
    }),
  };
  const chat = createChatService({ service, llm });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '看看 nginx' }],
    autoExecute: false,
    provider: 'p1',
    model: 'm1',
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events.map((event) => event.type), ['accepted', 'model', 'text', 'finish']);
});

// ── 三档授权：auto / danger / always ───────────────────────────────────

test('danger 档：只读命令直接跑，危险命令停下来等确认', async () => {
  const { service, created } = makeShellService(shellWith('/dev/disk1s1 500G 200G'));
  service.open({ host: LOCAL_HOST });
  const llm = makeFakeLlm([toolRound, textRound]);
  const chat = createChatService({ service, llm });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '磁盘呢' }],
    approval: 'danger',
    onEvent: (event) => events.push(event),
  });
  // df -h 是只读命令：不该出确认卡，直接执行。
  const call = events.find((event) => event.type === 'tool-call');
  assert.equal(call.needsConfirm, undefined);
  assert.equal(events.some((event) => event.type === 'tool-result'), true, '只读命令应自动执行');
  assert.equal(Buffer.concat(created[0].sent).toString('utf8').includes('df -h'), true);
});

test('danger 档：rm -rf 必须停下来等用户确认', async () => {
  const { service, created } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  /** 一轮：模型要删目录。 */
  function* dangerousRound() {
    yield {
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: 'call-9', name: 'run_command', arguments: '{"command":"rm -rf /var/www/cache"}' },
    };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
  const chat = createChatService({ service, llm: makeFakeLlm([dangerousRound, textRound]) });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '清一下缓存' }],
    approval: 'danger',
    onEvent: (event) => events.push(event),
  });
  const call = events.find((event) => event.type === 'tool-call');
  assert.equal(call.needsConfirm, true, '危险命令要确认');
  assert.equal(call.dangerous, true);
  assert.equal(events.at(-1).reason, 'tool-call', '回合应停在确认点');
  // 关键：命令绝不能已经进了 PTY。
  assert.equal(Buffer.concat(created[0].sent).toString('utf8').includes('rm -rf'), false);
});

test('always 档每条都确认，auto 档一条都不确认', async () => {
  for (const [approval, expectConfirm] of [['always', true], ['auto', false]]) {
    const { service } = makeShellService(shellWith('ok'));
    service.open({ host: LOCAL_HOST });
    const chat = createChatService({ service, llm: makeFakeLlm([toolRound, textRound]) });
    /** @type {object[]} */
    const events = [];
    await chat.runTurn({
      sid: 's1',
      messages: [{ role: 'user', content: '磁盘呢' }],
      approval,
      onEvent: (event) => events.push(event),
    });
    const call = events.find((event) => event.type === 'tool-call');
    assert.equal(call.needsConfirm === true, expectConfirm, `${approval} 档的确认策略不对`);
  }
});

test('老客户端只发 autoExecute 布尔值时按 auto/always 兼容', async () => {
  const { service } = makeShellService(shellWith('ok'));
  service.open({ host: LOCAL_HOST });
  const chat = createChatService({ service, llm: makeFakeLlm([toolRound, textRound]) });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '磁盘呢' }],
    autoExecute: false,
    onEvent: (event) => events.push(event),
  });
  assert.equal(events.find((event) => event.type === 'tool-call').needsConfirm, true);
});

test('面板只重试 2 次，哪怕通道策略允许 5 次', async () => {
  // 通道的 retryPolicy 是给后台 agent loop 的（maxRetries 5）；右栏有人在等，
  // 同一个确定性失败重试 5 次只是让用户干等。恢复不了就换通道 + 自动重发。
  const { service } = makeShellService(shellWith('x'));
  service.open({ host: LOCAL_HOST });
  let attempts = 0;
  const llm = {
    listProviders: () => [{ id: 'p1', name: 'P1' }],
    listModels: async () => [{ id: 'm1', label: 'M1' }],
    prepareCall: async (config) => {
      attempts += 1;
      return {
        config: { provider: config.provider, model: config.model },
        retryPolicy: { mode: 'normal', maxRetries: 5, retryableCodes: ['TRANSPORT'], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
        stream: () => transportFailure(),
      };
    },
  };
  const chat = createChatService({ service, llm });
  /** @type {object[]} */
  const events = [];
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: 'hi' }],
    approval: 'auto',
    provider: 'p1',
    model: 'm1',
    onEvent: (event) => events.push(event),
  });
  assert.equal(attempts, 3, '首次 + 2 次重试，不能按通道的 5 次跑');
  assert.equal(events.filter((event) => event.type === 'retry').length, 2);
  assert.equal(events.at(-1).type, 'error');
});

// ── 思考签名（replayState）必须原样回传 ───────────────────────────────

test('runTurn echoes replayState and a reasoning block into the next request', async () => {
  // 原生 assistant 消息是 [{type:'reasoning',text:''}, {type:'text'}, …] +
  // source.replayState（思考签名）。缺了它，官方通道的续轮会被拒——真机表现
  // 就是"第一轮好使、后面必挂"（2026-10-24）。
  const { service } = makeShellService(shellWith('ok'));
  service.open({ host: LOCAL_HOST });
  const replayState = {
    response: { kind: 'deepseek-messages', version: 1, model: 'm1' },
    blocks: [{ type: 'reasoning', signature: 'sig-1' }, { type: 'text' }],
  };
  /** 第二轮拿到的 messages，用来断言回传形状。 */
  let seen = null;
  let call = 0;
  const llm = {
    listProviders: () => [{ id: 'p1', name: 'P1' }],
    listModels: async () => [{ id: 'm1', label: 'M1' }],
    prepareCall: async (config) => ({
      config: { provider: config.provider, model: config.model },
      stream: (options) => {
        call += 1;
        if (call === 1) {
          return (function* first() {
            yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'run_command', arguments: '{"command":"df -h"}' } };
            yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState };
          })();
        }
        seen = options.messages;
        return textRound();
      },
    }),
  };
  const chat = createChatService({ service, llm });
  await chat.runTurn({
    sid: 's1',
    messages: [{ role: 'user', content: '磁盘呢' }],
    approval: 'auto',
    provider: 'p1',
    model: 'm1',
    onEvent: () => {},
  });
  assert.ok(seen !== null, '第二轮应已发出');
  const assistant = seen.find((message) => message.role === 'assistant');
  assert.equal(assistant.content[0].type, 'reasoning', '思考块必须排第一位');
  assert.deepEqual(assistant.source.replayState, replayState, '签名要原样回传');
});
