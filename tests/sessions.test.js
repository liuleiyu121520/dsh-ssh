/**
 * SshSessionService 的 node --test 测试。
 *
 * 全部走 createFakeTransport——不起 http server、不连 sshd，验证的是
 * service 层契约：sid 分配、有界滚动缓冲、seq 回放、错误路径，以及
 * "远端输出 -> 缓冲 -> SSE 帧"的端到端路径。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionNotFoundError, SshSessionService } from '../src/sessions.js';
import { createFakeTransport } from '../src/transport.js';
import { formatSseFrame } from '../src/routes.js';

/**
 * 造一个注入了 fake transport 的 service，并捕获每次创建的 transport 实例。
 * @param {object} [options] 传给 SshSessionService 的选项。
 * @returns {{service: SshSessionService, created: object[]}} 服务与实例表。
 */
function makeService(options = {}) {
  /** @type {object[]} */
  const created = [];
  const service = new SshSessionService({
    createTransport: (config, handlers) => {
      const transport = createFakeTransport(config, handlers);
      created.push(transport);
      return transport;
    },
    ...options,
  });
  return { service, created };
}

/** 本机测试主机的连接配置。 */
const LOCAL_HOST = { id: 'local', label: '本机', host: '127.0.0.1', port: 22, username: 'tester' };

test('open allocates monotonic sids and close removes the session', () => {
  const { service } = makeService();
  const first = service.open({ host: LOCAL_HOST });
  const second = service.open({ host: LOCAL_HOST });
  assert.equal(first.sid, 's1');
  assert.equal(second.sid, 's2');
  assert.equal(service.list().length, 2);
  assert.equal(first.status, 'connecting');
  assert.equal(first.cols, 80);
  assert.equal(first.rows, 24);

  service.close(first.sid);
  assert.equal(service.list().length, 1);
  assert.equal(service.list()[0].sid, 's2');
  assert.throws(() => service.get('s1'), SessionNotFoundError);
});

test('read(since) replays only chunks with seq > since, base64 round-trips', () => {
  const { service, created } = makeService();
  const { sid } = service.open({ host: LOCAL_HOST });
  const fake = created[0];

  fake.emit('hello ');
  fake.emit('world');

  const all = service.read(sid, 0);
  assert.equal(all.seq, 2);
  assert.equal(all.chunks.length, 2);
  assert.equal(all.chunks[0].seq, 1);
  assert.equal(Buffer.from(all.chunks[0].data, 'base64').toString('utf8'), 'hello ');
  assert.equal(Buffer.from(all.chunks[1].data, 'base64').toString('utf8'), 'world');
  assert.equal(all.truncated, false);

  const afterFirst = service.read(sid, 1);
  assert.equal(afterFirst.chunks.length, 1);
  assert.equal(afterFirst.chunks[0].seq, 2);
  assert.equal(Buffer.from(afterFirst.chunks[0].data, 'base64').toString('utf8'), 'world');

  // since 已是最新：无分片可放。
  assert.equal(service.read(sid, 2).chunks.length, 0);
});

test('buffer limits truncate and flag the session as truncated', () => {
  // 字节上限 64KB，远小于下面写入的 160KB。
  const { service, created } = makeService({ maxBufferBytes: 64 * 1024 });
  const { sid } = service.open({ host: LOCAL_HOST });
  const fake = created[0];

  for (let index = 0; index < 40; index += 1) fake.emit('x'.repeat(4096));

  const replay = service.read(sid, 0);
  assert.equal(replay.truncated, true);
  const bytes = replay.chunks.reduce((total, chunk) => total + Buffer.from(chunk.data, 'base64').length, 0);
  assert.ok(bytes <= 64 * 1024, `buffer kept ${bytes} bytes, over the limit`);
  // 最新一屏必须还在：最后一个分片是最后写入的内容。
  assert.equal(Buffer.from(replay.chunks[replay.chunks.length - 1].data, 'base64').toString(), 'x'.repeat(4096));
});

test('buffer line limit truncates by line count', () => {
  const { service, created } = makeService({ maxBufferLines: 100 });
  const { sid } = service.open({ host: LOCAL_HOST });
  const fake = created[0];

  // 250 行输出，超过 100 行上限。
  for (let index = 0; index < 250; index += 1) fake.emit(`line ${index}\n`);

  const replay = service.read(sid, 0);
  assert.equal(replay.truncated, true);
  const lines = replay.chunks.reduce(
    (total, chunk) => total + (Buffer.from(chunk.data, 'base64').toString('utf8').match(/\n/g) ?? []).length,
    0,
  );
  assert.ok(lines <= 100, `buffer kept ${lines} lines, over the limit`);
});

test('send to an unknown sid throws without crashing the process', () => {
  const { service } = makeService();
  assert.throws(() => service.send('nope', 'ls\n'), SessionNotFoundError);
  assert.throws(() => service.resize('nope', 80, 24), SessionNotFoundError);
  assert.throws(() => service.read('nope', 0), SessionNotFoundError);
  assert.throws(() => service.subscribe('nope', () => {}), SessionNotFoundError);
  // 进程仍然活着：后续正常会话不受影响。
  const { sid } = service.open({ host: LOCAL_HOST });
  assert.equal(service.list().length, 1);
  assert.equal(sid, 's1');
});

test('send forwards bytes to the transport and resize updates both sides', () => {
  const { service, created } = makeService();
  const { sid } = service.open({ host: LOCAL_HOST, cols: 80, rows: 24 });
  const fake = created[0];

  service.send(sid, 'ls -la\n');
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0].toString('utf8'), 'ls -la\n');

  service.resize(sid, 120, 40);
  assert.deepEqual(fake.size, { cols: 120, rows: 40 });
  const described = service.list()[0];
  assert.equal(described.cols, 120);
  assert.equal(described.rows, 40);
});

test('subscribe receives live data events and exit on close', () => {
  const { service, created } = makeService();
  const { sid } = service.open({ host: LOCAL_HOST });
  const fake = created[0];

  /** @type {object[]} */
  const events = [];
  const unsubscribe = service.subscribe(sid, (event) => events.push(event));

  fake.emit('prompt$ ');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'data');
  assert.equal(events[0].seq, 1);
  assert.equal(Buffer.from(events[0].data, 'base64').toString('utf8'), 'prompt$ ');

  unsubscribe();
  fake.emit('after unsubscribe');
  assert.equal(events.length, 1, 'unsubscribed listener must not receive further events');

  service.subscribe(sid, (event) => events.push(event));
  service.close(sid);
  const last = events[events.length - 1];
  assert.equal(last.kind, 'exit');
  assert.equal(last.code, 0);
});

test('fake transport output reaches the SSE frame end to end', () => {
  const { service, created } = makeService();
  const { sid } = service.open({ host: LOCAL_HOST });
  const fake = created[0];

  fake.emit('total 0\r\ndrwxr-xr-x\r\n');
  const replay = service.read(sid, 0);
  assert.equal(replay.chunks.length, 1);

  const frame = formatSseFrame(replay.chunks[0]);
  assert.match(frame, /^data: \{.*\}\n\n$/);
  const payload = JSON.parse(frame.slice('data: '.length, -2));
  assert.equal(payload.seq, replay.chunks[0].seq);
  assert.equal(Buffer.from(payload.chunk, 'base64').toString('utf8'), 'total 0\r\ndrwxr-xr-x\r\n');

  // 断线重连的续传帧：since=1 之后没有新数据。
  assert.equal(formatSseFrame.length >= 0, true);
  const resumed = service.read(sid, 1);
  assert.equal(resumed.chunks.length, 0);
  assert.equal(resumed.seq, 1);
});

test('open tolerates a transport factory that throws synchronously', () => {
  const service = new SshSessionService({
    createTransport: () => {
      throw new Error('boom');
    },
  });
  const described = service.open({ host: LOCAL_HOST });
  assert.equal(described.sid, 's1');
  assert.equal(described.status, 'error');
  assert.match(described.error, /boom/);
  // 路由仍可用：read/send 不会把进程带走。
  assert.throws(() => service.send(described.sid, 'x'), /no transport/);
});
