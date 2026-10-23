/**
 * `tests/stubs/fake-services.mjs` 的自测。
 *
 * 替身本身是测试基础设施：它要是会错，上面所有依赖它的断言都失去意义。
 * 这里锁三条最容易被写错的语义：
 * 1. exact 优先于 prefix（`/hosts` 不被 prefix 路由吃掉）；
 * 2. 多个 prefix 命中时取**最长**的那个，且必须按路径段边界匹配；
 * 3. 内存 domain 的读写 + zod schema 校验 + 快照可序列化。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  createFakeCredentials,
  createFakeStorageDomain,
  matchRoute,
  mountRoutes,
  createFakeCtx,
  request,
} from './stubs/fake-services.mjs';

test('matchRoute prefers exact and lets a prefix route own the sub-path', async () => {
  const ctx = createFakeCtx();
  // 与真实路由表同形：集合走 exact，单条走 prefix，两者 path 相同。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-ssh/hosts',
    handler: (req, res) => {
      res.statusCode = 200;
      res.end('exact');
    },
  });
  ctx.webServer.register({
    kind: 'prefix',
    path: '/api/dsh-ssh/hosts',
    handler: (req, res) => {
      res.statusCode = 200;
      res.end('prefix');
    },
  });

  assert.equal(matchRoute(ctx.routes, '/api/dsh-ssh/hosts').kind, 'exact', '/hosts must hit the exact route');
  assert.equal(
    matchRoute(ctx.routes, '/api/dsh-ssh/hosts/h-abc').kind,
    'prefix',
    '/hosts/<id> must hit the prefix route',
  );
  // 走真 http 一次，证明分发链路（不只是 matchRoute 纯函数）也对。
  const server = await mountRoutes(ctx);
  try {
    assert.equal((await request(`${server.baseUrl}/api/dsh-ssh/hosts`)).text, 'exact');
    assert.equal((await request(`${server.baseUrl}/api/dsh-ssh/hosts/h-abc`)).text, 'prefix');
    assert.equal((await request(`${server.baseUrl}/api/dsh-ssh/nope`)).status, 599, 'unknown path -> no route');
  } finally {
    await server.close();
  }
});

test('matchRoute picks the longest prefix and respects path-segment boundaries', () => {
  const routes = [
    { kind: 'prefix', path: '/api/x', handler: () => {} },
    { kind: 'prefix', path: '/api/x/deep', handler: () => {} },
    { kind: 'exact', path: '/api/x/deep/leaf', handler: () => {} },
  ];
  assert.equal(matchRoute(routes, '/api/x/deep/more').path, '/api/x/deep', 'longest prefix wins');
  assert.equal(matchRoute(routes, '/api/x/deep').path, '/api/x/deep', 'prefix matches its own path');
  assert.equal(matchRoute(routes, '/api/x/deep/leaf').kind, 'exact', 'exact still wins on a full match');
  // 段边界：`/api/xylophone` 不是 `/api/x` 的子路径。
  assert.equal(matchRoute(routes, '/api/xylophone'), undefined, 'no segment boundary -> no match');
  assert.equal(matchRoute([], '/api/x'), undefined, 'empty route table -> undefined');
});

test('fake storage domain validates with zod, round-trips values and snapshots cleanly', async () => {
  const schema = z.object({ id: z.string(), port: z.number().int().min(1).max(65535) });
  const storageDomain = createFakeStorageDomain();
  const domain = await storageDomain.open({ name: 'dsh_ssh', version: 1, tables: { hosts: schema } });
  const hosts = domain.table('hosts');

  assert.equal(hosts.size, 0);
  await hosts.put('h-00000001', { id: 'h-00000001', port: 22 });
  // get 同步（真实现如此），entries/keys 可迭代。
  assert.equal(hosts.get('h-00000001').port, 22);
  assert.deepEqual(hosts.keys(), ['h-00000001']);
  assert.equal([...hosts.entries()].length, 1);
  assert.equal(hosts.size, 1);

  // schema 校验生效：越界端口与缺字段都必须抛。
  await assert.rejects(() => hosts.put('h-bad', { id: 'h-bad', port: 70000 }), /failed schema/);
  await assert.rejects(() => hosts.put('h-bad', { port: 22 }), /failed schema/);
  assert.equal(hosts.size, 1, 'rejected writes must not land');

  // 非法域/表名在假实现里也拒（`dsh-ssh` 这类名字真机上不合法）。
  await assert.rejects(() => storageDomain.open({ name: 'dsh-ssh', version: 1, tables: {} }), /illegal domain name/);
  assert.throws(() => domain.table('secrets'), /unknown table/);

  // 快照可 JSON 序列化，且能看见写入的值（明文断言的载体）。
  const snapshot = JSON.stringify(storageDomain.snapshot());
  assert.match(snapshot, /h-00000001/);
  assert.deepEqual(JSON.parse(snapshot).dsh_ssh.hosts['h-00000001'], { id: 'h-00000001', port: 22 });

  await hosts.delete('h-00000001');
  assert.equal(hosts.get('h-00000001'), undefined);
  assert.equal(hosts.size, 0);

  // credentials 替身：set/resolve/unset 与 entries 计数。
  //
  // resolve 必须返回 `{ value, source }` 而不是裸字符串：真实
  // `CredentialProvider.resolve()` 的契约是
  // `Promise<ResolvedCredential | undefined>`，`ResolvedCredential = { value, source }`
  // （`packages/credentials/credentials/src/index.ts:118-123`）。替身早先返回
  // 裸字符串，把 `src/vault.js` 里 `typeof stored === 'string'` 的判断伪装成
  // 正确——于是"重启后 DEK 被静默轮换、旧密文全废"这个真机上必现的 bug
  // 在 81 个测试里一条都没报。这条断言锁住替身与真契约同形。
  const credentials = createFakeCredentials();
  await credentials.set('DSH_SSH_VAULT_KEY', 'abc');
  assert.deepEqual(
    await credentials.resolve('DSH_SSH_VAULT_KEY'),
    { value: 'abc', source: 'file' },
    'resolve() must mirror the real ResolvedCredential shape, not a bare string',
  );
  // describe 也要与真 `CredentialInfo` 同形（`{configured, source?, writable}`，
  // `credentials/src/types.ts:67-74`），不能编一个只存在于替身里的形状。
  assert.deepEqual(await credentials.describe('DSH_SSH_VAULT_KEY'),
    { configured: true, source: 'file', writable: true });
  assert.equal(credentials.entries().length, 1);
  await credentials.unset('DSH_SSH_VAULT_KEY');
  assert.equal(await credentials.resolve('DSH_SSH_VAULT_KEY'), undefined);
  assert.deepEqual(await credentials.describe('DSH_SSH_VAULT_KEY'), { configured: false, writable: true });
});
