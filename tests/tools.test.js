/**
 * `src/tools.js` + Host 半分层挂载的 node --test 测试。
 *
 * 覆盖设计 §6 T04 的六条验收：
 * 1. 七个工具全部注册成功；重名注册抛错（证明 register 的 disposer 真的能撤销）；
 * 2. `ssh_send` 不传 sid 打到 activeSid，传 sid 打到指定会话；
 * 3. `ssh_read({lines:3})` 返回最后三行，中文与 ANSI 都不乱码；
 * 4. `allowTransfer:false` 时上传/下载返回 `{error:'transfer-disabled'}` 且不碰
 *    transport；开启后 `..` 逃逸与绝对路径越界都被 `path-outside-root` 拒绝；
 * 5. promptText 是动态的：activeSid 变了，文本跟着变；
 * 6. 去掉 `tools` 服务后 `apply()` 仍然成功（分层 inject 有效）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshSessionService } from '../src/sessions.js';
import { createFakeTransport } from '../src/transport.js';
import { HostStore } from '../src/hosts.js';
import { createVault } from '../src/vault.js';
import { createSshTools } from '../src/tools.js';
import { apply } from '../src/index.js';
import {
  createFakeCredentials,
  createFakeCtx,
  createFakeStorageDomain,
  createFakeSystemPrompt,
  createFakeTools,
  mountRoutes,
  request,
} from './stubs/fake-services.mjs';

/** 测试用口令。 */
const SECRET = 'tool-test-secret-9';

/**
 * 造一套 service + store + tools。
 * @param {object} [options] 选项。
 * @param {object} [options.config] patch config（allowTransfer / transferRoot）。
 * @param {boolean} [options.withStore] 是否挂 store，默认 true。
 * @returns {Promise<object>} 句柄。
 */
async function makeTools(options = {}) {
  /** @type {object[]} */
  const created = [];
  const service = new SshSessionService({
    createTransport: (config, handlers) => {
      const transport = createFakeTransport(config, handlers);
      created.push(transport);
      return transport;
    },
  });
  const storageDomain = createFakeStorageDomain();
  const credentials = createFakeCredentials();
  const vault = createVault({ credentials });
  const store = options.withStore === false ? null : await new HostStore({ storageDomain, vault }).init();
  const { definitions, promptText, promptOrder } = createSshTools({
    service,
    store,
    config: options.config ?? {},
  });
  /** 按名字索引，测试里直接调 execute。 */
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  return { service, created, store, storageDomain, credentials, definitions, byName, promptText, promptOrder };
}

/** 建一台主机并返回记录。 */
function seedHost(store) {
  return store.create({
    label: '测试机',
    host: '10.0.0.9',
    port: 2222,
    username: 'deploy',
    auth: { kind: 'password', password: SECRET },
  });
}

test('seven tools are defined with the exact contract shape', async () => {
  const app = await makeTools();
  const names = app.definitions.map((definition) => definition.name).sort();
  assert.deepEqual(names, [
    'ssh_close', 'ssh_download', 'ssh_hosts', 'ssh_open', 'ssh_read', 'ssh_send', 'ssh_upload',
  ]);
  for (const definition of app.definitions) {
    // register 只校验 output.schema（`tools/src/index.ts:1069-1094`），所以
    // 这里至少保证 output.schema 与 output.render 都在，parameters 是裸 JSON Schema。
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 10, `${definition.name} needs a real description`);
    assert.equal(definition.parameters.type, 'object');
    assert.equal(typeof definition.parameters.properties, 'object');
    assert.equal(Array.isArray(definition.parameters.required), true);
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.execute, 'function');
    // 工具名不许撞 dsh 已有前缀（全仓无 ssh_*）。
    assert.match(definition.name, /^ssh_[a-z]+$/);
  }
  // 提示词 order 落在 PTY(1700) 与 WEB_SEARCH(2000) 之间。
  assert.equal(app.promptOrder, 1750);
});

test('registering all seven succeeds and a duplicate name throws (disposer works)', async () => {
  const app = await makeTools();
  const tools = createFakeTools();
  /** @type {Array<() => void>} */
  const disposers = app.definitions.map((definition) => tools.register(definition));
  assert.equal(tools.definitions.length, 7);

  // 同层重名 -> 抛错（真实现同样行为）。
  assert.throws(() => tools.register(app.definitions[0]), /duplicate tool name/);

  // 卸载一个再注册同名 -> 成功，证明 disposer 真的撤销了注册。
  disposers[0]();
  assert.equal(tools.definitions.length, 6);
  assert.doesNotThrow(() => tools.register(app.definitions[0]));
  assert.equal(tools.definitions.length, 7);
});

test('ssh_send defaults to activeSid and honours an explicit sid', async () => {
  const app = await makeTools();
  const record = await seedHost(app.store);
  const first = app.byName.get('ssh_open');
  const send = app.byName.get('ssh_send');

  const opened1 = await first.execute({ host: record.id });
  const opened2 = await first.execute({ host: record.id });
  assert.equal(opened1.sid, 's1');
  assert.equal(opened2.sid, 's2');
  // activeSid 是第一个开的（open 只在 activeSid 为 null 时抢占）。
  app.service.setActive('s2');

  const toActive = send.execute({ text: 'uptime' });
  assert.deepEqual(toActive, { sid: 's2', bytes: 7 }, 'submit=true appends a CR');
  assert.equal(app.created[1].sent[0].toString('utf8'), 'uptime\r');
  assert.equal(app.created[0].sent.length, 0, 'the other session must not receive it');

  // 显式 sid 覆盖 activeSid。
  const toFirst = send.execute({ text: 'pwd', sid: 's1', submit: false });
  assert.deepEqual(toFirst, { sid: 's1', bytes: 3 });
  assert.equal(app.created[0].sent[0].toString('utf8'), 'pwd');

  // 没有任何会话时抛 unknown-session，而不是静默成功。
  app.service.closeAll();
  assert.throws(() => send.execute({ text: 'x' }), (error) => error.code === 'unknown-session');
});

test('ssh_read returns the last N lines with utf8 and ANSI intact', async () => {
  const app = await makeTools();
  const record = await seedHost(app.store);
  const { sid } = await app.byName.get('ssh_open').execute({ host: record.id });
  const fake = app.created[0];

  // 故意把一段中文拆到两个 chunk 里：逐片解码会产生 U+FFFD，拼接后解码才对。
  const payload = '第一行\r\n\u001b[32m第二行\u001b[0m\r\n第三行：中文与 ANSI\r\n第四行\r\n第五行\r\n';
  const cut = payload.indexOf('第三行') + 1;
  fake.emit(payload.slice(0, cut));
  fake.emit(payload.slice(cut));

  const read = app.byName.get('ssh_read').execute({ lines: 3 });
  assert.equal(read.sid, sid);
  assert.equal(read.text, '第三行：中文与 ANSI\n第四行\n第五行');
  assert.equal(read.text.includes('\uFFFD'), false, 'no replacement characters allowed');
  assert.equal(read.truncated, true, '5 lines in the buffer, 3 requested');

  // 跨片中文必须完好：单独读最后 3 行里的 ANSI 行也还在。
  const ansi = app.byName.get('ssh_read').execute({ lines: 4 });
  assert.match(ansi.text, /^\u001b\[32m第二行\u001b\[0m/);

  // 读全部 -> 不截断。
  const all = app.byName.get('ssh_read').execute({ lines: 50 });
  assert.equal(all.truncated, false);
  assert.match(all.text, /^第一行\n/);
  assert.match(all.text, /第五行$/);

  // 缺省 80 行、上限 500 行：给个离谱值也不会一次拉爆上下文。
  assert.equal(app.byName.get('ssh_read').execute({ lines: 100000 }).text.split('\n').length <= 500, true);
});

test('ssh_hosts reports status and the active flag; ssh_open accepts label or hostname', async () => {
  const app = await makeTools();
  const record = await seedHost(app.store);
  await app.byName.get('ssh_open').execute({ host: '测试机' });
  app.service.setActive('s1');

  const hosts = await app.byName.get('ssh_hosts').execute({});
  assert.equal(hosts.hosts.length, 1);
  assert.deepEqual(Object.keys(hosts.hosts[0]).sort(), [
    'active', 'authKind', 'host', 'id', 'label', 'port', 'sid', 'status', 'username',
  ]);
  assert.equal(hosts.hosts[0].active, true);
  assert.equal(hosts.hosts[0].sid, 's1');
  assert.equal(hosts.hosts[0].authKind, 'pass');
  // 响应里不能有秘密。
  assert.equal(JSON.stringify(hosts).includes(SECRET), false);

  // 用主机名也能开（模型的输入往往不是 id）。
  const viaHostname = await app.byName.get('ssh_open').execute({ host: '10.0.0.9' });
  assert.equal(viaHostname.sid, 's2');
  assert.equal(viaHostname.host, 'deploy@10.0.0.9:2222');

  // 未知主机 -> unknown-host。
  await assert.rejects(() => app.byName.get('ssh_open').execute({ host: 'nope' }), (error) => error.code === 'unknown-host');
  // 缺参数 -> invalid-host。
  await assert.rejects(() => app.byName.get('ssh_open').execute({}), (error) => error.code === 'invalid-host');
});

test('ssh_close closes the target session and reports it', async () => {
  const app = await makeTools();
  const record = await seedHost(app.store);
  await app.byName.get('ssh_open').execute({ host: record.id });
  await app.byName.get('ssh_open').execute({ host: record.id });
  app.service.setActive('s1');

  assert.deepEqual(app.byName.get('ssh_close').execute({}), { sid: 's1', closed: true });
  assert.equal(app.service.sessions.has('s1'), false);
  assert.deepEqual(app.byName.get('ssh_close').execute({ sid: 's2' }), { sid: 's2', closed: true });
  assert.equal(app.service.sessions.size, 0);
  assert.throws(() => app.byName.get('ssh_close').execute({ sid: 's9' }), (error) => error.code === 'unknown-session');
});

test('allowTransfer:false refuses transfers without touching the transport', async () => {
  const app = await makeTools({ config: { allowTransfer: false } });
  const record = await seedHost(app.store);
  await app.byName.get('ssh_open').execute({ host: record.id });

  const upload = await app.byName.get('ssh_upload').execute({ local: 'a.txt', remote: '/tmp/a.txt' });
  const download = await app.byName.get('ssh_download').execute({ remote: '/tmp/a.txt', local: 'a.txt' });
  assert.deepEqual(upload, { error: 'transfer-disabled' });
  assert.deepEqual(download, { error: 'transfer-disabled' });
  assert.equal(app.created[0].uploads.length, 0, 'transport must not be called');
  assert.equal(app.created[0].downloads.length, 0, 'transport must not be called');
});

test('with allowTransfer on, paths are confined to transferRoot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ssh-transfer-'));
  // macOS 的 tmpdir 是 /var/folders/... 的软链，工具层会 realpath 到 /private/var/...，
  // 所以期望值也用规范化后的根。
  const canonicalRoot = realpathSync(root);
  try {
    writeFileSync(join(root, 'payload.txt'), 'hello-transfer');
    const app = await makeTools({ config: { allowTransfer: true, transferRoot: root } });
    const record = await seedHost(app.store);
    await app.byName.get('ssh_open').execute({ host: record.id });
    const fake = app.created[0];

    // 合法：相对路径落在 root 内，bytes 来自真实文件大小。
    const ok = await app.byName.get('ssh_upload').execute({ local: 'payload.txt', remote: '/tmp/payload.txt' });
    assert.deepEqual(ok, { bytes: 'hello-transfer'.length });
    assert.deepEqual(fake.uploads, [{ local: join(canonicalRoot, 'payload.txt'), remote: '/tmp/payload.txt' }]);

    const okDownload = await app.byName.get('ssh_download').execute({ remote: '/tmp/payload.txt', local: 'payload.txt' });
    assert.deepEqual(okDownload, { bytes: 'hello-transfer'.length });
    assert.deepEqual(fake.downloads, [{ remote: '/tmp/payload.txt', local: join(canonicalRoot, 'payload.txt') }]);

    // `..` 逃逸与绝对路径越界都被拒，且不碰 transport。
    for (const local of ['../../etc/passwd', '/etc/passwd', '../payload.txt', join(root, '..', 'escape.txt')]) {
      const res = await app.byName.get('ssh_upload').execute({ local, remote: '/tmp/x' });
      assert.deepEqual(res, { error: 'path-outside-root' }, `${local} must be rejected`);
    }
    assert.equal(fake.uploads.length, 1, 'rejected paths must not reach the transport');
    assert.equal(fake.downloads.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('promptText is dynamic: it follows activeSid', async () => {
  const app = await makeTools();
  const record = await seedHost(app.store);
  const other = await app.store.create({ host: '10.0.0.10', username: 'ops', label: '另一台' });

  const empty = app.promptText();
  assert.equal(empty, '当前没有打开的 SSH 会话。');

  const first = await app.byName.get('ssh_open').execute({ host: record.id });
  app.service.setActive(first.sid);
  const withFirst = app.promptText();
  assert.match(withFirst, /测试机/);
  assert.match(withFirst, /deploy@10\.0\.0\.9:2222/);

  const second = await app.byName.get('ssh_open').execute({ host: other.id });
  app.service.setActive(second.sid);
  const withSecond = app.promptText();
  assert.notEqual(withSecond, withFirst, 'switching tabs must change the prompt text');
  assert.match(withSecond, /另一台/);
  assert.match(withSecond, /ops@10\.0\.0\.10:22/);

  // 全部关掉 -> 回到"没有会话"。
  app.service.closeAll();
  assert.equal(app.promptText(), '当前没有打开的 SSH 会话。');
});

test('apply() mounts all three layers when the services exist', async () => {
  const storageDomain = createFakeStorageDomain();
  const credentials = createFakeCredentials();
  const tools = createFakeTools();
  const systemPrompt = createFakeSystemPrompt();
  const ctx = createFakeCtx({ storageDomain, credentials, tools, systemPrompt });

  const dispose = await apply(ctx, { autoOpenFirst: false });
  await dispose.ready;

  assert.equal(tools.definitions.length, 7, 'all seven tools are registered through ctx.tools');
  assert.equal(systemPrompt.sections.length, 1);
  assert.equal(systemPrompt.sections[0].name, 'tool:ssh');
  assert.equal(systemPrompt.sections[0].order, 1750);
  // text 是函数：每次装配都求值。
  assert.equal(typeof systemPrompt.sections[0].text, 'function');
  assert.equal(systemPrompt.render('tool:ssh'), '当前没有打开的 SSH 会话。');
  // 路由也都在。
  assert.ok(ctx.routes.length >= 8, `routes registered: ${ctx.routes.length}`);

  await dispose();
  // dispose 之后工具与路由都应撤销（真 cordis 会跑 effect disposer）。
  assert.equal(tools.definitions.length, 0);
});

test('apply() still succeeds without the tools service (layered inject)', async () => {
  const storageDomain = createFakeStorageDomain();
  const credentials = createFakeCredentials();
  const ctx = createFakeCtx({ storageDomain, credentials }); // 没有 tools / systemPrompt

  const dispose = await apply(ctx, { autoOpenFirst: false });
  await dispose.ready;

  // 分层 inject 生效：缺 tools 只跳过模型半，底座路由与持久化都在。
  assert.ok(ctx.routes.length >= 8, 'routes must still be registered');
  assert.equal(ctx.skipped.some((missing) => missing.includes('tools')), true, 'the tools half was skipped, not failed');
  assert.equal(typeof dispose, 'function');

  // 而且真的能用：建一台主机 -> 走真路由拿到 201（说明底座 + 持久化两半都在）。
  const created = await postHost(ctx, { host: '10.9.9.9', username: 'root', auth: { kind: 'password', password: SECRET } });
  assert.equal(created.status, 201, created.text);
  await dispose();
});

test('apply() also survives a missing storage layer', async () => {
  const ctx = createFakeCtx({}); // 什么服务都没有，只有 webServer + connection
  const dispose = await apply(ctx, {});
  await dispose.ready;
  assert.ok(ctx.routes.length >= 8);
  // 三个可选半层（持久化 / 模型工具 / 对话）全部跳过，底座路由照常。
  assert.equal(ctx.skipped.length, 3, 'all optional halves were skipped');
  await dispose();
});

/**
 * 直接用 ctx.routes 起一个临时 server 发一次 POST /hosts。
 * （这里不复用 makeApp，是为了让断言只依赖 apply() 注册的那张路由表。）
 * @param {object} ctx 假上下文。
 * @param {object} body 请求体。
 * @returns {Promise<{status: number, text: string}>} 响应。
 */
async function postHost(ctx, body) {
  const server = await mountRoutes(ctx);
  try {
    return await request(`${server.baseUrl}/api/dsh-ssh/hosts`, { method: 'POST', body });
  } finally {
    await server.close();
  }
}
