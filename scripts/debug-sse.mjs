/** 调试：抓真实 SSE 帧的原始字节，判断是分片边界还是编码问题。 */
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

const hosts = (await http(`${base}/hosts`)).json.hosts;
const host = hosts.find((h) => h.host === '120.53.14.173');
console.log('[dbg] 主机：', host?.id, host?.label, 'hasSecret=', host?.hasSecret);
if (host && !host.hasSecret) {
  await http(`${base}/hosts/${host.id}`, { method: 'PATCH', body: { auth: { kind: 'pass', password: PASSWORD } } });
  console.log('[dbg] 已补口令');
}

const opened = await http(`${base}/open`, { method: 'POST', body: { hostId: host.id, cols: 120, rows: 40 } });
const sid = opened.json.sid;
console.log('[dbg] sid =', sid);

for (let i = 0; i < 40; i += 1) {
  const s = (await http(`${base}/hosts`)).json.sessions.find((x) => x.sid === sid);
  if (s?.status === 'open') { console.log('[dbg] 已 open'); break; }
  if (s?.status === 'error') { console.log('[dbg] 连接失败', s.error); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}

await http(`${base}/input`, { method: 'POST', body: { sid, data: Buffer.from('\n').toString('base64') } });
await new Promise((r) => setTimeout(r, 800));

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 3000);
let raw = '';
const res = await fetch(`${base}/stream?sid=${sid}&since=0`, { signal: ctrl.signal });
const reader = res.body.getReader();
const dec = new TextDecoder();
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += dec.decode(value, { stream: true });
  }
} catch {}
clearTimeout(timer);

console.log('[dbg] 原始 SSE 长度', raw.length);
const frames = raw.split('\n\n').filter((f) => f.trim() !== '');
console.log('[dbg] 帧数', frames.length);
console.log('[dbg] 前 3 帧原文：');
for (const f of frames.slice(0, 3)) console.log('   ', JSON.stringify(f.slice(0, 160)));

const b64parts = frames.map((f) => f.split('\n').find((l) => l.startsWith('data:'))?.slice(5).trim()).filter(Boolean);
console.log('[dbg] base64 片数', b64parts.length, '各片长度', b64parts.slice(0, 8).map((s) => s.length).join(','));
console.log('[dbg] 各片是否带 = 填充：', b64parts.map((s) => s.endsWith('=') ? 'Y' : 'n').join(''));

const joined = b64parts.join('');
const buf = Buffer.from(joined, 'base64');
console.log('[dbg] 拼接后字节数', buf.length);
console.log('[dbg] utf8 解码含 root？', buf.toString('utf8').includes('root'));
console.log('[dbg] 原始字节含 "root"(72 6f 6f 74)？', buf.includes(Buffer.from('root')));
console.log('[dbg] 前 200 字节 hex：', buf.subarray(0, 60).toString('hex'));
console.log('[dbg] 含 "Linux"？', buf.includes(Buffer.from('Linux')));

await http(`${base}/close`, { method: 'POST', body: { sid } });
await dispose();
process.exit(0);
