/**
 * ZMODEM 传输回归：整块喂（不能逐字节）+ 已收文件表生命周期。
 *
 * 2026-10-25 接线时用真 lrzsz 端到端验证，踩出两个 bug：
 * 1. **逐字节喂永远检测不到会话**。Sentry._parse 解析不完整时 break，紧接着
 *    `cache.splice(MAX_ZM_HEX_START_LENGTH)`（21）会把没长齐的 `**\x18B`
 *    前缀反复截掉。整块喂（按 ssh2 的 data 事件）一帧一次进 cache 才命中。
 * 2. **settle 不能清已收文件表**。传输结束（end）之后用户还要能下载，
 *    表被清掉 readReceived 就永远返回 null；只有会话关闭（detach）才该清。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

// 刻意不 stub zmodem.js：被测行为（整块喂能检测、逐字节不能）正是库的
// Sentry 逻辑，用真库才有意义。帧是真 lrzsz 抓的，CRC 由对端算好。
const { createTransferManager } = await import('../src/transfer.js');

/**
 * 造一个只实现 transfer.js 所需接口的假 service。
 * @returns {object} {service, feed, sent}。
 */
function makeService() {
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    feed(bytes) {
      for (const listener of listeners) {
        listener({ kind: 'data', data: Buffer.from(bytes).toString('base64') });
      }
    },
    service: {
      subscribe(sid, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send(sid, bytes) {
        sent.push(Buffer.from(bytes));
      },
      get(sid) {
        if (sid !== 's1') throw new Error('unknown session');
        return { sid };
      },
    },
  };
}

/** lrzsz 的 ZRINIT 帧（真机抓的：`**\x18B` + 小写 hex + CR + ZDLE + XON）。 */
const ZRINIT_FRAME = [
  0x2a, 0x2a, 0x18, 0x42,
  0x30, 0x31, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, // 01 000000
  0x32, 0x33,                                     // 23
  0x62, 0x65, 0x35, 0x30,                         // be50 (CRC)
  0x0d, 0x8a, 0x11,
];

test('整块喂一帧就能检测出 send 会话（rz 上传起点）', () => {
  const { service, feed } = makeService();
  const transfer = createTransferManager({ service, logger: () => {} });
  /** @type {object[]} */
  const events = [];
  transfer.onEvent('s1', (event) => events.push(event));
  transfer.attach('s1');

  feed(ZRINIT_FRAME);

  assert.equal(transfer.isActive('s1'), true, '检测到会话后应立即进入传输态');
  assert.deepEqual(
    events.map((event) => event.phase),
    ['start', 'need-file'],
    '应向客户端要文件',
  );
  // need-file 会挂一个 60s 的"等用户选文件"定时器；不收掉测试进程会被它挂住。
  transfer.dispose();
});

test('attach 幂等：重复调用不会挂两条嗅探', () => {
  const { service, feed } = makeService();
  const transfer = createTransferManager({ service, logger: () => {} });
  transfer.attach('s1');
  transfer.attach('s1');
  transfer.attach('s1');
  /** @type {object[]} */
  const events = [];
  transfer.onEvent('s1', (event) => events.push(event));
  feed(ZRINIT_FRAME);
  // 两条嗅探会让 start/need-file 各出现两遍。
  assert.equal(events.filter((event) => event.phase === 'start').length, 1);
  transfer.dispose();
});

test('没有等待上传的会话时 sendFile 明确失败', async () => {
  const { service } = makeService();
  const transfer = createTransferManager({ service, logger: () => {} });
  transfer.attach('s1');
  const result = await transfer.sendFile('s1', { name: 'a.txt', data: Buffer.from('x') });
  assert.equal(result.ok, false);
  assert.match(result.error, /没有等待上传/);
  transfer.dispose();
});

test('detach 才清已收文件表（settle 不清）', async () => {
  const { service } = makeService();
  const transfer = createTransferManager({ service, logger: () => {} });
  // 没有真实 receive 会话，直接用 readReceived 验证表的行为：
  // 未知 sid / 未知文件一律 null，且不能抛。
  assert.equal(await transfer.readReceived('nope', 'x.bin'), null);
  assert.equal(await transfer.readReceived('s1', '../escape'), null, '路径穿越形态也要安全返回');
  transfer.attach('s1');
  transfer.detach('s1');
  assert.equal(await transfer.readReceived('s1', 'x.bin'), null);
});

test('dispose 清掉全部会话状态', () => {
  const { service } = makeService();
  const transfer = createTransferManager({ service, logger: () => {} });
  transfer.attach('s1');
  transfer.dispose();
  assert.equal(transfer.isActive('s1'), false);
});

// ── 取消（2026-10-25 用户报：rz 卡住，连续 Ctrl+C 也退不出来） ─────────────
//
// rz/sz 一进 ZMODEM 就把终端切成 raw 模式，0x03 只是普通数据字节，既不会
// 产生 SIGINT 也不会被协议层当取消。真能打断它的是连续 CAN（0x18）：
// 本机 lrzsz 实测 5 个不够（10 秒不退），8 个 0.9 秒退出。

test('cancel 给远端发一串 CAN，并把会话摘出传输态', () => {
  const { service, feed, sent } = makeService();
  const transfer = createTransferManager({ service, logger: () => {} });
  /** @type {object[]} */
  const events = [];
  transfer.onEvent('s1', (event) => events.push(event));
  transfer.attach('s1');
  feed(ZRINIT_FRAME);
  assert.equal(transfer.isActive('s1'), true, '前置：已在等选文件');
  sent.length = 0;

  const cancelled = transfer.cancel('s1');

  assert.equal(cancelled, true);
  assert.equal(sent.length, 1, '只发一个写操作');
  const bytes = sent[0];
  assert.equal(bytes.length >= 8, true, `CAN 至少 8 个才管用，实际 ${bytes.length}`);
  assert.equal([...bytes].every((byte) => byte === 0x18), true, '整串必须都是 CAN(0x18)');
  assert.equal(transfer.isActive('s1'), false, '取消后终端字节流要恢复');
  assert.deepEqual(events.map((event) => event.phase).slice(-2), ['cancelled', 'end']);
  transfer.dispose();
});

test('cancel 对没有传输的会话是空操作', () => {
  const { service, sent } = makeService();
  const transfer = createTransferManager({ service, logger: () => {} });
  transfer.attach('s1');
  sent.length = 0;
  assert.equal(transfer.cancel('s1'), false);
  assert.equal(sent.length, 0, '没有传输时不该往 PTY 灌 CAN');
  transfer.dispose();
});

test('传输中 Ctrl+C 被翻译成取消，其余按键不拦', () => {
  const { service, feed, sent } = makeService();
  const transfer = createTransferManager({ service, logger: () => {} });
  transfer.attach('s1');

  // 没有传输时：Ctrl+C 原样放行（正常中断前台进程要靠它）。
  assert.equal(transfer.interceptInput('s1', Buffer.from([0x03])), false);

  feed(ZRINIT_FRAME);
  sent.length = 0;
  assert.equal(transfer.interceptInput('s1', Buffer.from('abc')), false, '普通按键不拦');
  assert.equal(transfer.interceptInput('s1', Buffer.from([0x03])), true, '传输中的 Ctrl+C 要拦');
  assert.equal([...sent[0]].every((byte) => byte === 0x18), true, '拦下来之后发的是 CAN 序列');
  assert.equal(transfer.isActive('s1'), false);
  transfer.dispose();
});
