/** 调试：SSE 的实时推送是否工作（回放 vs 实时）。 */
import { join } from 'node:path';
import { homedir } from 'node:os';

const HARNESS_ROOT = '/Users/leiyu/code/pre-study/deepseek-harness';
const P = join(HARNESS_ROOT, 'packages');
const dshHome = join(homedir(), '.dsh');
const PASSWORD = process.env.REAL_SSH_PASSWORD ?? '';

const [cordis, web, storage, json, domain, cred] = await Promise.all([
  import(join(HARNESS_ROOT, 'vendor/cordis/lib/index.js')),
  import(join(P, 'host/webserver/lib/index.js')),
  import(join(P, 'storage/storage/lib/index.js')),
  import(join(P, 'storage/storage-json/lib/index.js')),
  import(join(P, 'storage/storage-domain/lib/index.js')),
  import(join(P, 'credentials/credentials-local/lib/index.js')),
]);
const asPlugin = (m, n) => ({ name: m.name ?? n, inject: m.inject, apply: m.apply, Config: m.Config });

const ctx = new cordis.Context();
Object.defineProperty(ctx, 'logger', { value: { info: () => {}, warn: () => {}, error: (m) => console.log('[err]', m), debug: () => {} }, configurable: true, writable: true });
ctx.provide('connection', { requestRejection: () => undefined });
await ctx.plugin(web.WebServer, { host: '127.0.0.1', port: 0 });
await ctx.plugin(storage.Storage, {});
await ctx.plugin(asPlugin(json, 'storage-json'), { root: join(dshHome, 'storages') });
await ctx.plugin(cred.LocalCredentialProvider, { dshHome, watch: false });
await ctx.plugin(asPlugin(domain, 'storage-domain'), { backend: 'json' });

const { apply } = await import('/Users/leiyu/AI/dsh-hub/dsh-ssh/src/index.js');
const dispose = await apply(ctx, { autoOpenFirst: false });
await dispose.ready;
const base = `${ctx.webServer.getOrigin()}/api/dsh-ssh`;
const http = async (url, options = {}) => {
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
};

const host = (await http(`${base}/hosts`)).json.hosts.find((h) => h.host === '120.53.14.173');
if (host && !host.hasSecret) await http(`${base}/hosts/${host.id}`, { method: 'PATCH', body: { auth: { kind: 'pass', password: PASSWORD } } });
const sid = (await http(`${base}/open`, { method: 'POST', body: { hostId: host.id, cols: 120, rows: 40 } })).json.sid;
const status = async () => (await http(`${base}/hosts`)).json.sessions.find((s) => s.sid === sid);
for (let i = 0; i < 40; i += 1) {
  const s = await status();
  if (s?.status === 'open') break;
  if (s?.status === 'error') process.exit(1);
  await new Promise((r) => setTimeout(r, 250));
}
await http(`${base}/input`, { method: 'POST', body: { sid, data: Buffer.from('\n').toString('base64') } });
await new Promise((r) => setTimeout(r, 1500));
console.log('[dbg] 就绪，seq =', (await status()).seq);

// 先开 SSE，保持不关，再发命令：看实时数据能不能到。
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 6000);
const res = await fetch(`${base}/stream?sid=${sid}&since=0`, { signal: ctrl.signal });
const reader = res.body.getReader();
const dec = new TextDecoder();
let raw = '';
const pump = (async () => {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
    }
  } catch {}
})();

await new Promise((r) => setTimeout(r, 500));
console.log('[dbg] SSE 已连接，先收到', raw.length, '字节');
await http(`${base}/input`, { method: 'POST', body: { sid, data: Buffer.from('echo LIVE_MARKER_456\n').toString('base64') } });
await new Promise((r) => setTimeout(r, 2500));
console.log('[dbg] 发命令后又收到', raw.length, '字节（应显著增长）');
await pump;
clearTimeout(timer);

const parts = [];
for (const frame of raw.split('\n\n')) {
  const line = frame.split('\n').find((l) => l.startsWith('data:'));
  if (!line) continue;
  try { const p = JSON.parse(line.slice(5).trim()); if (typeof p.chunk === 'string') parts.push(p.chunk); } catch {}
}
const text = Buffer.from(parts.join('').replace(/=+$/, ''), 'base64').toString('utf8');
console.log('[dbg] 总解码', text.length, '字符');
console.log('[dbg] 含 LIVE_MARKER_456？', text.includes('LIVE_MARKER_456'));
console.log('[dbg] 含 root@ ？', text.includes('root@'));
console.log('[dbg] 末尾 300 字符：', JSON.stringify(text.slice(-300)));

await http(`${base}/close`, { method: 'POST', body: { sid } });
await dispose();
process.exit(0);
