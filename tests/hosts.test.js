/**
 * `src/hosts.js` 的 node --test 测试。
 *
 * 核心不是"CRUD 能跑"，而是三条安全性质：
 * 1. **明文断言**：建一台带口令的主机后，把整个 domain 快照 stringify 出来
 *    也找不到口令；`DSH_SSH_VAULT_KEY` 在 credentials 里恰好一条。
 * 2. **不改就不动**：`update` 不带 auth 时密文 `ct` 字节级相等（改标签不会
 *    顺手把密码弄丢或重加密一遍）。
 * 3. **删除要干净**：`remove` 之后 `secrets.get(id)` 是 undefined，不留孤儿密文。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostStore, HostStoreError, seedHostsFromConfig } from '../src/hosts.js';
import { HostInputError, toHostView } from '../src/schema.js';
import { VAULT_KEY_REF, createVault } from '../src/vault.js';
import { createFakeCredentials, createFakeStorageDomain } from './stubs/fake-services.mjs';

/** 测试用的口令：足够独特，grep 快照时不会误判。 */
const SECRET = 'Tr0ub4dor&3-ssh-secret';

/**
 * 造一个初始化好的 HostStore 与它依赖的两个替身。
 * @returns {Promise<{store: HostStore, storageDomain: object, credentials: object, vault: object}>} 上下文。
 */
async function makeStore() {
  const storageDomain = createFakeStorageDomain();
  const credentials = createFakeCredentials();
  const vault = createVault({ credentials });
  const store = await new HostStore({ storageDomain, vault }).init();
  return { store, storageDomain, credentials, vault };
}

/** 一台带口令主机的请求体。 */
const HOST_INPUT = {
  label: '测试机',
  host: '10.0.0.9',
  port: 2222,
  username: 'deploy',
  auth: { kind: 'password', password: SECRET }, // 客户端别名 password -> 落库规范值 pass
};

test('create writes metadata without any secret and stores exactly one ciphertext', async () => {
  const { store, storageDomain, credentials } = await makeStore();
  const record = await store.create(HOST_INPUT);

  assert.match(record.id, /^h-[0-9a-f]{8}$/, 'hostId must be h-<8hex>');
  assert.deepEqual(Object.keys(record).sort(), [
    'authKind', 'createdAt', 'hasSecret', 'host', 'id', 'label', 'port', 'updatedAt', 'username',
  ]);
  assert.equal(record.authKind, 'pass', 'canonical authKind is pass, not password (the response must not contain that word)');
  assert.equal(record.hasSecret, true);

  // 明文断言 1：整个域快照里不能出现口令，也不能出现 password 这个键。
  const snapshot = JSON.stringify(storageDomain.snapshot());
  assert.equal(snapshot.includes(SECRET), false, 'plaintext password leaked into the domain');
  assert.equal(snapshot.includes('"password":'), false, 'a password key leaked into the domain');
  assert.equal(snapshot.includes('"privateKey":'), false);

  // 明文断言 2：DEK 在 credentials 里恰好一条，且是 32B。
  const vaultEntries = credentials.entries().filter(([ref]) => ref === VAULT_KEY_REF);
  assert.equal(vaultEntries.length, 1);
  assert.equal(Buffer.from(vaultEntries[0][1], 'base64').length, 32);

  // 密文盒四字段齐备（AAD 绑定与算法细节由 vault.test.js 覆盖）。
  const box = storageDomain.snapshot().dsh_ssh.secrets[record.id];
  assert.deepEqual(Object.keys(box).sort(), ['ct', 'iv', 'tag', 'v']);

  // 解回来的 auth 与输入一致。
  assert.deepEqual(await store.getAuth(record.id), { kind: 'pass', password: SECRET });
});

test('list/get/has are consistent and unknown ids raise unknown-host', async () => {
  const { store } = await makeStore();
  const first = await store.create(HOST_INPUT);
  const second = await store.create({ ...HOST_INPUT, host: '10.0.0.10', label: '第二台' });

  const hosts = await store.list();
  assert.equal(hosts.length, 2);
  assert.deepEqual(hosts.map((host) => host.id), [first.id, second.id], 'list is stable (createdAt, then id)');
  assert.equal((await store.get(first.id)).label, '测试机');
  assert.equal(store.has(first.id), true);
  assert.equal(store.has('h-deadbeef'), false);
  assert.equal(await store.count(), 2);

  await assert.rejects(() => store.get('h-deadbeef'), (error) => {
    assert.ok(error instanceof HostStoreError);
    assert.equal(error.code, 'unknown-host');
    return true;
  });
});

test('duplicate (host, port, username) is rejected, updating into a duplicate too', async () => {
  const { store } = await makeStore();
  await store.create(HOST_INPUT);
  await assert.rejects(() => store.create(HOST_INPUT), (error) => error.code === 'duplicate-host');

  // 端口不同 / 用户不同都算不同机器。
  await store.create({ ...HOST_INPUT, port: 22 });
  await store.create({ ...HOST_INPUT, username: 'other' });

  const third = await store.create({ ...HOST_INPUT, host: '10.0.0.11' });
  await assert.rejects(() => store.update(third.id, { host: '10.0.0.9', port: 2222, username: 'deploy' }), (error) => error.code === 'duplicate-host');
  // 自己改自己（同值）不算重复。
  await store.update(third.id, { label: '改个名' });
  assert.equal((await store.get(third.id)).label, '改个名');
});

test('update without auth leaves the ciphertext byte-identical', async () => {
  const { store, storageDomain } = await makeStore();
  const record = await store.create(HOST_INPUT);
  const before = storageDomain.snapshot().dsh_ssh.secrets[record.id];

  const updated = await store.update(record.id, { label: '新标签', port: 2200 });
  const after = storageDomain.snapshot().dsh_ssh.secrets[record.id];

  assert.equal(updated.label, '新标签');
  assert.equal(updated.port, 2200);
  assert.equal(updated.authKind, 'pass', 'authKind survives an auth-less update');
  assert.equal(updated.hasSecret, true);
  // 关键断言：没有重新加密，也没有丢密文。
  assert.equal(after.ct, before.ct, 'ct must not change when auth is omitted');
  assert.equal(after.iv, before.iv, 'iv must not change when auth is omitted');
  assert.equal(after.tag, before.tag);
  assert.deepEqual(await store.getAuth(record.id), { kind: 'pass', password: SECRET });
});

test('update with a new auth re-seals; auth.kind=none clears the secret', async () => {
  const { store, storageDomain } = await makeStore();
  const record = await store.create(HOST_INPUT);
  const before = storageDomain.snapshot().dsh_ssh.secrets[record.id];

  const rotated = await store.update(record.id, { auth: { kind: 'password', password: 'rotated-秘钥' } });
  const after = storageDomain.snapshot().dsh_ssh.secrets[record.id];
  assert.notEqual(after.ct, before.ct, 'a new password must produce a new ciphertext');
  assert.equal(rotated.authKind, 'pass');
  assert.deepEqual(await store.getAuth(record.id), { kind: 'pass', password: 'rotated-秘钥' });
  assert.equal(JSON.stringify(storageDomain.snapshot()).includes('rotated-秘钥'), false);

  const cleared = await store.update(record.id, { auth: { kind: 'none' } });
  assert.equal(cleared.hasSecret, false);
  assert.equal(cleared.authKind, 'none');
  assert.equal(await store.getAuth(record.id), null);
  assert.equal(storageDomain.snapshot().dsh_ssh.secrets[record.id], undefined);
});

test('a private key host keeps the pem out of the domain snapshot', async () => {
  const { store, storageDomain } = await makeStore();
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----\n';
  const record = await store.create({ host: 'key.example.com', username: 'git', auth: { kind: 'privateKey', privateKey: pem } });
  const snapshot = JSON.stringify(storageDomain.snapshot());
  assert.equal(snapshot.includes('AAAAB3NzaC1yc2E'), false, 'private key leaked into the domain');
  const auth = await store.getAuth(record.id);
  assert.equal(auth.kind, 'key', 'canonical authKind for a key is key');
  assert.equal(auth.privateKey, pem);
});

test('remove deletes the secret too (no orphan ciphertext)', async () => {
  const { store, storageDomain } = await makeStore();
  const record = await store.create(HOST_INPUT);
  const removed = await store.remove(record.id);
  assert.equal(removed.id, record.id);

  const snapshot = storageDomain.snapshot();
  assert.equal(snapshot.dsh_ssh.hosts[record.id], undefined, 'host record is gone');
  assert.equal(snapshot.dsh_ssh.secrets[record.id], undefined, 'secret is gone with it');
  assert.equal(store.has(record.id), false);
  await assert.rejects(() => store.remove(record.id), (error) => error.code === 'unknown-host');
  await assert.rejects(() => store.getAuth(record.id), (error) => error.code === 'unknown-host');
});

test('the ciphertext is bound to its hostId: swapping rows makes decryption fail', async () => {
  const { store, storageDomain } = await makeStore();
  const first = await store.create(HOST_INPUT);
  const second = await store.create({ ...HOST_INPUT, host: '10.0.0.10' });
  const boxOfFirst = storageDomain.snapshot().dsh_ssh.secrets[first.id];

  // 模拟攻击者改库：把 A 的密文挂到 B 上（id 由服务端生成，改库是唯一路径）。
  //
  // 走 store 自己的域句柄写，而不是再 open 一次：真 DomainFacility 对同名域
  // 第二次 open 会抛 `already-open`（替身现在也照这个来），"改库"本来就是
  // 绕过 API 直接动行，用同一个句柄写等价。
  const secrets = store.domain.table('secrets');
  await secrets.put(second.id, boxOfFirst);

  await assert.rejects(() => store.getAuth(second.id), (error) => error.code === 'decrypt-failed');
  // A 自己的密文仍然可用。
  assert.equal((await store.getAuth(first.id)).password, SECRET);
});

test('invalid input is invalid-host and never reaches the tables', async () => {
  const { store, storageDomain } = await makeStore();
  const bad = [
    {},
    { host: '' },
    { host: 'has space' },
    { host: 'h', port: 0 },
    { host: 'h', port: 70000 },
    { host: 'h', auth: { kind: 'password' } },
    { host: 'h', auth: { kind: 'privateKey', privateKey: 'not-a-pem' } },
  ];
  for (const input of bad) {
    await assert.rejects(() => store.create(input), (error) => {
      assert.ok(error instanceof HostInputError, `${JSON.stringify(input)} -> ${error.name}`);
      assert.equal(error.code, 'invalid-host');
      return true;
    });
  }
  assert.equal(await store.count(), 0, 'no partial rows after rejected creates');
  assert.deepEqual(storageDomain.snapshot().dsh_ssh.secrets, {});
});

test('seed runs once, tolerates bad entries and never overwrites user data', async () => {
  const { store } = await makeStore();
  const seeded = await store.seed([
    { host: '10.0.0.1', username: 'root', password: 'seed-pass-1' },
    { host: '', password: 'broken' },
    { host: '10.0.0.2', username: 'root', password: 'seed-pass-2' },
  ]);
  assert.equal(seeded, 2, 'the invalid seed entry is skipped, the others land');
  assert.equal(await store.count(), 2);

  // 第二次播种（用户已经删过/改过）不再动任何东西。
  assert.equal(await store.seed([{ host: '10.0.0.3' }]), 0);
  assert.equal(await store.count(), 2);

  // 播种出来的主机凭据是可解的。
  const [first] = await store.list();
  assert.deepEqual(await store.getAuth(first.id), { kind: 'pass', password: 'seed-pass-1' });
});

test('seedHostsFromConfig supports the list form and the flat M0 form', () => {
  assert.deepEqual(seedHostsFromConfig({}), []);
  const flat = seedHostsFromConfig({ host: '1.2.3.4', port: 22, username: 'u', password: 'p', label: 'L' });
  assert.equal(flat.length, 1);
  assert.equal(flat[0].host, '1.2.3.4');
  assert.equal(flat[0].password, 'p');
  const list = seedHostsFromConfig({ hosts: [{ host: 'a' }, { host: 'b' }] });
  assert.deepEqual(list.map((host) => host.host), ['a', 'b']);
});

test('toHostView whitelists fields and never spreads the record', async () => {
  const { store } = await makeStore();
  const record = await store.create(HOST_INPUT);
  const view = toHostView(record, { sid: 's3', status: 'open', error: null });
  assert.deepEqual(Object.keys(view).sort(), [
    'authKind', 'error', 'hasSecret', 'host', 'id', 'label', 'port', 'sid', 'status', 'username',
  ]);
  assert.equal(view.sid, 's3');
  assert.equal(view.status, 'open');
  assert.equal(JSON.stringify(view).includes(SECRET), false);

  // 无会话 -> offline，且不会因为 record 里多了个字段就漏出去。
  const offline = toHostView({ ...record, password: SECRET, ct: 'zzz' });
  assert.equal(offline.status, 'offline');
  assert.equal(offline.sid, null);
  assert.equal(JSON.stringify(offline).includes(SECRET), false, 'toHostView must not spread unknown keys');
  assert.equal(JSON.stringify(offline).includes('zzz'), false);
});

test('an uninitialized store refuses to work instead of throwing TypeError', async () => {
  const storageDomain = createFakeStorageDomain();
  const vault = createVault({ credentials: createFakeCredentials() });
  const store = new HostStore({ storageDomain, vault });
  await assert.rejects(() => store.list(), (error) => error.code === 'storage-unavailable');
  assert.throws(() => new HostStore({ vault }), (error) => error.code === 'storage-unavailable');
  assert.throws(() => new HostStore({ storageDomain }), (error) => error.code === 'vault-unavailable');
});

/**
 * **重启回归**：存一台主机 → 进程结束 → 新进程用同一份介质重开域。
 *
 * 这条路径是本轮最容易漏的一条：真 dsh 在 `DomainFacility.open()` 里会用
 * 表规格的 `valueSchema` 校验**每一条已存记录**
 * （`storage-domain/src/index.ts:119-141`）。表规格形状写错时，空存储上
 * `open()` 一切正常（没有记录可校验），第一次写入也正常（真实现的校验只在
 * 读边界），于是"第一次用全绿、重启后主机全没了"。
 *
 * 用 `createFakeStorageDomain({ restore })` 模拟介质上的存量数据，断言：
 * 1. 重开成功；
 * 2. 主机条数与内容都还在；
 * 3. 密文仍能解回原口令（DEK 没被轮换）。
 */
test('a restart re-opens the domain and every stored host survives with its secret', async () => {
  const first = await makeStore();
  const record = await first.store.create(HOST_INPUT);
  const medium = first.storageDomain.snapshot();

  // ── 进程边界 ───────────────────────────────────────────────────────────
  // 新进程：新的 storageDomain（从介质恢复）、新的 vault、新的 HostStore，
  // 但 credentials 是同一个（DEK 在磁盘上，跨进程共享）。
  const storageDomain = createFakeStorageDomain({ restore: medium });
  const vault = createVault({ credentials: first.credentials });
  const store = await new HostStore({ storageDomain, vault }).init();

  const hosts = await store.list();
  assert.equal(hosts.length, 1, 'the stored host must still be there after a restart');
  assert.equal(hosts[0].id, record.id);
  assert.equal(hosts[0].label, HOST_INPUT.label);
  assert.equal(hosts[0].hasSecret, true);
  assert.deepEqual(await store.getAuth(record.id), { kind: 'pass', password: SECRET },
    'the ciphertext must still decrypt with the same DEK after a restart');
});

/**
 * 插件热更新会把 `apply()` 再跑一遍（新建一个 HostStore）。
 *
 * 域句柄不还回去，第二次 `open('dsh_ssh')` 就被设施判成 `already-open`，
 * 插件退化成"patch 只读主机"、添加主机报存储不可用，只有重启应用能恢复
 * （2026-10-30 真机）。所以 close() 必须是真释放，而不是空操作。
 */
test('close() releases the domain so a hot-reloaded plugin can open it again', async () => {
  const storageDomain = createFakeStorageDomain();
  const credentials = createFakeCredentials();
  const vault = createVault({ credentials });
  const first = await new HostStore({ storageDomain, vault }).init();
  const record = await first.create(HOST_INPUT);

  first.close();
  assert.equal(first.ready, false, 'close() 之后句柄必须失效');

  // 热更新：同一份介质、同一个 storageDomain，新的 store 重新 open。
  const second = await new HostStore({ storageDomain, vault }).init();
  const hosts = await second.list();
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].id, record.id);
  assert.deepEqual(await second.getAuth(record.id), { kind: 'pass', password: SECRET });
  second.close();
});

test('without close() a second open fails as already-open — the failure this fixes', async () => {
  const storageDomain = createFakeStorageDomain();
  const credentials = createFakeCredentials();
  const vault = createVault({ credentials });
  await new HostStore({ storageDomain, vault }).init();

  // 不 close 直接再挂一次：这正是热更新泄漏句柄时的样子。
  await assert.rejects(
    () => new HostStore({ storageDomain, vault }).init(),
    (error) => error.code === 'storage-unavailable' && /already-open/.test(error.message),
  );
});
