#!/usr/bin/env node
/**
 * 端到端验证：真实 sshd + 真实 ssh2 + 真实 HTTP 路由 + 真实 SSE。
 *
 * 单测用假 transport 覆盖服务层逻辑；本脚本补上唯一没被证明的一环——
 * ssh2 握手、PTY 通道、远端回显字节一路流到 SSE 帧并被正确解码。
 * 没有真实 sshd 时它打印搭建方法并以 SKIP 退出（不影响 `npm test`）。
 *
 * M1 起这条路还要穿过持久化层：假 `storageDomain` + 假 `credentials`（内存实现，
 * 与单测共用 `tests/stubs/fake-services.mjs`），所以"播种 -> 信封加密 ->
 * POST /open 解密 -> ssh2 连接"整条链在真实 sshd 上是通的。
 *
 * 用法：
 *   node scripts/e2e.mjs                       # 自动探测 127.0.0.1:2222
 *   node scripts/e2e.mjs --require             # 连不上就让命令失败（CI 用）
 *   E2E_HOST=10.0.0.5 E2E_PORT=22 E2E_USER=root E2E_PASSWORD=xxx node scripts/e2e.mjs
 *
 * 最快的本地 sshd（Docker）：
 *   docker run -d --name dsh-ssh-e2e -p 127.0.0.1:2222:22 alpine:latest sleep 7200
 *   docker exec dsh-ssh-e2e sh -c 'apk add --no-cache openssh && ssh-keygen -A \
 *     && echo "root:dsh-test-123" | chpasswd && /usr/sbin/sshd'
 */
import http from 'node:http';
import net from 'node:net';
import { apply } from '../lib/index.js';
import {
  createFakeCredentials,
  createFakeCtx,
  createFakeStorageDomain,
  mountRoutes,
  request,
} from '../tests/stubs/fake-services.mjs';

const HOST = process.env.E2E_HOST ?? '127.0.0.1';
const PORT = Number(process.env.E2E_PORT ?? 2222);
const USER = process.env.E2E_USER ?? 'root';
const PASSWORD = process.env.E2E_PASSWORD ?? 'dsh-test-123';
const REQUIRE = process.argv.includes('--require');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

/** TCP 预检：连不上就别浪费时间起服务。 */
function reachable(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(3000);
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
  });
}

/** 收 SSE 帧直到超时，返回原始文本。 */
function readSse(port, query, ms) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = http.get({ host: '127.0.0.1', port, path: `/api/dsh-ssh/stream?${query}` }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(chunks.join('')));
    });
    req.on('error', () => resolve(chunks.join('')));
    setTimeout(() => {
      req.destroy();
      resolve(chunks.join(''));
    }, ms);
  });
}

/** 从 SSE 文本取出所有 data 帧的 chunk 并解码。 */
function decodeSseChunks(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((candidate) => candidate.startsWith('data: '));
    if (line === undefined) continue;
    try {
      const frame = JSON.parse(line.slice(6));
      if (typeof frame.chunk === 'string' && frame.chunk !== '') {
        out.push(Buffer.from(frame.chunk, 'base64').toString('utf8'));
      }
    } catch {
      // 非 JSON 帧（注释、exit、meta）不参与回显拼接。
    }
  }
  return out.join('');
}

if (!(await reachable(HOST, PORT))) {
  console.log(`SKIP  连不上 ${HOST}:${PORT}，未运行端到端验证。`);
  console.log('      需要真实 sshd。最快的本地搭建（Docker）：');
  console.log('      docker run -d --name dsh-ssh-e2e -p 127.0.0.1:2222:22 alpine:latest sleep 7200');
  console.log("      docker exec dsh-ssh-e2e sh -c 'apk add --no-cache openssh && ssh-keygen -A \\");
  console.log('        && echo "root:dsh-test-123" | chpasswd && /usr/sbin/sshd\'');
  console.log('      或用 --require 让连不上时命令失败（CI 用）。');
  process.exit(REQUIRE ? 1 : 0);
}

// 假服务：内存 storageDomain + credentials。密钥真的会被生成并加密口令。
const storageDomain = createFakeStorageDomain();
const credentials = createFakeCredentials();
const ctx = createFakeCtx({ storageDomain, credentials });

const server = await mountRoutes(ctx);
const httpPort = server.port;
const base = server.baseUrl;
console.log(`e2e: http :${httpPort} → sshd ${HOST}:${PORT}\n`);

const get = (path) => request(`${base}${path}`);
const post = (path, body) => request(`${base}${path}`, { method: 'POST', body });

let dispose;
try {
  dispose = await apply(ctx, {
    host: HOST,
    port: PORT,
    username: USER,
    password: PASSWORD,
    label: 'e2e',
    autoOpenFirst: true,
  });
  // 持久化层的引导是异步的（open 域 -> 播种 -> autoOpenFirst）。
  await dispose.ready;

  // 1. 播种 + 自动开服：主机表里有一台，状态进入 open
  let host = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const payload = JSON.parse((await get('/api/dsh-ssh/hosts')).text);
    host = payload.hosts?.[0] ?? null;
    if (host?.status === 'open') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check('播种 + autoOpenFirst：ssh2 真实连接并进入 open', host?.status === 'open', `status=${host?.status} sid=${host?.sid} id=${host?.id}`);
  check('播种出来的主机 id 是 h-<8hex> 且带凭据', /^h-[0-9a-f]{8}$/.test(host?.id ?? '') && host?.hasSecret === true, `${host?.id} hasSecret=${host?.hasSecret}`);

  const sid = host?.sid ?? null;
  if (sid !== null) {
    // 2. 敲一条命令，回显应出现在 SSE 里
    await post('/api/dsh-ssh/input', { sid, data: Buffer.from('echo DSH_SSH_E2E_OK\n').toString('base64') });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const decoded = decodeSseChunks(await readSse(httpPort, `sid=${sid}&since=0`, 2500));
    check('echo 回显可读', decoded.includes('DSH_SSH_E2E_OK'), `${decoded.length} 字节回显`);

    // 3. 第二条命令：确认远端真的是 Linux
    await post('/api/dsh-ssh/input', { sid, data: Buffer.from('uname -a\n').toString('base64') });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const decoded2 = decodeSseChunks(await readSse(httpPort, `sid=${sid}&since=0`, 2500));
    const banner = decoded2.split('\n').find((line) => line.includes('Linux'))?.trim() ?? '无';
    check('uname -a 回显包含 Linux', decoded2.includes('Linux'), banner);

    // 4. resize 回显钳制后的值
    const resize = await post('/api/dsh-ssh/resize', { sid, cols: 120, rows: 40 });
    check('resize 生效', resize.status === 200, resize.text);

    // 5. focus 上报成为 activeSid
    const focus = JSON.parse((await post('/api/dsh-ssh/focus', { sid })).text);
    check('focus 上报成为 activeSid', focus.activeSid === sid, focus.activeSid);

    // 6. 迟到连接：会话还活着，不能误发 exit
    const late = await readSse(httpPort, `sid=${sid}&since=1`, 1500);
    check('迟到连接不误发 exit', !late.includes('event: exit'), `${late.length} 字节`);

    // 7. context：右栏上下文卡的数据源，tail 里应有刚才的输出
    const context = JSON.parse((await get(`/api/dsh-ssh/context?sid=${sid}&lines=20`)).text);
    check('context 返回 tail 与状态', context.status === 'open' && context.tail.includes('Linux'), `${context.tail.length} 字符 tail`);
    check('context 的 host 无秘密字段', !JSON.stringify(context.host).includes('password') && context.host.id === host.id, JSON.stringify(context.host));

    // 8. 响应体纪律：/hosts 里 grep 不到任何秘密
    const hostsBody = (await get('/api/dsh-ssh/hosts')).text;
    const banned = ['password', 'privateKey', '"ct"', '"iv"', '"tag"', PASSWORD];
    const leaked = banned.filter((token) => hostsBody.includes(token));
    check('GET /hosts 响应体无秘密泄漏', leaked.length === 0, leaked.length === 0 ? `${hostsBody.length} 字节` : `泄漏: ${leaked.join(',')}`);

    // 9. close：会话真的关掉，主机状态回到 offline
    const closed = await post('/api/dsh-ssh/close', { sid });
    check('POST /close 关闭会话', closed.status === 200, closed.text);
    const afterClose = JSON.parse((await get('/api/dsh-ssh/hosts')).text);
    check('关闭后主机回到 offline', afterClose.hosts[0].status === 'offline' && afterClose.sessions.length === 0, `status=${afterClose.hosts[0].status}`);

    // 10. 再 open 一次：凭据从密文里解出来，真的能重连
    const reopened = await post('/api/dsh-ssh/open', { hostId: host.id });
    const newSid = JSON.parse(reopened.text).sid ?? null;
    let reopenedStatus = null;
    const reopenDeadline = Date.now() + 20000;
    while (Date.now() < reopenDeadline) {
      const payload = JSON.parse((await get('/api/dsh-ssh/hosts')).text);
      reopenedStatus = payload.hosts?.[0]?.status ?? null;
      if (reopenedStatus === 'open') break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    check('POST /open 用解密后的凭据重连成功', reopenedStatus === 'open' && newSid !== null && newSid !== sid, `sid=${newSid} status=${reopenedStatus}`);

    // 11. DELETE：关掉该主机的全部会话并删除记录
    const deleted = await request(`${base}/api/dsh-ssh/hosts/${host.id}`, { method: 'DELETE' });
    const deletedPayload = JSON.parse(deleted.text);
    const finalHosts = JSON.parse((await get('/api/dsh-ssh/hosts')).text);
    check(
      'DELETE /hosts/<id> 关会话并删除记录',
      deleted.status === 200 && Array.isArray(deletedPayload.closed) && finalHosts.hosts.length === 0 && finalHosts.sessions.length === 0,
      `closed=${JSON.stringify(deletedPayload.closed)} hosts=${finalHosts.hosts.length}`,
    );
  }
} catch (error) {
  check('脚本未抛异常', false, String(error));
} finally {
  if (dispose !== undefined) await dispose();
  await server.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
