/**
 * 真机验收：把 dsh-ssh-terminal 装进本机 dsh 后，连一台真实 SSH 服务器。
 *
 * 与 tests/real-host.smoke.mjs 的区别：
 *   - smoke 用 mkdtemp 的临时 DSH_HOME，验的是"插件与真 dsh 包的契约"；
 *   - 本脚本用**真实的 ~/.dsh**（desktop app 读的同一份数据），验的是
 *     "装机之后用户到底能不能用"：播种 → 存密码（加密）→ 连接 → 敲命令 →
 *     回显 → 重启 dsh 后主机与密码还在。
 *
 * 口令只从环境变量 REAL_SSH_PASSWORD 读，绝不写进任何文件、绝不打印。
 * 用法：
 *   REAL_SSH_PASSWORD='...' node scripts/real-server.mjs [host] [port] [user]
 */

import { createRequire } from 'node:module';
import { readFile, readdir, stat, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const HERE = new URL('.', import.meta.url).pathname;
const PLUGIN_ROOT = resolve(HERE, '..');
const HARNESS_ROOT = '/Users/leiyu/code/pre-study/deepseek-harness';
const P = join(HARNESS_ROOT, 'packages');
const PROFILE = join(homedir(), '.dsh/profiles/desktop');

const SSH_HOST = process.argv[2] ?? '120.53.14.173';
const SSH_PORT = Number(process.argv[3] ?? 22);
const SSH_USER = process.argv[4] ?? 'root';
const PASSWORD = process.env.REAL_SSH_PASSWORD ?? '';

if (PASSWORD === '') {
  console.error('缺少 REAL_SSH_PASSWORD 环境变量（口令不落盘，只走环境变量）');
  process.exit(2);
}

/** @type {Array<{ok: boolean, name: string, detail: string}>} */
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ ok: Boolean(ok), name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `\n      ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chain(error) {
  const parts = [];
  let cur = error;
  while (cur) {
    parts.push(`${cur.code ? `[${cur.code}] ` : ''}${cur.message}`);
    cur = cur.cause;
  }
  return parts.join(' ← ');
}

async function reachable(host, port) {
  const net = await import('node:net');
  return new Promise((res) => {
    const sock = net.connect({ host, port, timeout: 4000 });
    sock.once('connect', () => { sock.destroy(); res(true); });
    sock.once('error', () => res(false));
    sock.once('timeout', () => { sock.destroy(); res(false); });
  });
}

async function httpRequest(url, options = {}) {
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE 或空体 */ }
  return { status: res.status, text, json };
}

/** 收 SSE 直到满足条件或超时，返回原始文本。 */
async function readSse(url, ms, stopWhen = () => false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  let text = '';
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (stopWhen(text)) break;
    }
  } catch { /* abort 即超时 */ } finally {
    clearTimeout(timer);
  }
  return text;
}

function sseChunks(text) {
  // 帧格式是 `data: {"seq":N,"chunk":"<base64>"}`（不是裸 base64），另外还有
  // exit / meta 等事件帧，只挑带 chunk 的。
  // 再把所有 base64 片**拼起来再解码一次**：逐片解码会把跨片的多字节 UTF-8
  // 砍成 U+FFFD（这台机器 locale 是中文，MOTD 全是中文）。
  const parts = [];
  for (const frame of text.split('\n\n')) {
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    let payload;
    try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (typeof payload?.chunk === 'string' && payload.chunk !== '') parts.push(payload.chunk);
  }
  const joined = parts.join('').replace(/=+$/, '');
  try { return Buffer.from(joined, 'base64').toString('utf8'); } catch { return ''; }
}

/** 轮询等会话变成 open（/open 是异步建连，立刻返回的是 connecting）。 */
async function waitOpen(baseUrl, sid, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    const list = await httpRequest(`${baseUrl}/hosts`);
    const session = (list.json?.sessions ?? []).find((s) => s.sid === sid);
    if (session?.status === 'open') return true;
    if (session?.status === 'error') return false;
    await sleep(250);
  }
  return false;
}

async function fingerprint(dir) {
  const out = [];
  const walk = async (d) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        // 软链可能指向目录（node_modules 里全是），readFile 会 EISDIR：跳过。
        let buf;
        try { buf = await readFile(full); } catch { continue; }
        out.push(`${full}:${createHash('md5').update(buf).digest('hex')}:${buf.length}`);
      }
    }
  };
  await walk(dir);
  return out.sort();
}

async function grepDir(dir, needle) {
  const hits = [];
  const walk = async (d) => {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        let buf;
        try { buf = await readFile(full); } catch { continue; }
        if (buf.includes(needle)) hits.push(full);
      }
    }
  };
  await walk(dir);
  return hits;
}

async function main() {
  console.log('='.repeat(78));
  console.log('dsh-ssh-terminal 真机验收（装进本机 dsh，连真实 SSH）');
  console.log(`profile : ${PROFILE}`);
  console.log(`server  : ${SSH_USER}@${SSH_HOST}:${SSH_PORT}`);
  console.log('='.repeat(78));

  const dshHome = join(homedir(), '.dsh');
  const before = await fingerprint(dshHome);
  console.log(`\n[baseline] ~/.dsh 指纹 ${before.length} 条`);

  // ── 1. 装机三件套 ────────────────────────────────────────────────────────
  const profilePkg = JSON.parse(await readFile(join(PROFILE, 'package.json'), 'utf8'));
  const bundles = profilePkg?.dsh?.profile?.bundles ?? [];
  check('profile package.json 的 bundles 含 dsh-ssh-terminal', bundles.includes('dsh-ssh-terminal'), JSON.stringify(bundles));
  check('profile package.json 的 dependencies 含 link 依赖', /dsh-ssh-terminal/.test(JSON.stringify(profilePkg.dependencies ?? {})));
  const link = join(PROFILE, 'node_modules/dsh-ssh-terminal');
  // 必须用 lstat：stat 会跟随软链，isSymbolicLink() 永远为 false。
  const linkStat = existsSync(link) ? await lstat(link) : null;
  check('node_modules/dsh-ssh-terminal 软链存在', linkStat?.isSymbolicLink() === true);
  const profilePatch = await readFile(join(PROFILE, 'cordis.patch.yml'), 'utf8');
  check('profile cordis.patch.yml 有 dsh-ssh-terminal 条目', /dsh-ssh-terminal/.test(profilePatch));

  // ── 2. 按包名解析（证明软链 + exports 真的能 import）──────────────────────
  const req = createRequire(join(PROFILE, 'package.json'));
  let resolvedEntry;
  try {
    resolvedEntry = req.resolve('dsh-ssh-terminal');
    check('按包名 import("dsh-ssh-terminal") 可解析', true, resolvedEntry);
  } catch (error) {
    check('按包名 import("dsh-ssh-terminal") 可解析', false, chain(error));
    return report(before);
  }

  // ── 3. 真 dsh 包 + 真 DSH_HOME 装配 ──────────────────────────────────────
  const net = await import('node:net');
  const reach = await reachable(SSH_HOST, SSH_PORT);
  check(`TCP 可达 ${SSH_HOST}:${SSH_PORT}`, reach);
  if (!reach) return report(before);

  const [cordis, web, storage, json, domain, cred, prompt, tools, yaml] = await Promise.all([
    import(join(HARNESS_ROOT, 'vendor/cordis/lib/index.js')),
    import(join(P, 'host/webserver/lib/index.js')),
    import(join(P, 'storage/storage/lib/index.js')),
    import(join(P, 'storage/storage-json/lib/index.js')),
    import(join(P, 'storage/storage-domain/lib/index.js')),
    import(join(P, 'credentials/credentials-local/lib/index.js')),
    import(join(P, 'core/system-prompt/lib/index.js')),
    import(join(P, 'core/tools/lib/index.js')),
    import(join(HARNESS_ROOT, 'node_modules/js-yaml/index.js')),
  ]);

  const bootHost = async () => {
    const ctx = new cordis.Context();
    Object.defineProperty(ctx, 'logger', {
      value: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      configurable: true, writable: true,
    });
    ctx.provide('connection', { requestRejection: () => undefined });
    // 装配顺序必须镜像真实默认组合（bundle/base/cordis.patch.yml:179-190）：
    // webserver → storage hub → storage-json（注册 backend **并** provide
    // storage.backend.json 服务）→ credentials-local → storage-domain（inject
    // 那个服务 key 之后才 provide ctx.storageDomain）→ system-prompt → tools。
    // 少任何一步，ctx.storageDomain 会静默变 undefined，插件只会回 501。
    // 注意 cordis 的 ctx.plugin() 不认 ESM 命名空间对象，要摊成普通对象；
    // storage hub 与 credentials-local 导出的是类，直接传类。
    const asPlugin = (mod, fallbackName) => ({
      name: mod.name ?? fallbackName,
      inject: mod.inject,
      apply: mod.apply,
      Config: mod.Config,
    });
    await ctx.plugin(web.WebServer, { host: '127.0.0.1', port: 0 });
    await ctx.plugin(storage.Storage, {});
    await ctx.plugin(asPlugin(json, 'storage-json'), { root: join(dshHome, 'storages') });
    await ctx.plugin(cred.LocalCredentialProvider, { dshHome, watch: false });
    await ctx.plugin(asPlugin(domain, 'storage-domain'), { backend: 'json' });
    await ctx.plugin(prompt.SystemPrompt, {});
    await ctx.plugin(tools.ToolRuntime, { mode: 'native' });
    return ctx;
  };

  /** 从插件自己的 cordis.patch.yml 读 insert 的 config（播种参数）。 */
  const patchDoc = yaml.load(await readFile(join(PLUGIN_ROOT, 'cordis.patch.yml'), 'utf8'));
  const insert = patchDoc.find((e) => e?.insert)?.insert ?? [];
  const seedEntry = insert.find((e) => e?.name === 'dsh-ssh-terminal');
  const seedConfig = { ...(seedEntry?.config ?? {}) };

  const ctx = await bootHost();
  const origin = ctx.webServer.getOrigin();
  console.log(`\n[host] 真 WebServer 监听 ${origin}（DSH_HOME=${dshHome}）`);

  const plugin = await import(resolvedEntry);
  const dispose = await plugin.apply(ctx, seedConfig);
  await dispose.ready;
  console.log('[host] 插件已激活，dispose.ready 已 resolve');

  const base = `${origin}/api/dsh-ssh`;

  // ── 4. 播种 ──────────────────────────────────────────────────────────────
  const list1 = await httpRequest(`${base}/hosts`);
  check('GET /hosts 200（真 DSH_HOME）', list1.status === 200, `status=${list1.status} ${list1.text.slice(0, 200)}`);
  const hosts1 = list1.json?.hosts ?? [];
  console.log(`[host] 当前主机 ${hosts1.length} 台：${hosts1.map((h) => `${h.label}(${h.host})`).join(', ') || '（空）'}`);

  let hostId = hosts1.find((h) => h.host === SSH_HOST && h.port === SSH_PORT)?.id;
  if (hostId) {
    const patched = await httpRequest(`${base}/hosts/${hostId}`, {
      method: 'PATCH',
      body: { auth: { kind: 'pass', password: PASSWORD } },
    });
    check('PATCH 已播种主机补上口令（走保险库）', patched.status === 200 && patched.json?.host?.hasSecret === true,
      `status=${patched.status} ${patched.text.slice(0, 200)}`);
  } else {
    const created = await httpRequest(`${base}/hosts`, {
      method: 'POST',
      body: {
        label: `${SSH_HOST} 服务器`,
        host: SSH_HOST,
        port: SSH_PORT,
        username: SSH_USER,
        auth: { kind: 'pass', password: PASSWORD },
      },
    });
    check('POST /hosts 建主机（真口令）201', created.status === 201, `status=${created.status} ${created.text.slice(0, 200)}`);
    hostId = created.json?.host?.id;
  }
  check('拿到主机 id', /^h-[0-9a-f]{8}$/.test(String(hostId)), String(hostId));

  // ── 5. 明文审计：真磁盘上不允许出现口令 ───────────────────────────────────
  const leakHome = await grepDir(dshHome, PASSWORD);
  check('~/.dsh 全目录 grep 不到口令（真磁盘）', leakHome.length === 0, leakHome.join('\n      '));
  const credFile = join(dshHome, '.credentials.yaml');
  if (existsSync(credFile)) {
    const credText = await readFile(credFile, 'utf8');
    check('.credentials.yaml 不含口令', !credText.includes(PASSWORD));
    check('.credentials.yaml 里 DSH_SSH_VAULT_KEY 恰好 1 条', (credText.match(/DSH_SSH_VAULT_KEY/g) ?? []).length === 1);
  }
  const storDoc = join(dshHome, 'storages/dsh_ssh.json');
  if (existsSync(storDoc)) {
    const storText = await readFile(storDoc, 'utf8');
    check('storages/dsh_ssh.json 不含口令', !storText.includes(PASSWORD));
    check('storages/dsh_ssh.json 里 secrets 表只有密文字段', /"ct"\s*:/.test(storText) && !/"password"\s*:/.test(storText));
  }

  // ── 6. 连接真服务器 ──────────────────────────────────────────────────────
  const opened = await httpRequest(`${base}/open`, { method: 'POST', body: { hostId, cols: 120, rows: 40 } });
  check('POST /open 接受连接请求', opened.status === 200 && typeof opened.json?.sid === 'string',
    `status=${opened.status} ${opened.text.slice(0, 300)}`);
  const sid = opened.json?.sid;
  check('拿到会话 sid', typeof sid === 'string' && sid.length > 0, String(sid));
  if (!sid) return report(before);
  check('会话最终进入 open（异步建连）', await waitOpen(base, sid), '轮询 10s 仍未 open');

  const commands = [
    ['hostname', /[A-Za-z0-9._-]{2,}/],
    ['whoami', /root/],
    ['uname -a', /Linux/],
    ['cat /etc/os-release | head -2', /(ID=|VERSION=)/],
    ['df -h / | tail -1', /\/\s/],
  ];

  const decode = (buf) => Buffer.from(buf, 'base64').toString('utf8');
  await httpRequest(`${base}/input`, { method: 'POST', body: { sid, data: Buffer.from('\n').toString('base64') } });
  await sleep(600);

  for (const [cmd, expect] of commands) {
    const payload = `${cmd}\n`;
    await httpRequest(`${base}/input`, { method: 'POST', body: { sid, data: Buffer.from(payload).toString('base64') } });
    // since=0 会把滚动缓冲整体回放，直接读固定时长再一次性解码。
    const sse = await readSse(`${base}/stream?sid=${sid}&since=0`, 4000);
    const text = sseChunks(sse);
    check(`执行 \`${cmd}\` 有回显且匹配 ${expect}`, expect.test(text),
      `收到 ${text.length} 字符，末尾：${JSON.stringify(text.slice(-200))}`);
  }

  // ── 7. 重启 dsh 后主机与口令还在（P0-1/P0-2 的真机回归）───────────────────
  const closed = await httpRequest(`${base}/close`, { method: 'POST', body: { sid } });
  check('POST /close 关闭会话', closed.status === 200, `status=${closed.status} ${closed.text.slice(0, 160)}`);
  await dispose();

  const ctx2 = await bootHost();
  const origin2 = ctx2.webServer.getOrigin();
  const dispose2 = await plugin.apply(ctx2, { ...seedConfig, autoOpenFirst: false });
  await dispose2.ready;
  const base2 = `${origin2}/api/dsh-ssh`;

  const list2 = await httpRequest(`${base2}/hosts`);
  const survived = (list2.json?.hosts ?? []).find((h) => h.id === hostId);
  check('重启 dsh 后主机仍在（P0-1 回归：不丢主机）', Boolean(survived), `${list2.text.slice(0, 200)}`);
  check('重启后 hasSecret 仍为 true（密文还在）', survived?.hasSecret === true);

  const reopened = await httpRequest(`${base2}/open`, { method: 'POST', body: { hostId } });
  const sid2 = reopened.json?.sid;
  const open2 = typeof sid2 === 'string' && (await waitOpen(base2, sid2));
  check('重启后用保险库里的口令重连成功（P0-2 回归：DEK 没被轮换）', open2,
    `status=${reopened.status} ${reopened.text.slice(0, 300)}`);
  if (sid2) {
    await httpRequest(`${base2}/input`, { method: 'POST', body: { sid: sid2, data: Buffer.from('whoami\n').toString('base64') } });
    const sse2 = await readSse(`${base2}/stream?sid=${sid2}&since=0`, 4000);
    check('重连后能执行命令并收到回显', /root/.test(sseChunks(sse2)), sseChunks(sse2).slice(-160));
    await httpRequest(`${base2}/close`, { method: 'POST', body: { sid: sid2 } });
  }
  await dispose2();

  // ── 8. 卫生：~/.dsh 只应有 dsh-ssh 相关的新增 ────────────────────────────
  const after = await fingerprint(dshHome);
  const beforeSet = new Set(before);
  const added = after.filter((line) => !beforeSet.has(line));
  const related = added.filter((line) => /dsh_ssh|credentials\.yaml/.test(line));
  console.log(`\n[hygiene] ~/.dsh 新增 ${added.length} 条，其中与 dsh-ssh 相关 ${related.length} 条：`);
  for (const line of related) console.log(`         + ${line.split(':').slice(0, 1).join('')} (${line.split(':').pop()} B)`);

  return report(before);
}

function report() {
  const pass = results.filter((r) => r.ok).length;
  console.log('\n' + '='.repeat(78));
  console.log(`真机验收：${pass}/${results.length} 通过，失败 ${results.length - pass}`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`);
  console.log('='.repeat(78));
  return results.every((r) => r.ok) ? 0 : 1;
}

const code = await main();
process.exit(code);
