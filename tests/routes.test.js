/**
 * routes.js / handleStream 的 node --test 测试。
 *
 * 不起 sshd、不碰浏览器：用 `tests/stubs/fake-services.mjs` 里的假 cordis 上下文
 * 起一个真 http.Server，配 fake transport 的 SshSessionService + 内存
 * storageDomain/credentials，验证三层东西：
 *
 * 1. **SSE 契约**——帧格式、since 四个边界输入、404 路径不二次 setHeader、
 *    live/exit 事件、teardown 幂等、迟到连接的补发 exit 与 meta 缺口帧
 *    （P1-B / P1-C 的规格）；
 * 2. **exact/prefix 双语义**——`/hosts` 与 `/hosts/<id>` 各走各的；
 * 3. **响应体纪律**——`GET /hosts` 里绝不能出现任何秘密或 SecretBox 字段。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { SshSessionService } from '../src/sessions.js';
import { createFakeTransport } from '../src/transport.js';
import { formatSseFrame, registerRoutes } from '../src/routes.js';
import { HostStore } from '../src/hosts.js';
import { createVault } from '../src/vault.js';
import {
  createFakeCredentials,
  createFakeCtx,
  createFakeStorageDomain,
  mountRoutes,
  request,
} from './stubs/fake-services.mjs';

/** 测试用口令：足够独特，grep 响应体时不会误判。 */
const SECRET = 'Zq7-ssh-route-secret';

/**
 * 造一套完整的被测系统：service + store + 假 ctx + 真 http server。
 * @param {object} [options] 选项。
 * @param {object} [options.serviceOptions] 透传给 SshSessionService。
 * @param {boolean} [options.withStore] 是否挂持久化层（false 模拟缺 storageDomain）。
 * @param {object[]} [options.fallbackHosts] 无 store 时的只读主机表。
 * @returns {Promise<object>} 句柄：`{service, created, store, storageDomain, credentials, ctx, baseUrl, close}`。
 */
async function makeApp(options = {}) {
  /** @type {object[]} */
  const created = [];
  const service = new SshSessionService({
    createTransport: (config, handlers) => {
      const transport = createFakeTransport(config, handlers);
      created.push(transport);
      return transport;
    },
    ...(options.serviceOptions ?? {}),
  });

  const storageDomain = createFakeStorageDomain();
  const credentials = createFakeCredentials();
  const vault = createVault({ credentials });
  const store = options.withStore === false ? null : await new HostStore({ storageDomain, vault }).init();

  const ctx = createFakeCtx({ reject: options.reject });
  registerRoutes(ctx, { service, store, transfer: options.transfer ?? null, fallbackHosts: options.fallbackHosts ?? [] });
  const server = await mountRoutes(ctx);

  return {
    service,
    created,
    store,
    storageDomain,
    credentials,
    vault,
    ctx,
    baseUrl: server.baseUrl,
    close: server.close,
  };
}

/**
 * 发一个 GET 并把整个响应体收完。SSE 流由服务端 exit 事件结束，或到
 * autoCloseAfterMs 后客户端主动断开（模拟切走，触发 teardown）。
 * @param {string} url 请求 URL。
 * @param {{autoCloseAfterMs?: number}} [options] autoCloseAfterMs：等待多久后主动断开。
 * @returns {Promise<{status: number, headers: object, body: string}>} 响应摘要。
 */
function getStream(url, options = {}) {
  const autoCloseAfterMs = options.autoCloseAfterMs ?? 300;
  return new Promise((resolve, reject) => {
    let closed = false;
    const req = http.get(url, (res) => {
      /** @type {Buffer[]} */
      const parts = [];
      res.on('data', (chunk) => parts.push(chunk));
      // close 在 end（服务端收流）与 destroy（客户端断开）两条路上都会到。
      res.on('close', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(parts).toString('utf8'),
        });
      });
      res.on('error', (error) => {
        // 主动断开后的残留 error 属预期，交给 close 收尾。
        if (!closed) reject(error);
      });
      setTimeout(() => {
        closed = true;
        req.destroy();
      }, autoCloseAfterMs);
    });
    req.on('error', (error) => {
      if (!closed) reject(error);
    });
  });
}

/** 从 SSE 响应体里抽出所有 data 帧的 JSON。 */
function parseFrames(body) {
  return body
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)));
}

/** 建一台带口令的主机并返回它。 */
async function seedHost(app, overrides = {}) {
  return app.store.create({
    label: '测试机',
    host: '10.0.0.9',
    port: 2222,
    username: 'deploy',
    auth: { kind: 'password', password: SECRET },
    ...overrides,
  });
}

test('formatSseFrame emits data: {seq, chunk} with a blank-line terminator', () => {
  const frame = formatSseFrame({ seq: 7, data: 'aGVsbG8=' });
  assert.equal(frame, 'data: {"seq":7,"chunk":"aGVsbG8="}\n\n');
  // 帧里必须同时有 seq 与 chunk 两个字段，且以空行结束（SSE 规范）。
  const payload = JSON.parse(frame.slice('data: '.length, -2));
  assert.deepEqual(Object.keys(payload).sort(), ['chunk', 'seq']);
  assert.ok(frame.endsWith('\n\n'));
});

test('stream since boundaries: abc / -5 / 0 / missing all replay the full buffer', async () => {
  const app = await makeApp();
  const { sid } = app.service.open({ host: { id: 'local', host: '127.0.0.1' } });
  app.created[0].emit('one ');
  app.created[0].emit('two ');
  app.created[0].emit('three');

  try {
    for (const query of ['since=abc', 'since=-5', 'since=0', '']) {
      const suffix = query === '' ? '' : `&${query}`;
      const res = await getStream(`${app.baseUrl}/api/dsh-ssh/stream?sid=${sid}${suffix}`);
      assert.equal(res.status, 200, `${query || 'missing since'} -> status`);
      assert.match(String(res.headers['content-type']), /text\/event-stream/);
      const frames = parseFrames(res.body);
      assert.deepEqual(
        frames.map((frame) => Buffer.from(frame.chunk, 'base64').toString('utf8')),
        ['one ', 'two ', 'three'],
        `${query || 'missing since'} must replay every chunk`,
      );
    }
  } finally {
    await app.close();
  }
});

test('stream since=N replays only chunks with seq > N', async () => {
  const app = await makeApp();
  const { sid } = app.service.open({ host: { id: 'local', host: '127.0.0.1' } });
  app.created[0].emit('a');
  app.created[0].emit('b');
  app.created[0].emit('c');

  try {
    const res = await getStream(`${app.baseUrl}/api/dsh-ssh/stream?sid=${sid}&since=1`);
    const frames = parseFrames(res.body);
    assert.deepEqual(frames.map((frame) => frame.seq), [2, 3]);

    const ahead = await getStream(`${app.baseUrl}/api/dsh-ssh/stream?sid=${sid}&since=99`);
    assert.equal(parseFrames(ahead.body).length, 0, 'since 超过最新 seq 时无回放');
  } finally {
    await app.close();
  }
});

test('stream on unknown sid answers 404 json before any writeHead (no double setHeader)', async () => {
  const app = await makeApp();
  try {
    const res = await getStream(`${app.baseUrl}/api/dsh-ssh/stream?sid=nope`);
    assert.equal(res.status, 404);
    assert.match(String(res.headers['content-type']), /application\/json/);
    // 关键：404 路径绝不能已经写过 SSE 头。
    assert.doesNotMatch(String(res.headers['content-type']), /text\/event-stream/);
    const payload = JSON.parse(res.body);
    assert.match(payload.error, /unknown session/);
    assert.equal(payload.code, 'unknown-session');
  } finally {
    await app.close();
  }
});

test('stream without sid is a 400, not a crash', async () => {
  const app = await makeApp();
  try {
    const res = await getStream(`${app.baseUrl}/api/dsh-ssh/stream`);
    assert.equal(res.status, 400);
    assert.match(res.body, /sid is required/);
  } finally {
    await app.close();
  }
});

test('stream delivers live data frames and an exit event, then ends', async () => {
  const app = await makeApp();
  const { sid } = app.service.open({ host: { id: 'local', host: '127.0.0.1' } });

  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`${app.baseUrl}/api/dsh-ssh/stream?sid=${sid}&since=0`, (res) => {
        /** @type {Buffer[]} */
        const parts = [];
        res.on('data', (chunk) => parts.push(chunk));
        res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        res.on('error', reject);
        // 连上后再推实时数据，随后让远端退出。
        setTimeout(() => {
          app.created[0].emit('live-output');
          setTimeout(() => app.created[0].close(), 50);
        }, 50);
      });
    });
    const frames = parseFrames(body);
    assert.equal(Buffer.from(frames[0].chunk, 'base64').toString('utf8'), 'live-output');
    // exit 事件帧：event: exit + JSON data，之后流结束。
    assert.match(body, /event: exit\n/);
    const exitPayload = JSON.parse(body.match(/event: exit\ndata: (.*)\n\n/)[1]);
    assert.equal(exitPayload.code, 0);
    // 首帧注释必须存在（客户端据此判定"连上了"）。
    assert.match(body, /^: dsh-ssh stream open\n\n/);
  } finally {
    await app.close();
  }
});

test('teardown is idempotent: client disconnect unsubscribes exactly once and never throws', async () => {
  const app = await makeApp();
  const { sid } = app.service.open({ host: { id: 'local', host: '127.0.0.1' } });

  try {
    // 连上 -> 立刻断开，触发 req/res close 双路径的 teardown。
    await getStream(`${app.baseUrl}/api/dsh-ssh/stream?sid=${sid}&since=0`, { autoCloseAfterMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // teardown 跑过后订阅者必须被摘干净（双触发也不能残留）。
    assert.equal(app.service.get(sid).listeners.size, 0, 'listener leaked after disconnect');

    // 断开后继续有输出：safeWrite 必须静默吞掉，进程与后续请求不受影响。
    app.created[0].emit('after-disconnect');
    assert.equal(app.service.get(sid).listeners.size, 0);

    // 直接验证退订函数幂等：连调两次 + 再 emit，不抛错、不再收到事件。
    /** @type {object[]} */
    const events = [];
    const unsubscribe = app.service.subscribe(sid, (event) => events.push(event));
    unsubscribe();
    unsubscribe();
    app.created[0].emit('x');
    assert.equal(events.length, 0);
    assert.equal(app.service.get(sid).listeners.size, 0);

    // 会话仍可正常服务新连接。
    const res = await getStream(`${app.baseUrl}/api/dsh-ssh/stream?sid=${sid}&since=0`);
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});

test('stream sends a meta frame when the replay has a gap (P1-C)', async () => {
  // 字节上限 4KB，写入远超上限的数据 -> read().truncated === true。
  const app = await makeApp({ serviceOptions: { maxBufferBytes: 4096 } });
  const { sid } = app.service.open({ host: { id: 'local', host: '127.0.0.1' } });
  for (let index = 0; index < 10; index += 1) app.created[0].emit('y'.repeat(2048));

  const replay = app.service.read(sid, 0);
  assert.equal(replay.truncated, true, 'service layer does detect the gap');
  assert.ok(replay.chunks[0].seq > 1, 'oldest buffered chunk is not seq 1 -> gap exists');

  try {
    // 一个"从 seq 1 续传"的客户端：缓冲最早分片已是 seq 5，中间 4 片被裁掉。
    const res = await getStream(`${app.baseUrl}/api/dsh-ssh/stream?sid=${sid}&since=1`);
    assert.equal(res.status, 200);
    // 设计 §2.5 要求客户端能知道"缓冲有缺口"：meta 帧必须出现在回放之前。
    assert.match(res.body, /event: meta\n/, 'a truncated replay must announce the gap');
    const meta = JSON.parse(res.body.match(/event: meta\ndata: (.*)\n\n/)[1]);
    assert.equal(meta.truncated, true);
    assert.equal(meta.firstSeq, replay.chunks[0].seq, 'meta carries the oldest surviving seq');
    assert.ok(meta.dropped > 0, 'meta carries how many chunks were dropped');
    assert.equal(meta.since, 1, 'meta echoes the since the client asked for');
    // 回放本身仍从最早存活分片开始，语义不变。
    const frames = parseFrames(res.body);
    assert.equal(frames[0].seq, replay.chunks[0].seq, 'replay starts at the oldest surviving chunk');
  } finally {
    await app.close();
  }
});

test('stream without a gap sends no meta frame (quiet path stays quiet)', async () => {
  const app = await makeApp();
  const { sid } = app.service.open({ host: { id: 'local', host: '127.0.0.1' } });
  app.created[0].emit('clean output');

  try {
    const res = await getStream(`${app.baseUrl}/api/dsh-ssh/stream?sid=${sid}&since=0`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.body, /event: meta/, 'no gap -> no meta frame');
  } finally {
    await app.close();
  }
});

test('late SSE connect to an already-dead session gets an immediate exit (P1-B)', async () => {
  // 典型路径：连 127.0.0.1:22 被拒，exit 事件在出错那一刻已经广播给零个订阅者。
  // 用户几秒后才点开应用 -> SSE 此时才连上。迟到者必须立刻收到 exit 并收流。
  /** @type {object|null} */
  let capturedHandlers = null;
  let fake = null;
  const service = new SshSessionService({
    createTransport: (config, handlers) => {
      capturedHandlers = handlers;
      fake = createFakeTransport(config, handlers);
      return fake;
    },
  });
  const { sid } = service.open({ host: { id: 'local', host: '127.0.0.1' } });
  fake.emit('banner before failure\n');
  capturedHandlers.onError(new Error('connect ECONNREFUSED 127.0.0.1:22'));
  assert.equal(service.get(sid).status, 'error');

  const ctx = createFakeCtx();
  registerRoutes(ctx, { service, store: null });
  const server = await mountRoutes(ctx);
  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`${server.baseUrl}/api/dsh-ssh/stream?sid=${sid}&since=0`, (res) => {
        /** @type {Buffer[]} */
        const parts = [];
        res.on('data', (chunk) => parts.push(chunk));
        // 迟到连接的正确行为：服务端主动 end，不是客户端超时断开。
        res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        res.on('error', reject);
      }).on('error', reject);
    });
    // 回放里有历史输出……
    const frames = parseFrames(body);
    assert.equal(frames.length, 1, 'replay still delivers buffered output');
    assert.equal(Buffer.from(frames[0].chunk, 'base64').toString('utf8'), 'banner before failure\n');
    // ……紧接着是补发的 exit 帧，形状与实时 onError 发射的一致。
    assert.match(body, /event: exit\n/, 'dead session must tell the late-connecting client it is over');
    const exitPayload = JSON.parse(body.match(/event: exit\ndata: (.*)\n\n/)[1]);
    assert.equal(exitPayload.code, null);
    assert.match(exitPayload.reason, /ECONNREFUSED/);
  } finally {
    await server.close();
  }
});

test('late SSE connect to a closed (not errored) session also gets an immediate exit', async () => {
  const app = await makeApp();
  const { sid } = app.service.open({ host: { id: 'local', host: '127.0.0.1' } });
  app.created[0].emit('last words\n');
  // 远端正常退出：onExit -> status closed, exitCode 0。
  app.created[0].close();

  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`${app.baseUrl}/api/dsh-ssh/stream?sid=${sid}&since=0`, (res) => {
        /** @type {Buffer[]} */
        const parts = [];
        res.on('data', (chunk) => parts.push(chunk));
        res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        res.on('error', reject);
      }).on('error', reject);
    });
    const exitPayload = JSON.parse(body.match(/event: exit\ndata: (.*)\n\n/)[1]);
    assert.equal(exitPayload.code, 0);
    assert.equal(exitPayload.reason, null);
  } finally {
    await app.close();
  }
});

test('input / resize / focus / context round-trip through the service', async () => {
  const app = await makeApp();
  const record = await seedHost(app);

  try {
    const opened = await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: record.id } });
    assert.equal(opened.status, 200, opened.text);
    const { sid } = opened.json;
    assert.equal(sid, 's1');
    assert.equal(opened.json.session.status, 'connecting');
    const fake = app.created[0];

    const input = await request(`${app.baseUrl}/api/dsh-ssh/input`, {
      method: 'POST',
      body: { sid, data: Buffer.from('ls\n').toString('base64') },
    });
    assert.equal(input.status, 200);
    assert.equal(fake.sent[0].toString('utf8'), 'ls\n');

    const resize = await request(`${app.baseUrl}/api/dsh-ssh/resize`, { method: 'POST', body: { sid, cols: 120, rows: 40 } });
    assert.equal(resize.status, 200);
    assert.deepEqual(fake.size, { cols: 120, rows: 40 });

    const focus = await request(`${app.baseUrl}/api/dsh-ssh/focus`, { method: 'POST', body: { sid } });
    assert.equal(focus.status, 200);
    assert.equal(focus.json.activeSid, 's1');

    // context：中文 + ANSI 都不许乱码，取最后 N 行。
    fake.emit('第一行\r\n\u001b[32m第二行\u001b[0m\r\n第三行\r\n');
    const context = await request(`${app.baseUrl}/api/dsh-ssh/context?sid=${sid}&lines=2`);
    assert.equal(context.status, 200);
    assert.equal(context.json.status, 'connecting');
    assert.equal(context.json.host.id, record.id);
    assert.equal(context.json.tail, '\u001b[32m第二行\u001b[0m\n第三行');
    // 缓冲里有 3 行、只要 2 行 -> 确实截断了。
    assert.equal(context.json.gap.truncated, true);
    // 要够所有行 -> 没有截断。
    const full = await request(`${app.baseUrl}/api/dsh-ssh/context?sid=${sid}&lines=10`);
    assert.equal(full.json.gap.truncated, false);
    assert.equal(full.json.tail, '第一行\n\u001b[32m第二行\u001b[0m\n第三行');

    const hosts = await request(`${app.baseUrl}/api/dsh-ssh/hosts`);
    assert.equal(hosts.status, 200);
    assert.equal(hosts.json.hosts.length, 1);
    assert.equal(hosts.json.hosts[0].sid, 's1');
    assert.equal(hosts.json.hosts[0].status, 'connecting');
    assert.equal(hosts.json.activeSid, 's1');
  } finally {
    await app.close();
  }
});

test('GET /hosts leaks no secret: no password, no privateKey, no iv/tag/ct', async () => {
  const app = await makeApp();
  const record = await seedHost(app);
  const pemHost = await seedHost(app, {
    host: 'key.example.com',
    username: 'git',
    auth: { kind: 'privateKey', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA-secret-pem\n-----END OPENSSH PRIVATE KEY-----\n' },
  });
  await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: record.id } });
  await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: pemHost.id } });

  try {
    const res = await request(`${app.baseUrl}/api/dsh-ssh/hosts`);
    assert.equal(res.status, 200);
    // 验收断言（逐条独立 grep，失败时能一眼看出是哪个词泄漏的）。
    for (const banned of ['password', 'privateKey', '"ct"', '"iv"', '"tag"', SECRET, 'AAAA-secret-pem']) {
      assert.equal(res.text.includes(banned), false, `GET /hosts must not contain ${banned}`);
    }
    // 该有的字段一个不少。
    assert.equal(res.json.hosts.length, 2);
    assert.deepEqual(Object.keys(res.json.hosts[0]).sort(), [
      'authKind', 'error', 'hasSecret', 'host', 'id', 'label', 'port', 'sid', 'status', 'username',
    ]);
    assert.equal(res.json.hosts[0].authKind, 'pass');
    assert.equal(res.json.hosts[1].authKind, 'key');
    // sessions 数组同样不许泄漏。
    assert.equal(JSON.stringify(res.json.sessions).includes(SECRET), false);
  } finally {
    await app.close();
  }
});

test('open -> close -> open cycles cleanly and close frees the sid', async () => {
  const app = await makeApp();
  const record = await seedHost(app);

  try {
    const first = await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: record.id } });
    assert.equal(first.json.sid, 's1');
    assert.equal(app.service.list().length, 1);

    const closed = await request(`${app.baseUrl}/api/dsh-ssh/close`, { method: 'POST', body: { sid: 's1' } });
    assert.equal(closed.status, 200);
    assert.deepEqual(closed.json, { ok: true, sid: 's1' });
    assert.equal(app.service.list().length, 0);
    // 关闭后主机状态回到 offline。
    const afterClose = await request(`${app.baseUrl}/api/dsh-ssh/hosts`);
    assert.equal(afterClose.json.hosts[0].status, 'offline');
    assert.equal(afterClose.json.hosts[0].sid, null);

    // 再开一次：sid 单调递增，不复用。
    const second = await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: record.id } });
    assert.equal(second.status, 200);
    assert.equal(second.json.sid, 's2');
    assert.equal(app.created.length, 2, 'a fresh transport per open');

    // 关不存在的会话 -> 404 unknown-session。
    const missing = await request(`${app.baseUrl}/api/dsh-ssh/close`, { method: 'POST', body: { sid: 's9' } });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'unknown-session');

    // 开不存在的主机 -> 404 unknown-host。
    const badHost = await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: 'h-deadbeef' } });
    assert.equal(badHost.status, 404);
    assert.equal(badHost.json.code, 'unknown-host');
  } finally {
    await app.close();
  }
});

test('DELETE /hosts/<id> closes every session of that host and removes the record', async () => {
  const app = await makeApp();
  const record = await seedHost(app);
  const other = await seedHost(app, { host: '10.0.0.10' });

  try {
    // 一主机两个标签 + 另一台主机一个会话。
    await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: record.id } });
    await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: record.id } });
    await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: other.id } });
    assert.equal(app.service.list().length, 3);

    const deleted = await request(`${app.baseUrl}/api/dsh-ssh/hosts/${record.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200, deleted.text);
    assert.deepEqual(deleted.json, { ok: true, closed: ['s1', 's2'] });
    // 目标主机的会话全没了，另一台不受影响。
    assert.deepEqual(app.service.list().map((session) => session.sid), ['s3']);
    assert.deepEqual(app.service.listByHost(record.id), []);

    // 记录与密文都删干净了（不留孤儿）。
    assert.equal(app.store.has(record.id), false);
    assert.equal(app.storageDomain.snapshot().dsh_ssh.secrets[record.id], undefined);

    // 再删一次 -> 404。
    const again = await request(`${app.baseUrl}/api/dsh-ssh/hosts/${record.id}`, { method: 'DELETE' });
    assert.equal(again.status, 404);
    assert.equal(again.json.code, 'unknown-host');
  } finally {
    await app.close();
  }
});

test('exact and prefix routes coexist: /hosts is exact, /hosts/<id> is prefix', async () => {
  const app = await makeApp();
  const record = await seedHost(app);

  try {
    // 断言 1：集合路径走 exact（返回 hosts 数组，而不是被 prefix 当成 id=''）。
    const collection = await request(`${app.baseUrl}/api/dsh-ssh/hosts`);
    assert.equal(collection.status, 200);
    assert.equal(Array.isArray(collection.json.hosts), true);
    assert.equal(collection.json.hosts.length, 1);

    // 断言 2：`/hosts/<id>` 走 prefix（PATCH 能改到那条记录）。
    const patched = await request(`${app.baseUrl}/api/dsh-ssh/hosts/${record.id}`, {
      method: 'PATCH',
      body: { label: '改名了', port: 2200 },
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.json.host.id, record.id);
    assert.equal(patched.json.host.label, '改名了');
    assert.equal(patched.json.host.port, 2200);

    // 断言 3：prefix 路径上的未知 id 是 404 unknown-host（说明真的解析出了 id）。
    const unknown = await request(`${app.baseUrl}/api/dsh-ssh/hosts/h-deadbeef`, { method: 'PATCH', body: { label: 'x' } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.code, 'unknown-host');

    // 断言 4：注册表里两条路由 kind 不同、path 相同（同 kind 同 path 会被
    // 真 webServer 拒绝，见 index.ts:366）。
    const hostRoutes = app.ctx.routes.filter((route) => route.path === '/api/dsh-ssh/hosts');
    assert.deepEqual(hostRoutes.map((route) => route.kind).sort(), ['exact', 'prefix']);
  } finally {
    await app.close();
  }
});

test('PATCH without auth keeps the stored secret (no re-encryption, no loss)', async () => {
  const app = await makeApp();
  const record = await seedHost(app);
  const before = app.storageDomain.snapshot().dsh_ssh.secrets[record.id];

  try {
    const patched = await request(`${app.baseUrl}/api/dsh-ssh/hosts/${record.id}`, { method: 'PATCH', body: { label: '只改名字' } });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.host.hasSecret, true);
    const after = app.storageDomain.snapshot().dsh_ssh.secrets[record.id];
    assert.equal(after.ct, before.ct, 'ct must be byte-identical when auth is omitted');
    // 密文仍可解（走 store 的内部出口验证，HTTP 层不会返回明文）。
    assert.deepEqual(await app.store.getAuth(record.id), { kind: 'pass', password: SECRET });

    // 用新口令覆盖 -> 新密文。
    const rotated = await request(`${app.baseUrl}/api/dsh-ssh/hosts/${record.id}`, {
      method: 'PATCH',
      body: { auth: { kind: 'password', password: 'brand-new-pass' } },
    });
    assert.equal(rotated.status, 200);
    const rotatedBox = app.storageDomain.snapshot().dsh_ssh.secrets[record.id];
    assert.notEqual(rotatedBox.ct, before.ct);
    assert.deepEqual(await app.store.getAuth(record.id), { kind: 'pass', password: 'brand-new-pass' });
  } finally {
    await app.close();
  }
});

test('POST /hosts validates input and rejects duplicates', async () => {
  const app = await makeApp();
  try {
    const created = await request(`${app.baseUrl}/api/dsh-ssh/hosts`, {
      method: 'POST',
      body: { label: '新机器', host: '10.1.1.1', port: 22, username: 'root', auth: { kind: 'password', password: SECRET } },
    });
    assert.equal(created.status, 201);
    assert.match(created.json.host.id, /^h-[0-9a-f]{8}$/);
    assert.equal(created.json.host.hasSecret, true);
    assert.equal(created.text.includes(SECRET), false, 'the response must not echo the password');

    const duplicate = await request(`${app.baseUrl}/api/dsh-ssh/hosts`, {
      method: 'POST',
      body: { host: '10.1.1.1', port: 22, username: 'root' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.code, 'duplicate-host');

    const invalid = await request(`${app.baseUrl}/api/dsh-ssh/hosts`, { method: 'POST', body: { host: '' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, 'invalid-host');
  } finally {
    await app.close();
  }
});

test('without a storage layer the routes degrade instead of crashing', async () => {
  const fallbackHosts = [
    {
      id: 'h-0000aaaa',
      label: 'patch 主机',
      host: '127.0.0.1',
      port: 22,
      username: 'me',
      authKind: 'none',
      hasSecret: false,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ];
  const app = await makeApp({ withStore: false, fallbackHosts });
  try {
    // 只读列表仍然可用（设计 §2.1 的降级路径）。
    const hosts = await request(`${app.baseUrl}/api/dsh-ssh/hosts`);
    assert.equal(hosts.status, 200);
    assert.equal(hosts.json.hosts.length, 1);
    assert.equal(hosts.json.hosts[0].id, 'h-0000aaaa');
    assert.equal(hosts.json.hosts[0].status, 'offline');

    // 写操作统一 501 storage-unavailable。
    for (const [method, path, body] of [
      ['POST', '/api/dsh-ssh/hosts', { host: '1.2.3.4' }],
      ['PATCH', '/api/dsh-ssh/hosts/h-0000aaaa', { label: 'x' }],
      ['DELETE', '/api/dsh-ssh/hosts/h-0000aaaa', undefined],
      ['POST', '/api/dsh-ssh/open', { hostId: 'h-0000aaaa' }],
    ]) {
      const res = await request(`${app.baseUrl}${path}`, { method, body });
      assert.equal(res.status, 501, `${method} ${path} -> ${res.status}`);
      assert.equal(res.json.code, 'storage-unavailable');
    }
  } finally {
    await app.close();
  }
});

test('resize echoes the clamped values, not the requested ones (P2-3)', async () => {
  const app = await makeApp();
  const { sid } = app.service.open({ host: { id: 'local', host: '127.0.0.1' } }); // 默认 80x24
  const fake = app.created[0];

  try {
    // 越界值：service 对越界字段保持会话当前值（cols 5000 -> 80），合法字段
    // 原样通过（rows 40）。回显必须是应用后的值，不能把请求值糊弄回去。
    const clamped = await request(`${app.baseUrl}/api/dsh-ssh/resize`, { method: 'POST', body: { sid, cols: 5000, rows: 40 } });
    assert.equal(clamped.status, 200);
    assert.deepEqual(clamped.json, { ok: true, cols: 80, rows: 40 });
    // 钳制同样作用在传输层，不只是回显。
    assert.deepEqual(fake.size, { cols: 80, rows: 40 });

    // 合法值原样通过。
    const ok = await request(`${app.baseUrl}/api/dsh-ssh/resize`, { method: 'POST', body: { sid, cols: 120, rows: 24 } });
    assert.deepEqual(ok.json, { ok: true, cols: 120, rows: 24 });
    assert.deepEqual(fake.size, { cols: 120, rows: 24 });
  } finally {
    await app.close();
  }
});

test('wrong HTTP methods are rejected with 405', async () => {
  const app = await makeApp();
  try {
    assert.equal((await request(`${app.baseUrl}/api/dsh-ssh/stream`, { method: 'POST', body: {} })).status, 405);
    // /hosts 只收 GET/POST；PUT 不在名单里。
    assert.equal((await request(`${app.baseUrl}/api/dsh-ssh/hosts`, { method: 'PUT', body: {} })).status, 405);
    // prefix 路由只收 PATCH/DELETE。
    assert.equal((await request(`${app.baseUrl}/api/dsh-ssh/hosts/h-0000aaaa`, { method: 'POST', body: {} })).status, 405);
    assert.equal((await request(`${app.baseUrl}/api/dsh-ssh/open`)).status, 405);
    assert.equal((await request(`${app.baseUrl}/api/dsh-ssh/close`, { method: 'GET' })).status, 405);
    assert.equal((await request(`${app.baseUrl}/api/dsh-ssh/context?sid=s1`, { method: 'POST', body: {} })).status, 405);
  } finally {
    await app.close();
  }
});

test('PATCH with a secretless auth or auth:null never destroys the stored secret', async () => {
  const app = await makeApp();
  const record = await seedHost(app);
  const before = app.storageDomain.snapshot().dsh_ssh.secrets[record.id];

  try {
    // 编辑表单里"选了口令认证但密码框留空"= 保持不变（客户端契约）。
    const secretless = await request(`${app.baseUrl}/api/dsh-ssh/hosts/${record.id}`, {
      method: 'PATCH',
      body: { label: '留空密码', auth: { kind: 'password' } },
    });
    assert.equal(secretless.status, 200, secretless.text);
    assert.equal(secretless.json.host.hasSecret, true);

    // `auth: null` 也必须被当成"没给"，而不是"清空"。
    const nullAuth = await request(`${app.baseUrl}/api/dsh-ssh/hosts/${record.id}`, {
      method: 'PATCH',
      body: { auth: null },
    });
    assert.equal(nullAuth.status, 200, nullAuth.text);
    assert.equal(nullAuth.json.host.hasSecret, true);

    const after = app.storageDomain.snapshot().dsh_ssh.secrets[record.id];
    assert.equal(after.ct, before.ct, 'ct must survive both no-op patches');
    assert.deepEqual(await app.store.getAuth(record.id), { kind: 'pass', password: SECRET });

    // 只有显式 kind:'none' 才清空。
    const cleared = await request(`${app.baseUrl}/api/dsh-ssh/hosts/${record.id}`, {
      method: 'PATCH',
      body: { auth: { kind: 'none' } },
    });
    assert.equal(cleared.json.host.hasSecret, false);
    assert.equal(app.storageDomain.snapshot().dsh_ssh.secrets[record.id], undefined);
  } finally {
    await app.close();
  }
});

test('the connection layer rejection wins over everything (first thing every route does)', async () => {
  const app = await makeApp({ reject: 403 });
  try {
    for (const [method, path] of [
      ['GET', '/api/dsh-ssh/hosts'],
      ['POST', '/api/dsh-ssh/hosts'],
      ['POST', '/api/dsh-ssh/open'],
      ['GET', '/api/dsh-ssh/stream?sid=s1'],
    ]) {
      const res = await request(`${app.baseUrl}${path}`, { method, body: method === 'POST' ? {} : undefined });
      assert.equal(res.status, 403, `${method} ${path} must be rejected by ctx.connection`);
    }
  } finally {
    await app.close();
  }
});

// ── 传输控制帧的线路格式（2026-10-25 真机：rz 有反应、浮层永不出现） ─────────
//
// 根因是 /transfer/events 用了 `formatSseFrame`——那是给终端字节流用的，
// 会把入参当 `{seq, data}` 打包成 `{seq, chunk}`。传一个传输事件进去，两个
// 字段都取不到，`JSON.stringify` 直接吐 `{}`，客户端只收到两个空对象。
// 这一组用例把"线上到底长什么样"钉住。

test('/transfer/events 发的是原始事件对象，不是 {seq, chunk} 包装', async () => {
  /** 订阅者句柄：测试里手动推事件。 */
  let listener = null;
  const fakeTransfer = {
    onEvent(sid, callback) {
      listener = callback;
      return () => { listener = null; };
    },
    isActive: () => true,
    attach() {},
    detach() {},
    dispose() {},
    cancel: () => false,
    interceptInput: () => false,
  };
  const app = await makeApp({ transfer: fakeTransfer });
  try {
    const record = await seedHost(app);
    const opened = await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: record.id } });
    const sid = opened.json.sid;

    const streamed = getStream(`${app.baseUrl}/api/dsh-ssh/transfer/events?sid=${sid}`, { autoCloseAfterMs: 400 });
    // 等订阅挂上再推事件。
    for (let i = 0; i < 40 && listener === null; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.notEqual(listener, null, '订阅必须挂上');
    listener({ type: 'transfer', phase: 'need-file' });
    listener({ type: 'transfer', phase: 'start', mode: 'send' });
    const res = await streamed;

    const frames = parseFrames(res.body);
    assert.deepEqual(frames, [
      { type: 'transfer', phase: 'need-file' },
      { type: 'transfer', phase: 'start', mode: 'send' },
    ], `事件对象必须原样过线，实际收到 ${JSON.stringify(frames)}`);
    // 反向守卫：绝不能是 {seq, chunk} 那种空壳。
    assert.equal(frames.some((frame) => 'chunk' in frame), false, '不能套终端分片的壳');
  } finally {
    await app.close();
  }
});

test('传输中按 Ctrl+C 走取消，不往 PTY 写 0x03', async () => {
  /** 记下被拦下的输入。 */
  const intercepted = [];
  const fakeTransfer = {
    onEvent: () => () => {},
    isActive: () => true,
    attach() {},
    detach() {},
    dispose() {},
    cancel: () => true,
    interceptInput(sid, bytes) {
      intercepted.push({ sid, bytes: [...bytes] });
      return bytes.includes(0x03);
    },
  };
  const app = await makeApp({ transfer: fakeTransfer });
  try {
    const record = await seedHost(app);
    const opened = await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: record.id } });
    const sid = opened.json.sid;
    const transport = app.created.at(-1);
    transport.sent.length = 0;

    const res = await request(`${app.baseUrl}/api/dsh-ssh/input`, {
      method: 'POST',
      body: { sid, data: Buffer.from([0x03]).toString('base64') },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.cancelled, true, 'Ctrl+C 要被翻译成取消');
    assert.equal(intercepted.length, 1);
    assert.equal(transport.sent.length, 0, '被拦下的字节不该再写进 PTY');

    // 普通按键照旧进 PTY。
    await request(`${app.baseUrl}/api/dsh-ssh/input`, { method: 'POST', body: { sid, data: Buffer.from('ls\n').toString('base64') } });
    assert.equal(Buffer.concat(transport.sent).toString('utf8'), 'ls\n');
  } finally {
    await app.close();
  }
});

test('POST /transfer/cancel 转发给协议机并回 cancelled', async () => {
  const cancelledSids = [];
  const fakeTransfer = {
    onEvent: () => () => {},
    isActive: () => true,
    attach() {},
    detach() {},
    dispose() {},
    cancel(sid) { cancelledSids.push(sid); return true; },
    interceptInput: () => false,
  };
  const app = await makeApp({ transfer: fakeTransfer });
  try {
    const record = await seedHost(app);
    const opened = await request(`${app.baseUrl}/api/dsh-ssh/open`, { method: 'POST', body: { hostId: record.id } });
    const sid = opened.json.sid;
    const res = await request(`${app.baseUrl}/api/dsh-ssh/transfer/cancel`, { method: 'POST', body: { sid } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, cancelled: true });
    assert.deepEqual(cancelledSids, [sid]);
  } finally {
    await app.close();
  }
});
