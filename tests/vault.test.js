/**
 * `src/vault.js` 的 node --test 测试。
 *
 * 这一层是整轮唯一的"密码学"代码，所以断言写得比较死：
 * - seal → open 往返（含中文/多行私钥）；
 * - 密文盒改 1 bit（ct 或 iv）→ 必须 `decrypt-failed`，不能返回半个明文；
 * - AAD 绑定：用 B 的 hostId 解 A 的密文必须失败；
 * - DEK 只在 credentials 里生成一次（并发首次调用也只生成一把）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VAULT_KEY_REF, VaultError, createVault, isSealed } from '../src/vault.js';
import { createFakeCredentials } from './stubs/fake-services.mjs';

/**
 * 造一个 vault + 它的 credentials 替身。
 * @param {object} [options] 透传给 createVault。
 * @returns {{vault: object, credentials: object}} vault 与凭据替身。
 */
function makeVault(options = {}) {
  const credentials = createFakeCredentials();
  const vault = createVault({ credentials }, options);
  return { vault, credentials };
}

/** 翻转 base64 串里的第一个字节的 1 个 bit（保证长度不变）。 */
function flipBit(base64) {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] ^= 0x01;
  return bytes.toString('base64');
}

test('seal/open round-trips ascii, utf8 and multi-line pem', async () => {
  const { vault } = makeVault();
  const cases = [
    'p@ssw0rd',
    '口令-密码-🔐',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nabc/def+ghi==\n-----END OPENSSH PRIVATE KEY-----\n',
    '',
  ];
  for (const plain of cases) {
    const box = await vault.seal(plain, 'h-0000abcd');
    assert.equal(isSealed(box), true);
    assert.deepEqual(Object.keys(box).sort(), ['ct', 'iv', 'tag', 'v']);
    // 密文盒里绝不能出现明文（哪怕是空串以外的最短口令）。
    if (plain !== '') assert.equal(JSON.stringify(box).includes(plain), false, 'plaintext leaked into the box');
    assert.equal(await vault.open(box, 'h-0000abcd'), plain);
  }
});

test('the box is randomized: same plaintext and aad seal to different ciphertexts', async () => {
  const { vault } = makeVault();
  const first = await vault.seal('same', 'h-0000abcd');
  const second = await vault.seal('same', 'h-0000abcd');
  assert.notEqual(first.iv, second.iv, 'IV must be random per seal');
  assert.notEqual(first.ct, second.ct, 'ciphertext must differ even for identical plaintext');
  assert.equal(await vault.open(first, 'h-0000abcd'), 'same');
  assert.equal(await vault.open(second, 'h-0000abcd'), 'same');
});

test('flipping one bit of ct or iv fails with decrypt-failed', async () => {
  const { vault } = makeVault();
  const box = await vault.seal('s3cret', 'h-0000abcd');

  await assert.rejects(() => vault.open({ ...box, ct: flipBit(box.ct) }, 'h-0000abcd'), (error) => {
    assert.ok(error instanceof VaultError);
    assert.equal(error.code, 'decrypt-failed');
    return true;
  });
  await assert.rejects(() => vault.open({ ...box, iv: flipBit(box.iv) }, 'h-0000abcd'), /decrypt-failed|could not be decrypted/);
  await assert.rejects(() => vault.open({ ...box, tag: flipBit(box.tag) }, 'h-0000abcd'), (error) => error.code === 'decrypt-failed');
  // 原盒子仍然可解——失败不能有副作用。
  assert.equal(await vault.open(box, 'h-0000abcd'), 's3cret');
});

test('the aad binds the ciphertext to a hostId: another host cannot open it', async () => {
  const { vault } = makeVault();
  const box = await vault.seal('s3cret', 'h-aaaaaaaa');
  await assert.rejects(
    () => vault.open(box, 'h-bbbbbbbb'),
    (error) => error.code === 'decrypt-failed',
    'hostId is the AAD -> a foreign host must not decrypt',
  );
  assert.equal(await vault.open(box, 'h-aaaaaaaa'), 's3cret');
});

test('a malformed box is decrypt-failed, not a crash', async () => {
  const { vault } = makeVault();
  for (const bad of [null, undefined, {}, { v: 2, iv: '', tag: '', ct: '' }, { v: 1, iv: 'AA==', tag: 'AA==', ct: '' }]) {
    await assert.rejects(() => vault.open(bad, 'h-0000abcd'), (error) => error.code === 'decrypt-failed');
  }
});

test('the dek is created once in credentials and reused (concurrent first use included)', async () => {
  const { vault, credentials } = makeVault();
  const [first, second] = await Promise.all([vault.ensureDek(), vault.ensureDek()]);
  assert.equal(first.length, 32);
  assert.equal(Buffer.compare(first, second), 0, 'concurrent ensureDek must resolve to one key');

  const entries = credentials.entries().filter(([ref]) => ref === VAULT_KEY_REF);
  assert.equal(entries.length, 1, 'exactly one DSH_SSH_VAULT_KEY entry');
  assert.equal(Buffer.from(entries[0][1], 'base64').length, 32);
  assert.equal(vault.hasCachedDek(), true);

  // 同一份 credentials 上再建一个 vault（模拟重启）：读到同一把 DEK，
  // 所以旧密文仍可解。
  const box = await vault.seal('persisted', 'h-0000abcd');
  vault.forget();
  assert.equal(vault.hasCachedDek(), false);
  const revived = createVault({ credentials });
  assert.equal(await revived.open(box, 'h-0000abcd'), 'persisted', 'dek must survive a vault restart');
  assert.equal(credentials.entries().filter(([ref]) => ref === VAULT_KEY_REF).length, 1);
});

test('a corrupt key length is refused instead of silently overwritten', async () => {
  const corrupt = Buffer.from('short').toString('base64');
  const credentials = createFakeCredentials({ [VAULT_KEY_REF]: corrupt });
  const vault = createVault({ credentials });
  await assert.rejects(() => vault.ensureDek(), (error) => {
    assert.equal(error.code, 'vault-unavailable');
    return true;
  });
  // 原值必须原封不动：静默覆盖会让既有密文永久不可解。
  // 注意取 `.value`：真 `CredentialProvider.resolve()` 返回 `{value, source}`。
  assert.equal((await credentials.resolve(VAULT_KEY_REF))?.value, corrupt);
});

test('unsupported provider and missing credentials both surface vault-unavailable', () => {
  assert.throws(() => createVault({ credentials: createFakeCredentials() }, { provider: 'keychain' }), (error) => {
    assert.equal(error.code, 'vault-unavailable');
    return true;
  });
  assert.throws(() => createVault({}), (error) => error.code === 'vault-unavailable');
  assert.throws(() => createVault({ credentials: {} }), (error) => error.code === 'vault-unavailable');
});

test('ctx.get("credentials") is used when ctx.credentials is absent', async () => {
  const credentials = createFakeCredentials();
  const ctx = { get: (name) => (name === 'credentials' ? credentials : undefined) };
  const vault = createVault(ctx);
  assert.equal(vault.provider, 'credentials');
  assert.equal((await vault.ensureDek()).length, 32);
});
