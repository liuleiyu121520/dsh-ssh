/** 调试：在真实 ~/.dsh 上单跑 HostStore.init()，把错误链打全。 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HARNESS_ROOT = '/Users/leiyu/code/pre-study/deepseek-harness';
const P = join(HARNESS_ROOT, 'packages');
const dshHome = join(homedir(), '.dsh');

const [cordis, web, storage, json, domain, cred] = await Promise.all([
  import(join(HARNESS_ROOT, 'vendor/cordis/lib/index.js')),
  import(join(P, 'host/webserver/lib/index.js')),
  import(join(P, 'storage/storage/lib/index.js')),
  import(join(P, 'storage/storage-json/lib/index.js')),
  import(join(P, 'storage/storage-domain/lib/index.js')),
  import(join(P, 'credentials/credentials-local/lib/index.js')),
]);

const ctx = new cordis.Context();
Object.defineProperty(ctx, 'logger', {
  value: {
    info: (m) => console.log(`[info] ${m}`),
    warn: (m) => console.log(`[warn] ${m}`),
    error: (m) => console.log(`[error] ${m}`),
    debug: (m) => console.log(`[debug] ${m}`),
  },
  configurable: true, writable: true,
});
ctx.provide('connection', { requestRejection: () => undefined });
await ctx.plugin(web.WebServer, { host: '127.0.0.1', port: 0 });
// 真实默认组合（bundle/base/cordis.patch.yml:179-190）：
// storage → storage-json（注册 backend 并提供 storage.backend.json 服务）
// → storage-domain（inject 那个服务 key 后才 provide ctx.storageDomain）。
// 三个都是模块形态（name/inject/apply），必须走 ctx.plugin() 让 cordis 读到
// 模块级 inject 静态表；直接调 apply() 会让 fiber 上下文缺 storage 服务。
// credentials-local 到处的是类，也用 ctx.plugin。
// cordis 的 ctx.plugin() 只认「函数 / 类 / 带 apply 的普通对象」，ESM 命名空间
// 对象过不了它的 resolve()。把模块的 name/inject/apply/Config 摊成普通对象即可。
const asPlugin = (mod, fallbackName) => ({
  name: mod.name ?? fallbackName,
  inject: mod.inject,
  apply: mod.apply,
  Config: mod.Config,
});
// storage hub 模块导出的是**类** Storage（没有 apply），其余两个模块导出 apply。
await ctx.plugin(storage.Storage, {});
await ctx.plugin(asPlugin(json, 'storage-json'), { root: join(dshHome, 'storages') });
await ctx.plugin(cred.LocalCredentialProvider, { dshHome, watch: false });
await ctx.plugin(asPlugin(domain, 'storage-domain'), { backend: 'json' });
await new Promise((r) => setTimeout(r, 50));
console.log('[dbg] 服务装配完成（storage + storage-json + storage-domain + credentials）');
console.log('[dbg] ctx.storageDomain =', typeof ctx.storageDomain);

const { defineDomainSpec } = await import('/Users/leiyu/AI/dsh-hub/dsh-ssh/src/schema.js');
const { createVault } = await import('/Users/leiyu/AI/dsh-hub/dsh-ssh/src/vault.js');
const { HostStore } = await import('/Users/leiyu/AI/dsh-hub/dsh-ssh/src/hosts.js');

const spec = defineDomainSpec();
console.log('[dbg] spec tables.hosts keys =', Object.keys(spec.tables.hosts));
console.log('[dbg] spec.tables.hosts.valueSchema =', String(spec.tables.hosts.valueSchema));

try {
  const facility = new domain.DomainFacility(ctx, { backend: 'json' });
  const d = await facility.open(spec);
  console.log('[dbg] DomainFacility.open OK, hosts =', JSON.stringify(d.table('hosts').entries()));
  await d.close();
} catch (error) {
  console.log('[dbg] DomainFacility.open 失败：', error?.code, error?.message);
  console.log('[dbg] cause:', error?.cause?.message);
  console.log('[dbg] stack:', error?.stack?.split('\n').slice(0, 6).join('\n'));
}

try {
  const vault = createVault(ctx);
  const dek = await vault.ensureDek();
  console.log('[dbg] vault.ensureDek OK, 长度 =', dek?.length);
} catch (error) {
  console.log('[dbg] vault.ensureDek 失败：', error?.code, error?.message, error?.cause?.message);
}

try {
  // HostStore 的构造签名是 options 对象，不是位置参数。
  const store = new HostStore({ storageDomain: ctx.storageDomain, vault: createVault(ctx) });
  await store.init();
  console.log('[dbg] HostStore.init OK, list =', JSON.stringify(store.list()));
} catch (error) {
  console.log('[dbg] HostStore.init 失败：', error?.code, error?.message, '←', error?.cause?.message);
}
process.exit(0);
