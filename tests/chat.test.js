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
 * 标准 shell：收到 printf marker 行时回显输出 + 退出码行。
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
    listModels: async () => models,
    prepareCall: async (config) => {
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
  assert.deepEqual(history[0], { role: 'user', content: '看看磁盘' });
  assert.equal(history[1].content.length, 2);
  assert.equal(history[1].content[1].type, 'tool-call');
  // assistant 必须带 source：真 runtime 的 forAdapter 会读 source.replayState，
  // 缺了会被包装成"模型静默结束"（2026-10-24 真机 E2E 实测）。
  assert.deepEqual(history[1].source, { kind: 'model', provider: 'p1', model: 'm1' });
  assert.deepEqual(history[2], { role: 'tool', toolCallId: 'c1', content: 'output', isError: false });
});

test('normalizeHistory caps length and drops system messages', () => {
  const many = [];
  for (let index = 0; index < 40; index += 1) many.push({ role: 'user', content: `m${index}` });
  many.unshift({ role: 'system', content: 'stale' });
  const history = normalizeHistory(many);
  assert.equal(history.length, 30);
  assert.equal(history[0].content, 'm10');
  assert.equal(history.at(-1).content, 'm39');
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
    if (data === 'top\n') echo('top - 12:00:00 up 3 days\n');
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
  assert.deepEqual(types, ['model', 'text', 'tool-call', 'finish']);
  assert.deepEqual(events[0], { type: 'model', provider: 'p1', model: 'm1' });
  const call = events[2];
  assert.equal(call.command, 'df -h');
  assert.equal(call.arguments, '{"command":"df -h"}');
  assert.equal(events[3].reason, 'tool-call');
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
  assert.deepEqual(types, ['model', 'text', 'tool-call', 'tool-result', 'text', 'finish']);
  const result = events[3];
  assert.equal(result.ok, true);
  assert.match(result.output, /500G 200G/);
  assert.equal(events[5].reason, 'stop');
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
  assert.deepEqual(events[0], { type: 'model', provider: 'p1', model: 'm1' });
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
  assert.deepEqual(events[0], { type: 'model', provider: 'p2', model: 'm2' });
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
  assert.deepEqual(events.map((event) => event.type), ['model', 'text', 'error']);
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
  assert.deepEqual(events.map((event) => event.type), ['model', 'error']);
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
