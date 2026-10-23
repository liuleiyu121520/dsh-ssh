/** 调试：输入到底进没进 PTY。 */
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

const status = async () => {
  const l = await http(`${base}/hosts`);
  return l.json.sessions.find((s) => s.sid === sid);
};
for (let i = 0; i < 40; i += 1) {
  const s = await status();
  if (s?.status === 'open') break;
  if (s?.status === 'error') { console.log('[dbg] error', s.error); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}
console.log('[dbg] open, seq =', (await status()).seq);

const send = async (text) => {
  const r = await http(`${base}/input`, { method: 'POST', body: { sid, data: Buffer.from(text).toString('base64') } });
  console.log(`[dbg] input ${JSON.stringify(text)} → ${r.status} ${r.text}`);
  return r;
};

await send('\n');
await new Promise((r) => setTimeout(r, 1500));
console.log('[dbg] 1.5s 后 seq =', (await status()).seq);

await send('echo ZZZ_MARKER_123\n');
await new Promise((r) => setTimeout(r, 2500));
const s2 = await status();
console.log('[dbg] 再 2.5s 后 seq =', s2?.seq, 'status =', s2?.status);

const ctxRes = await http(`${base}/context?sid=${sid}`);
console.log('[dbg] /context tail：');
console.log(JSON.stringify(ctxRes.json?.tail?.slice(-400)));

await http(`${base}/close`, { method: 'POST', body: { sid } });
await dispose();
process.exit(0);
