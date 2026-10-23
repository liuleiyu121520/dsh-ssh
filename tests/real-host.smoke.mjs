#!/usr/bin/env node
/**
 * 近真实宿主冒烟测试：用**真实 dsh 包**验证 dsh-ssh-terminal。
 *
 * 为什么必须有这个文件：`tests/**\/*.test.js` 全部跑在
 * `tests/stubs/fake-services.mjs` 的内存替身上。替身是照设计文档里抄下来的
 * **行为契约**写的，凡是文档抄错、或者真实现比文档多/少一层的地方，单测永远
 * 绿。本轮已知有两处是工程师"防御性兼容"猜出来的形状（`src/schema.js` 给 zod
 * 挂 `schema` 自引用、`src/hosts.js` 先看 `storageDomain.defineDomain` 在不在），
 * 这两处在真 dsh 里从没执行过。本文件就是去执行它们。
 *
 * 用的全是真包（都有编译产物，直接 import lib/index.js）：
 * - `vendor/cordis`                          —— 真 cordis Context / Service 生命周期
 * - `packages/storage/storage`               —— 真 storage hub
 * - `packages/storage/storage-json`          —— 真 JSON 后端（真磁盘、真文件）
 * - `packages/storage/storage-domain`        —— 真 `DomainFacility` / `defineDomain` / `domainTable`
 * - `packages/credentials/credentials-local` —— 真 `LocalCredentialProvider`（临时 DSH_HOME）
 * - `packages/host/webserver`                —— 真 `WebServer`（真 HTTP 监听 + 真 exact/prefix 分发）
 * - `packages/core/system-prompt` + `core/tools` —— 真 `ToolRuntime`（真 JSON Schema 校验器）
 *
 * 唯一的两处"手搭"是 cordis 服务之间的接线，不是被测代码的替身：
 * - `connection` 服务用 3 行假对象（dsh 自己的 `host-routes.spec.ts:71` 也这么干）；
 * - 第二段（FIX-SIM）里 `storageDomain` / `credentials` 用薄适配器，只为把
 *   **两处已确认的缺陷**按最小修复补上，验证"其余链路到底通不通"。
 *
 * 安全：`DSH_HOME` 指向 `mkdtemp` 出来的临时目录，**绝不碰 `~/.dsh`**；
 * 脚本结束前比对 `~/.dsh` 的 md5 基线，不一致直接 FAIL。
 *
 * 用法：
 *   node tests/real-host.smoke.mjs             # 无 sshd 时跳过网络段
 *   node tests/real-host.smoke.mjs --require   # sshd 连不上就失败
 *   DSH_HARNESS_ROOT=/path/to/monorepo node tests/real-host.smoke.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const HARNESS_ROOT = process.env.DSH_HARNESS_ROOT ?? '/Users/leiyu/code/pre-study/deepseek-harness';
const P = join(HARNESS_ROOT, 'packages');
const REQUIRE = process.argv.includes('--require');

const SSH_HOST = process.env.E2E_HOST ?? '127.0.0.1';
const SSH_PORT = Number(process.env.E2E_PORT ?? 2222);
const SSH_USER = process.env.E2E_USER ?? 'root';
const SSH_PASSWORD = process.env.E2E_PASSWORD ?? 'dsh-test-123';

/** 明文探针：只允许出现在 HTTP 请求体里，绝不允许出现在任何落盘文件/响应体里。 */
const PROBE = 'QA-Plaintext-Probe-9f3c!';

/** 真 dsh 的 9 个错误码 → HTTP 状态（设计 §7.3）。 */
const STATUS_BY_CODE = {
  'invalid-host': 400,
  'duplicate-host': 409,
  'unknown-host': 404,
  'unknown-session': 404,
  'storage-unavailable': 501,
  'vault-unavailable': 502,
  'decrypt-failed': 502,
  'transfer-disabled': 400,
  'path-outside-root': 400,
};

/** @type {Array<{name: string, ok: boolean, detail: string, tier: string}>} */
const results = [];

/**
 * 记录一条断言。
 * @param {string} tier 分组。
 * @param {string} name 断言名。
 * @param {boolean} ok 是否通过。
 * @param {string} [detail] 失败细节。
 */
function check(tier, name, ok, detail = '') {
  results.push({ tier, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${tier}] ${name}${detail === '' ? '' : `\n        ↳ ${detail}`}`);
}

/** 断言相等。 */
function checkEq(tier, name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  check(tier, name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** 断言为真。 */
function checkTrue(tier, name, condition, detail = '') {
  check(tier, name, condition === true, condition === true ? '' : detail);
}

/** 收集异常的可读描述（含 cause 链）。 */
function errorChain(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    const code = current.code === undefined ? '' : ` code=${String(current.code)}`;
    parts.push(`${current.name ?? 'Error'}${code}: ${current.message ?? String(current)}`);
    current = current.cause;
  }
  return parts.join(' ← ');
}

/** 对 `~/.dsh` 做全量 md5 指纹。 */
async function fingerprintDshHome() {
  const { lines } = await scanDshHome([]);
  return lines;
}

/**
 * 一次遍历 `~/.dsh`，同时算 md5 指纹、并检查若干子串是否出现。
 *
 * 合并成一次是因为 `~/.dsh` 有近两万个文件：分多次扫会让冒烟测试从两分钟
 * 涨到六七分钟，慢到没人愿意跑，等于没有。
 * @param {string[]} needles 需要检查的子串。
 * @returns {Promise<{lines: string[], hits: Map<string, string[]>}>} 指纹与命中表。
 */
async function scanDshHome(needles) {
  const home = join(os.homedir(), '.dsh');
  /** @type {string[]} */
  const lines = [];
  /** @type {Map<string, string[]>} */
  const hits = new Map(needles.map((needle) => [needle, []]));
  /** @type {Buffer[]} */
  const needleBuffers = needles.map((needle) => Buffer.from(needle, 'utf8'));
  /**
   * 递归收集。
   * @param {string} dir 目录。
   */
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const body = await readFile(full);
        lines.push(`${createHash('md5').update(body).digest('hex')}  ${full}`);
        for (let index = 0; index < needleBuffers.length; index += 1) {
          if (body.includes(needleBuffers[index])) hits.get(needles[index]).push(full);
        }
      } catch {
        lines.push(`UNREADABLE  ${full}`);
      }
    }
  };
  await walk(home);
  return { lines, hits };
}

/** TCP 预检。 */
function reachable(host, port) {
  return new Promise((resolveProbe) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolveProbe(ok);
    };
    socket.setTimeout(3000);
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
  });
}

/** 递归按值相等找字符串，返回命中路径。 */
function findValue(node, needle, path = '$') {
  const hits = [];
  if (node === null || typeof node !== 'object') {
    if (node === needle) hits.push(path);
    return hits;
  }
  for (const [key, value] of Object.entries(node)) hits.push(...findValue(value, needle, `${path}.${key}`));
  return hits;
}

/** 递归收集全部键名。 */
function collectKeys(node, out = new Set()) {
  if (node === null || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    out.add(key);
    collectKeys(value, out);
  }
  return out;
}

/** 发 HTTP 请求。 */
async function httpRequest(url, options = {}) {
  const method = options.method ?? 'GET';
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const response = await fetch(url, {
    method,
    headers: payload === undefined ? {} : { 'content-type': 'application/json' },
    body: payload,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

/** 收一段 SSE 直到超时或满足条件。 */
async function readSse(url, ms, stopWhen = () => false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const chunks = [];
  try {
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
      if (stopWhen(chunks.join(''))) break;
    }
    await reader.cancel().catch(() => {});
  } catch {
    // abort 是正常路径：SSE 是长连接。
  } finally {
    clearTimeout(timer);
  }
  return chunks.join('');
}

/** 从 SSE 文本解出全部 data 帧的 chunk（base64）。 */
function sseDataChunks(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const frame = JSON.parse(line.slice(6));
      if (typeof frame.chunk === 'string') out.push(frame.chunk);
    } catch {
      // meta / exit 帧跳过
    }
  }
  return out;
}

/** 递归 grep 一个精确字符串（按字节包含）。 */
async function grepDir(dir, needle) {
  const hits = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const body = await readFile(full);
        if (body.includes(needle)) hits.push(full);
      } catch {
        // 无权限/二进制跳过
      }
    }
  };
  await walk(dir);
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(78));
  console.log('dsh-ssh-terminal 近真实宿主冒烟测试');
  console.log(`monorepo : ${HARNESS_ROOT}`);
  console.log(`plugin   : ${PLUGIN_ROOT}`);
  console.log('='.repeat(78));

  const dshHomeBefore = await fingerprintDshHome();
  console.log(`\n[baseline] ~/.dsh 文件指纹 ${dshHomeBefore.length} 条`);

  // ── 1. 真实包可导入性 ────────────────────────────────────────────────────
  let mods;
  try {
    const [cordis, web, storage, json, domain, cred, prompt, tools] = await Promise.all([
      import(join(HARNESS_ROOT, 'vendor/cordis/lib/index.js')),
      import(join(P, 'host/webserver/lib/index.js')),
      import(join(P, 'storage/storage/lib/index.js')),
      import(join(P, 'storage/storage-json/lib/index.js')),
      import(join(P, 'storage/storage-domain/lib/index.js')),
      import(join(P, 'credentials/credentials-local/lib/index.js')),
      import(join(P, 'core/system-prompt/lib/index.js')),
      import(join(P, 'core/tools/lib/index.js')),
    ]);
    mods = { cordis, web, storage, json, domain, cred, prompt, tools };
    check('CONTRACT', '真实 dsh 包全部可 import（8 个）', true);
  } catch (error) {
    check('CONTRACT', '真实 dsh 包全部可 import（8 个）', false, errorChain(error));
    return finish(dshHomeBefore, null);
  }

  const { defineDomainSpec } = await import(join(PLUGIN_ROOT, 'src/schema.js'));
  const { createVault, VAULT_KEY_REF } = await import(join(PLUGIN_ROOT, 'src/vault.js'));

  // ── 2. 域规格形状：真 dsh 读的是 valueSchema ─────────────────────────────
  const rawSpec = defineDomainSpec();
  checkEq('CONTRACT', '域名为 dsh_ssh', rawSpec.name, 'dsh_ssh');
  checkEq('CONTRACT', '域版本为 1', rawSpec.version, 1);
  checkEq('CONTRACT', '声明两张表 hosts/secrets', Object.keys(rawSpec.tables), ['hosts', 'secrets']);

  const hostsTableSpec = rawSpec.tables.hosts;
  const secretsTableSpec = rawSpec.tables.secrets;
  const hasValueSchema = (spec) => spec?.valueSchema !== undefined && typeof spec.valueSchema?.parse === 'function';
  checkTrue(
    'CONTRACT',
    'hosts 表规格带真 dsh 需要的 .valueSchema（ZodType）',
    hasValueSchema(hostsTableSpec),
    `真 dsh 在 storage-domain/src/index.ts:126 读 tableSpec.valueSchema.parse(raw)。
     我们给的 tables.hosts 是**裸 zod schema**（自带 parse），额外挂的不可枚举
     .schema 自引用真 dsh 根本不看。实测 valueSchema = ${String(hostsTableSpec?.valueSchema)}`,
  );
  checkTrue(
    'CONTRACT',
    'secrets 表规格带真 dsh 需要的 .valueSchema（ZodType）',
    hasValueSchema(secretsTableSpec),
    `实测 valueSchema = ${String(secretsTableSpec?.valueSchema)}`,
  );

  let defineDomainOk = false;
  let defineDomainError = '';
  try {
    mods.domain.defineDomain(rawSpec);
    defineDomainOk = true;
  } catch (error) {
    defineDomainError = errorChain(error);
  }
  check('CONTRACT', '真实 defineDomain(spec) 静态校验通过（域名/版本/表名）', defineDomainOk, defineDomainError);

  checkTrue(
    'CONTRACT',
    'DomainFacility 上没有 defineDomain 方法（src/hosts.js:118-121 是死代码）',
    typeof mods.domain.DomainFacility.prototype.defineDomain !== 'function',
    `typeof DomainFacility.prototype.defineDomain === ${typeof mods.domain.DomainFacility.prototype.defineDomain}；
     defineDomain 是 storage-domain 的顶层具名导出，不是 facility 的方法。`,
  );

  // ── 3. 真实宿主装配 ──────────────────────────────────────────────────────
  const dshHome = await mkdtemp(join(os.tmpdir(), 'dsh-ssh-real-'));
  const storageRoot = join(dshHome, 'storages');
  const credPath = join(dshHome, '.credentials.yaml');
  console.log(`\n[host] 临时 DSH_HOME = ${dshHome}`);

  const ctx = new mods.cordis.Context();
  /** 真 cordis 的 logger 默认静默；这里接管成 stdout，方便看清 apply() 内部降级原因。 */
  const loggerOf = (label) => ({
    info: (message) => console.log(`[${label}/info] ${message}`),
    warn: (message) => console.log(`[${label}/warn] ${message}`),
    error: (message) => console.log(`[${label}/error] ${message}`),
    debug: () => {},
  });
  Object.defineProperty(ctx, 'logger', { value: loggerOf('ctx1'), configurable: true, writable: true });

  /** 准入开关：一个共享对象，路由闭包里读的是 `ctx.connection.requestRejection`。 */
  const trustState = { reject: false };
  ctx.provide('connection', { requestRejection: () => (trustState.reject ? 401 : undefined) });

  try {
    await ctx.plugin(mods.web.WebServer, { host: '127.0.0.1', port: 0 });
    await ctx.plugin(mods.storage.Storage, {});
    ctx.storage.backend.register('json', new mods.json.JsonStorageBackend(storageRoot));
    await ctx.plugin(mods.cred.LocalCredentialProvider, { dshHome, watch: false });
    await ctx.plugin(mods.prompt.SystemPrompt, {});
    await ctx.plugin(mods.tools.ToolRuntime, { mode: 'native' });
    check('CONTRACT', '近真实宿主装配成功（webserver/storage/json/credentials/prompt/tools）', true);
  } catch (error) {
    check('CONTRACT', '近真实宿主装配成功', false, errorChain(error));
    return finish(dshHomeBefore, dshHome);
  }
  const origin = ctx.webServer.getOrigin();
  console.log(`[host] 真实 WebServer 监听 ${origin}`);

  // ── 4. 真 DomainFacility.open() 用我们的原始 spec ────────────────────────
  const rawFacility = () => new mods.domain.DomainFacility(ctx, { backend: 'json' });
  const openRaw = async () => {
    try {
      return { domain: await rawFacility().open(mods.domain.defineDomain(defineDomainSpec())) };
    } catch (error) {
      return { error };
    }
  };

  const firstOpen = await openRaw();
  check('STORAGE', '真实 DomainFacility.open() 在**空存储**上成功', firstOpen.domain !== undefined,
    firstOpen.error === undefined ? '' : errorChain(firstOpen.error));

  if (firstOpen.domain !== undefined) {
    const record = {
      id: 'h-0badf00d',
      label: 'rawqa@10.255.255.1',
      host: '10.255.255.1',
      port: 2222,
      username: 'rawqa',
      authKind: 'pass',
      hasSecret: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await firstOpen.domain.table('hosts').put(record.id, record);
    await firstOpen.domain.close();

    const secondOpen = await openRaw();
    check('STORAGE', '存过 1 条主机后**重开域**成功（= dsh 重启后主机还在）', secondOpen.domain !== undefined,
      secondOpen.error === undefined
        ? ''
        : `${errorChain(secondOpen.error)}
        真 dsh 在 open() 时用 valueSchema 校验每条已存记录（storage-domain/src/index.ts:119-141）；
        我们没给 valueSchema → undefined.parse → TypeError → 包成 invalid-record。
        HostStore.init() 翻成 storage-unavailable，index.js:168-172 把 state.store 置 null，
        路由退回 patch 只读主机 → **用户保存的主机每次 dsh 重启后全部消失**。`);
    if (secondOpen.domain !== undefined) {
      checkEq('STORAGE', '重开后主机条数为 1', secondOpen.domain.table('hosts').size, 1);
      await secondOpen.domain.close();
    }
  }

  // RAW 阶段的证据已落日志；FIX-SIM 从干净的介质开始，避免上一段的记录干扰断言。
  await rm(storageRoot, { recursive: true, force: true }).catch(() => {});

  // ── 5. 凭据层：resolve() 的返回形状 + DEK 轮换 ───────────────────────────
  await ctx.credentials.set(VAULT_KEY_REF, Buffer.alloc(32, 7).toString('base64'));
  const resolved = await ctx.credentials.resolve(VAULT_KEY_REF);
  checkEq('VAULT', 'credentials.resolve() 返回 {value, source} 对象（不是字符串）',
    Object.keys(resolved ?? {}).sort(), ['source', 'value']);

  const freshHome = await mkdtemp(join(os.tmpdir(), 'dsh-ssh-vault-'));
  const mkCred = async () => {
    const localCtx = new mods.cordis.Context();
    await localCtx.plugin(mods.cred.LocalCredentialProvider, { dshHome: freshHome, watch: false });
    return localCtx.credentials;
  };

  const credA = await mkCred();
  const vaultA = createVault(null, { credentials: credA });
  const sealed = await vaultA.seal(JSON.stringify({ kind: 'pass', password: PROBE }), 'h-aaaaaaaa');
  const dekBefore = (await credA.resolve(VAULT_KEY_REF))?.value;

  // 模拟 dsh 重启：新进程、新 vault、同一个 DSH_HOME
  const credB = await mkCred();
  const vaultB = createVault(null, { credentials: credB });
  let reopenOk = false;
  let reopenDetail = '';
  try {
    reopenOk = (await vaultB.open(sealed, 'h-aaaaaaaa')).includes(PROBE);
  } catch (error) {
    reopenDetail = errorChain(error);
  }
  const dekAfter = (await credB.resolve(VAULT_KEY_REF))?.value;

  checkEq('VAULT', '重启（新 vault 实例）后 DEK 保持不变', dekAfter, dekBefore);
  check('VAULT', '重启后能用旧密文解出原密码（seal → 重启 → open 往返）', reopenOk,
    reopenDetail === '' ? '解出来的明文里没有原始密码' : reopenDetail);
  await rm(freshHome, { recursive: true, force: true }).catch(() => {});

  // ── 6. FIX-SIM：只补两处最小修复，验证其余真包链路是否通 ─────────────────
  console.log('\n--- FIX-SIM：仅模拟两处最小修复（valueSchema + resolve().value），验证其余链路 ---');

  const fixedSpec = () => mods.domain.defineDomain({
    name: 'dsh_ssh',
    version: 1,
    tables: {
      hosts: mods.domain.domainTable(hostsTableSpec),
      secrets: mods.domain.domainTable(secretsTableSpec),
    },
  });

  // 第二个 Context：把 storageDomain / credentials 换成"已修复形状"的薄适配器，
  // 其余服务全是真包。适配器内部仍然调用**真** DomainFacility 与**真**凭证文件。
  const fixedCtx = new mods.cordis.Context();
  Object.defineProperty(fixedCtx, 'logger', { value: loggerOf('ctx2'), configurable: true, writable: true });
  const fixedTrust = { reject: false };
  fixedCtx.provide('connection', { requestRejection: () => (fixedTrust.reject ? 401 : undefined) });
  await fixedCtx.plugin(mods.web.WebServer, { host: '127.0.0.1', port: 0 });
  await fixedCtx.plugin(mods.storage.Storage, {});
  fixedCtx.storage.backend.register('json', new mods.json.JsonStorageBackend(storageRoot));
  await fixedCtx.plugin(mods.prompt.SystemPrompt, {});
  await fixedCtx.plugin(mods.tools.ToolRuntime, { mode: 'native' });

  // 真 credentials（独立 Context 上跑真 provider，写的是同一个真文件）
  const credCtx = new mods.cordis.Context();
  Object.defineProperty(credCtx, 'logger', { value: loggerOf('cred'), configurable: true, writable: true });
  await credCtx.plugin(mods.cred.LocalCredentialProvider, { dshHome, watch: false });
  const realCredentials = credCtx.credentials;

  fixedCtx.provide('credentials', {
    resolve: async (ref) => (await realCredentials.resolve(ref))?.value,
    describe: (ref) => realCredentials.describe(ref),
    set: (ref, value) => realCredentials.set(ref, value),
    unset: (ref) => realCredentials.unset(ref),
  });
  fixedCtx.provide('storageDomain', {
    open: () => new mods.domain.DomainFacility(fixedCtx, { backend: 'json' }).open(fixedSpec()),
  });

  const fixedOrigin = fixedCtx.webServer.getOrigin();
  console.log(`[host] FIX-SIM WebServer 监听 ${fixedOrigin}`);

  const { apply } = await import(join(PLUGIN_ROOT, 'src/index.js'));
  let dispose = null;
  let readyRace = false;
  try {
    dispose = await apply(fixedCtx, { autoOpenFirst: false });
    await dispose.ready;
    // 真 cordis 的 `ctx.inject(deps, cb)` 是**异步**激活的：apply() 里
    // `dispose.ready = Promise.all(tasks)` 在 inject 回调跑之前就求值了，
    // 此时 tasks 还是空数组 → ready 立刻 resolve，而 store.init() 还没开始。
    // 假 ctx 的 inject 是同步的，所以单测永远看不到这个竞态。
    const immediate = await httpRequest(`${fixedCtx.webServer.getOrigin()}/api/dsh-ssh/hosts/h-00000000`, {
      method: 'PATCH', body: { label: 'probe' },
    });
    readyRace = immediate.status === 501;
    checkTrue(
      'STORAGE',
      'dispose.ready 解析时持久化层已就绪（无启动竞态）',
      readyRace === false,
      `dispose.ready 已 resolve，但 PATCH 探针仍返回 501 storage-unavailable。
       原因：真 cordis 的 ctx.inject(deps, cb) 异步激活，apply() 里
       \`dispose.ready = Promise.all(tasks)\` 在 inject 回调执行前就求值了（tasks 还是空数组）。
       影响：插件激活后的短窗口内 GET /hosts 只回 patch 兜底主机、POST /hosts 回 501，
       autoOpenFirst 也会延后。src/index.js:247。`,
    );
  } catch (error) {
    check('STORAGE', 'FIX-SIM 下 apply() 的 HostStore.init() 成功', false, errorChain(error));
  }

  const base = fixedCtx.webServer.getOrigin();
  /** 等持久化层真正就绪：PATCH 探针从 501 变成 404 即为就绪。 */
  const waitForStore = async () => {
    for (let i = 0; i < 100; i += 1) {
      const probe = await httpRequest(`${base}/api/dsh-ssh/hosts/h-00000000`, { method: 'PATCH', body: { label: 'x' } });
      if (probe.status !== 501) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  check('STORAGE', 'FIX-SIM 持久化层最终就绪（真 DomainFacility + 真 storage-json）', await waitForStore());
  const listHosts = () => httpRequest(`${base}/api/dsh-ssh/hosts`);
  const readSecretsDoc = async () => JSON.parse(await readFile(join(storageRoot, 'dsh_ssh.json'), 'utf8'));

  // ── 7. 建主机（带真密码）────────────────────────────────────────────────
  const emptyList = await listHosts();
  checkEq('HTTP', 'GET /api/dsh-ssh/hosts 空表 200', emptyList.status, 200);

  const created = await httpRequest(`${base}/api/dsh-ssh/hosts`, {
    method: 'POST',
    body: {
      label: 'e2e-ssh',
      host: SSH_HOST,
      port: SSH_PORT,
      username: SSH_USER,
      auth: { kind: 'password', password: SSH_PASSWORD },
    },
  });
  checkEq('HTTP', 'POST /hosts 建主机（真密码，别名 kind:password→pass）201', created.status, 201);
  const hostId = created.json?.host?.id;
  checkTrue('HTTP', '返回的 host.id 形如 h-<8hex>', /^h-[0-9a-f]{8}$/.test(String(hostId)), `got ${String(hostId)}`);
  checkEq('HTTP', '返回的 authKind 是规范值 pass', created.json?.host?.authKind, 'pass');
  checkEq('HTTP', '返回的 hasSecret 为 true', created.json?.host?.hasSecret, true);

  // ── 8. 响应体结构化白名单 ────────────────────────────────────────────────
  const HOST_VIEW_KEYS = ['authKind', 'error', 'hasSecret', 'host', 'id', 'label', 'port', 'sid', 'status', 'username'];
  const listed = await listHosts();
  const hostObjects = listed.json?.hosts ?? [];
  checkTrue('HTTP', 'GET /hosts 至少 1 台主机', hostObjects.length >= 1, `got ${hostObjects.length}`);
  for (const hostObject of hostObjects) {
    checkEq('HTTP', `HostView 键集合恰好是白名单（${hostObject.id}）`, Object.keys(hostObject).sort(), HOST_VIEW_KEYS);
    checkTrue('HTTP', `HostView 无字段值等于真密码（${hostObject.id}）`,
      findValue(hostObject, SSH_PASSWORD).length === 0, `命中：${findValue(hostObject, SSH_PASSWORD).join(', ')}`);
  }
  const allKeys = collectKeys(listed.json);
  for (const forbidden of ['password', 'privateKey', 'passphrase', 'ct', 'iv', 'tag', 'auth']) {
    checkTrue('HTTP', `GET /hosts 响应体不含键名 "${forbidden}"`, !allKeys.has(forbidden),
      `出现的键：${[...allKeys].sort().join(', ')}`);
  }
  checkTrue('HTTP', 'GET /hosts 响应体里找不到真密码串（递归按值匹配）',
    findValue(listed.json, SSH_PASSWORD).length === 0, `命中：${findValue(listed.json, SSH_PASSWORD).join(', ')}`);

  // ── 9. PATCH：省略 auth 密文不变 ────────────────────────────────────────
  const ctBefore = (await readSecretsDoc()).tables?.secrets?.[hostId]?.ct;
  const patched = await httpRequest(`${base}/api/dsh-ssh/hosts/${hostId}`, {
    method: 'PATCH',
    body: { label: 'e2e-ssh-renamed', port: SSH_PORT },
  });
  checkEq('HTTP', 'PATCH /hosts/<id> 省略 auth → 200', patched.status, 200);
  checkEq('HTTP', 'PATCH 后 label 已更新', patched.json?.host?.label, 'e2e-ssh-renamed');
  const ctAfterPatch = (await readSecretsDoc()).tables?.secrets?.[hostId]?.ct;
  checkEq('HTTP', 'PATCH 省略 auth 时密文 ct 字节完全不变', ctAfterPatch, ctBefore);
  checkEq('HTTP', 'PATCH 省略 auth 后 hasSecret 仍为 true', patched.json?.host?.hasSecret, true);

  // ── 10. 凭据落盘的终极证明（真磁盘）─────────────────────────────────────
  const plaintextHits = await grepDir(dshHome, PROBE);
  checkTrue('HYGIENE', `临时 DSH_HOME 里 grep 不到探针密码`, plaintextHits.length === 0,
    `命中文件：${plaintextHits.join(', ')}`);
  const realHomeHits = await grepDir(join(os.homedir(), '.dsh'), PROBE);
  checkTrue('HYGIENE', '真实 ~/.dsh 里 grep 不到探针密码', realHomeHits.length === 0, `命中：${realHomeHits.join(', ')}`);
  // 顺带证明真密码本身也不落盘
  const sshPasswordHits = await grepDir(dshHome, SSH_PASSWORD);
  checkTrue('HYGIENE', '临时 DSH_HOME 里 grep 不到真 SSH 密码', sshPasswordHits.length === 0,
    `命中文件：${sshPasswordHits.join(', ')}`);

  const credText = await readFile(credPath, 'utf8');
  const dekLines = credText.split('\n').filter((line) => line.trimStart().startsWith(`${VAULT_KEY_REF}:`));
  checkEq('HYGIENE', '.credentials.yaml 里 DSH_SSH_VAULT_KEY 恰好 1 条', dekLines.length, 1);
  const dekValue = dekLines[0]?.split(':').slice(1).join(':').trim() ?? '';
  checkEq('HYGIENE', 'DEK 是 32 字节的 base64', Buffer.from(dekValue, 'base64').length, 32);

  const secretsDoc = await readSecretsDoc();
  const secretRecord = secretsDoc.tables?.secrets?.[hostId];
  checkEq('HYGIENE', 'secrets 记录键集合恰好 {ct,iv,tag,v}', Object.keys(secretRecord ?? {}).sort(), ['ct', 'iv', 'tag', 'v']);
  checkTrue('HYGIENE', 'secrets.ct 的 base64 里不含密码子串',
    typeof secretRecord?.ct === 'string' && !Buffer.from(secretRecord.ct, 'base64').toString('utf8').includes(SSH_PASSWORD),
    `ct 解出来是 ${JSON.stringify(Buffer.from(secretRecord?.ct ?? '', 'base64').toString('utf8').slice(0, 60))}`);
  const hostsDoc = secretsDoc.tables?.hosts?.[hostId] ?? {};
  checkTrue('HYGIENE', 'hosts 记录里也没有密码', findValue(hostsDoc, SSH_PASSWORD).length === 0);

  console.log('\n[DSH_HOME 文件树]');
  console.log(execFileSync('find', [dshHome, '-type', 'f'], { encoding: 'utf8' }).trim().split('\n')
    .filter(Boolean).map((line) => `  ${line.replace(dshHome, '$DSH_HOME')}`).join('\n'));
  console.log('[.credentials.yaml]');
  console.log(credText.split('\n').map((line) => `  ${line}`).join('\n'));
  console.log('[dsh_ssh.json]');
  console.log((await readFile(join(storageRoot, 'dsh_ssh.json'), 'utf8')).split('\n').map((line) => `  ${line}`).join('\n'));

  // ── 11. 真 sshd 全链路 ──────────────────────────────────────────────────
  const sshdUp = await reachable(SSH_HOST, SSH_PORT);
  console.log(`\n[sshd] ${SSH_HOST}:${SSH_PORT} ${sshdUp ? '可达' : '不可达'}`);
  if (!sshdUp) {
    check('HTTP', 'sshd 可达（--require 时失败）', REQUIRE === false, 'sshd 不可达；docker start dsh-ssh-e2e 起容器');
  } else {
    const opened = await httpRequest(`${base}/api/dsh-ssh/open`, { method: 'POST', body: { hostId, cols: 100, rows: 30 } });
    checkEq('HTTP', 'POST /open 200（真 ssh2 握手）', opened.status, 200);
    const sid = opened.json?.sid;
    checkTrue('HTTP', 'open 返回 sid', typeof sid === 'string' && sid !== '', `got ${String(sid)}`);
    checkEq('HTTP', 'open 返回会话的 host 只有 5 个公开字段',
      Object.keys(opened.json?.session?.host ?? {}).sort(), ['host', 'id', 'label', 'port', 'username']);

    let status = opened.json?.session?.status;
    for (let i = 0; i < 40 && status === 'connecting'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const probe = await listHosts();
      status = (probe.json?.sessions ?? []).find((s) => s.sid === sid)?.status ?? status;
    }
    checkEq('HTTP', '会话进入 open 状态（真 ssh2 ready）', status, 'open');

    const marker = 'QA_ECHO_MARKER_7731';
    const ssePromise = readSse(`${base}/api/dsh-ssh/stream?sid=${encodeURIComponent(String(sid))}`, 5000,
      (text) => sseDataChunks(text).map((b64) => Buffer.from(b64, 'base64').toString('utf8')).join('').includes(marker));
    await new Promise((r) => setTimeout(r, 300));

    const typed = await httpRequest(`${base}/api/dsh-ssh/input`, {
      method: 'POST',
      body: { sid, data: Buffer.from(`echo ${marker}\n`, 'utf8').toString('base64') },
    });
    checkEq('HTTP', 'POST /input 200', typed.status, 200);

    const sseText = await ssePromise;
    const streamed = sseDataChunks(sseText).map((b64) => Buffer.from(b64, 'base64').toString('utf8')).join('');
    checkTrue('HTTP', `GET /stream 收到 echo 回显（标记 ${marker}）`, streamed.includes(marker),
      `收到：${JSON.stringify(streamed.slice(0, 400))}`);
    checkTrue('HTTP', 'SSE 首帧是注释帧（: dsh-ssh stream open）', sseText.startsWith(': dsh-ssh stream open'),
      `首 80 字符：${JSON.stringify(sseText.slice(0, 80))}`);

    const context = await httpRequest(`${base}/api/dsh-ssh/context?sid=${encodeURIComponent(String(sid))}&lines=20`);
    checkEq('HTTP', 'GET /context 200', context.status, 200);
    checkTrue('HTTP', '/context 的 tail 含刚才的回显', String(context.json?.tail ?? '').includes(marker),
      `tail = ${JSON.stringify(String(context.json?.tail ?? '').slice(0, 200))}`);
    checkEq('HTTP', '/context 的 host 只有 5 个公开字段', Object.keys(context.json?.host ?? {}).sort(),
      ['host', 'id', 'label', 'port', 'username']);

    const closed = await httpRequest(`${base}/api/dsh-ssh/close`, { method: 'POST', body: { sid } });
    checkEq('HTTP', 'POST /close 200', closed.status, 200);
    const afterClose = await httpRequest(`${base}/api/dsh-ssh/context?sid=${encodeURIComponent(String(sid))}`);
    checkEq('HTTP', 'close 后再查 context → 404 unknown-session', [afterClose.status, afterClose.json?.code], [404, 'unknown-session']);

    // 一主机多标签
    const tabA = await httpRequest(`${base}/api/dsh-ssh/open`, { method: 'POST', body: { hostId } });
    const tabB = await httpRequest(`${base}/api/dsh-ssh/open`, { method: 'POST', body: { hostId } });
    checkTrue('HTTP', '同一主机开 2 个标签得到 2 个不同 sid',
      tabA.json?.sid !== tabB.json?.sid && tabA.status === 200 && tabB.status === 200,
      `sidA=${String(tabA.json?.sid)} sidB=${String(tabB.json?.sid)}`);
    const multi = await listHosts();
    const sessionsForHost = (multi.json?.sessions ?? []).filter((s) => s.host?.id === hostId);
    checkEq('HTTP', 'GET /hosts 的 sessions[] 里有 2 条该主机会话', sessionsForHost.length, 2);
    checkEq('HTTP', 'session 描述键集合恰好是白名单', Object.keys(sessionsForHost[0] ?? {}).sort(),
      ['cols', 'dropped', 'error', 'exitCode', 'host', 'rows', 'seq', 'sid', 'status']);
    checkTrue('HTTP', 'sessions[] 里递归找不到真密码', findValue(multi.json?.sessions, SSH_PASSWORD).length === 0,
      `命中：${findValue(multi.json?.sessions, SSH_PASSWORD).join(', ')}`);
    checkTrue('HTTP', 'sessions[].host 只有 5 个公开字段',
      sessionsForHost.every((s) => Object.keys(s.host ?? {}).length === 5),
      JSON.stringify(sessionsForHost.map((s) => Object.keys(s.host ?? {}))));

    // DELETE
    const deleted = await httpRequest(`${base}/api/dsh-ssh/hosts/${hostId}`, { method: 'DELETE' });
    checkEq('HTTP', 'DELETE /hosts/<id> 200', deleted.status, 200);
    checkEq('HTTP', 'DELETE 返回被关掉的 2 个 sid', (deleted.json?.closed ?? []).length, 2);
    const afterDelete = await listHosts();
    checkEq('HTTP', '删除后主机列表为空', (afterDelete.json?.hosts ?? []).length, 0);
    checkEq('HTTP', '删除后会话列表为空', (afterDelete.json?.sessions ?? []).length, 0);

    const docAfterDelete = await readSecretsDoc();
    checkTrue('HTTP', '删除主机后 secrets 表里该记录消失', docAfterDelete.tables?.secrets?.[hostId] === undefined,
      JSON.stringify(docAfterDelete.tables?.secrets));
    const credAfterDelete = await readFile(credPath, 'utf8');
    checkEq('HTTP', '删除主机后 .credentials.yaml 里 DEK **仍然**存在（不能把 DEK 也删了）',
      credAfterDelete.split('\n').filter((line) => line.trimStart().startsWith(`${VAULT_KEY_REF}:`)).length, 1);
  }

  // ── 12. 真 tools.register 收下 7 个工具 ────────────────────────────────
  const expectedTools = ['ssh_hosts', 'ssh_open', 'ssh_send', 'ssh_read', 'ssh_close', 'ssh_upload', 'ssh_download'];
  const visibleNames = fixedCtx.tools.schemas().map((schema) => schema.name);
  for (const name of expectedTools) {
    checkTrue('TOOLS', `真 ToolRuntime 里存在工具 ${name}`, visibleNames.includes(name),
      `已注册：${visibleNames.join(', ') || '(空)'}`);
  }
  checkEq('TOOLS', '真 ToolRuntime 里工具总数恰好 7', visibleNames.length, 7);

  // 手写 JSON Schema 在真校验器下合法：重名再注册必然抛错，说明第一次真进去了
  const { createSshTools } = await import(join(PLUGIN_ROOT, 'src/tools.js'));
  const fakeService = { activeSid: null, list: () => [], get: () => { throw new Error('no session'); } };
  const { definitions, promptText, promptOrder } = createSshTools({
    service: fakeService, store: () => null, config: {}, logger: () => {},
  });
  checkEq('TOOLS', 'createSshTools 产出 7 个定义', definitions.length, 7);
  checkEq('TOOLS', '工具名集合', definitions.map((d) => d.name).sort(), [...expectedTools].sort());
  for (const definition of definitions) {
    let rejected = false;
    try {
      fixedCtx.tools.register(definition);
    } catch (error) {
      rejected = /duplicate|already|exists/i.test(String(error?.message ?? ''));
    }
    checkTrue('TOOLS', `真 tools.register 二次注册 ${definition.name} 被重名拒绝`, rejected,
      '重名再注册没抛错 → 要么校验器没生效，要么第一次没注册上');
  }
  checkEq('TOOLS', 'systemPrompt 片段 order = 1750', promptOrder, 1750);
  checkTrue('TOOLS', 'systemPrompt 片段 text 是函数（每次装配求值）', typeof promptText === 'function');

  // ── 13. 准入铁律：requestRejection 对全部路由生效 ───────────────────────
  const ROUTES = [
    ['GET', '/api/dsh-ssh/hosts'],
    ['POST', '/api/dsh-ssh/hosts'],
    ['PATCH', '/api/dsh-ssh/hosts/h-00000000'],
    ['DELETE', '/api/dsh-ssh/hosts/h-00000000'],
    ['POST', '/api/dsh-ssh/open'],
    ['POST', '/api/dsh-ssh/close'],
    ['POST', '/api/dsh-ssh/input'],
    ['POST', '/api/dsh-ssh/resize'],
    ['POST', '/api/dsh-ssh/focus'],
    ['GET', '/api/dsh-ssh/context?sid=s1'],
    ['GET', '/api/dsh-ssh/stream?sid=s1'],
  ];
  // 用 fixedCtx 上注册的路由做这条断言（它有自己的 connection 服务）。
  fixedTrust.reject = true;
  for (const [method, path] of ROUTES) {
    const response = await httpRequest(`${base}${path}`, { method, body: method === 'GET' ? undefined : {} });
    checkEq('HTTP', `requestRejection=401 时 ${method} ${path} 被拒`, response.status, 401);
  }
  fixedTrust.reject = false;
  checkTrue('HTTP', 'requestRejection 复位后路由恢复可用', (await listHosts()).status === 200);
  trustState.reject = false;

  // ── 14. 错误码矩阵 ─────────────────────────────────────────────────────
  const routesSource = await readFile(join(PLUGIN_ROOT, 'src/routes.js'), 'utf8');
  for (const [code, status] of Object.entries(STATUS_BY_CODE)) {
    checkTrue('HTTP', `STATUS_BY_CODE 里 ${code} → ${status}`, new RegExp(`'${code}':\\s*${status}`).test(routesSource),
      `src/routes.js 里没找到 '${code}': ${status}`);
  }

  const invalidHost = await httpRequest(`${base}/api/dsh-ssh/hosts`, { method: 'POST', body: { host: '' } });
  checkEq('HTTP', '空 host → 400 invalid-host', [invalidHost.status, invalidHost.json?.code], [400, 'invalid-host']);
  const unknownHost = await httpRequest(`${base}/api/dsh-ssh/hosts/h-deadbeef`, { method: 'PATCH', body: { label: 'x' } });
  checkEq('HTTP', 'PATCH 不存在的主机 → 404 unknown-host', [unknownHost.status, unknownHost.json?.code], [404, 'unknown-host']);
  const unknownSession = await httpRequest(`${base}/api/dsh-ssh/close`, { method: 'POST', body: { sid: 's999' } });
  checkEq('HTTP', 'close 不存在的会话 → 404 unknown-session',
    [unknownSession.status, unknownSession.json?.code], [404, 'unknown-session']);

  // 重复主机 → 409（先重建一台再重复建）
  const dupA = await httpRequest(`${base}/api/dsh-ssh/hosts`, {
    method: 'POST', body: { host: '10.9.9.9', port: 22, username: 'qa', auth: { kind: 'none' } },
  });
  const dupB = await httpRequest(`${base}/api/dsh-ssh/hosts`, {
    method: 'POST', body: { host: '10.9.9.9', port: 22, username: 'qa', auth: { kind: 'none' } },
  });
  checkEq('HTTP', '重复 (host,port,username) → 409 duplicate-host',
    [dupA.status, dupB.status, dupB.json?.code], [201, 409, 'duplicate-host']);
  if (dupA.json?.host?.id !== undefined) {
    await httpRequest(`${base}/api/dsh-ssh/hosts/${dupA.json.host.id}`, { method: 'DELETE' });
  }

  // 客户端文案：9 个错误码是否都有翻译（code → locale key → 文案三层都要在）
  const localesSource = await readFile(join(PLUGIN_ROOT, 'src/client/locales.js'), 'utf8');
  const clientStoreSource = await readFile(join(PLUGIN_ROOT, 'src/client/store.js'), 'utf8');
  for (const code of Object.keys(STATUS_BY_CODE)) {
    const mapping = new RegExp(`'${code}':\\s*'(error[A-Za-z]+)'`).exec(clientStoreSource);
    checkTrue('HYGIENE', `store.js 有错误码 ${code} 的文案映射`, mapping !== null, `store.js 里没有 '${code}' → errorXxx`);
    if (mapping !== null) {
      checkTrue('HYGIENE', `locales.js 里有 ${mapping[1]} 的中英文案`,
        new RegExp(`${mapping[1]}:`, 'g').test(localesSource)
        && (localesSource.match(new RegExp(`${mapping[1]}:`, 'g')) ?? []).length >= 2,
        `locales.js 里 ${mapping[1]} 不足 2 处（中英各一条）`);
    }
  }

  // ── 15. authKind 枚举一致性 ────────────────────────────────────────────
  const storeSource = await readFile(join(PLUGIN_ROOT, 'src/client/store.js'), 'utf8');
  const formSource = await readFile(join(PLUGIN_ROOT, 'src/client/HostForm.jsx'), 'utf8');
  const schemaSource = await readFile(join(PLUGIN_ROOT, 'src/schema.js'), 'utf8');
  const kindsIn = (source) => {
    const match = /AUTH_KINDS\s*=\s*(?:Object\.freeze\()?\[([^\]]*)\]/.exec(source);
    return match === null ? null : match[1].replace(/['"\s]/g, '');
  };
  checkEq('HYGIENE', '服务端 AUTH_KINDS = pass/key/none', kindsIn(schemaSource), 'pass,key,none');
  checkEq('HYGIENE', '客户端 AUTH_KINDS = pass/key/none', kindsIn(storeSource), 'pass,key,none');
  const optionValues = [...formSource.matchAll(/<option\s+value="([a-z]+)"/g)].map((m) => m[1]).sort();
  checkEq('HYGIENE', 'HostForm 的 <option value> 与枚举一致', optionValues, ['key', 'none', 'pass']);

  // ── 16. 构建产物：minify 与体积 ────────────────────────────────────────
  const buildSource = await readFile(join(PLUGIN_ROOT, 'scripts/build.mjs'), 'utf8');
  checkTrue('HYGIENE', 'scripts/build.mjs 开启了 minify', /\bminify\s*:/.test(buildSource),
    'grep "minify" scripts/build.mjs 无命中 → 客户端产物没压缩');
  try {
    const clientStats = await stat(join(PLUGIN_ROOT, 'lib/client.js'));
    console.log(`\n[build] lib/client.js = ${clientStats.size} 字节 (${(clientStats.size / 1024).toFixed(1)} KB)`);
    checkTrue('HYGIENE', 'lib/client.js ≤ 520KB', clientStats.size <= 520 * 1024, `实际 ${clientStats.size} 字节`);
  } catch (error) {
    check('HYGIENE', 'lib/client.js 存在', false, errorChain(error));
  }

  // ── 17. 卸载与二次激活 ──────────────────────────────────────────────────
  // `apply()` 返回的 dispose 声称会撤掉工具/提示词片段（src/index.js:110-116 的
  // 注释明说"宿主若只调 apply() 返回的这个 dispose，工具与提示词片段也必须一起
  // 撤掉"）。真 cordis 的 `ctx.inject(deps, cb)` 返回的是 **Fiber 对象**，不是
  // 函数，于是 `typeof storageHalf === 'function'` 恒为 false，halfDisposers
  // 永远是空数组——dispose 成了空操作。
  const toolsBeforeDispose = fixedCtx.tools.schemas().length;
  try {
    if (dispose !== null) await dispose();
  } catch (error) {
    check('CONTRACT', 'dispose() 不抛错', false, errorChain(error));
  }
  const toolsAfterDispose = fixedCtx.tools.schemas().length;
  checkEq('CONTRACT', 'dispose() 之后工具全部注销', toolsAfterDispose, 0);
  if (toolsBeforeDispose !== 0 && toolsAfterDispose !== 0) {
    console.log(`[note] dispose 前 ${toolsBeforeDispose} 个工具，dispose 后仍有 ${toolsAfterDispose} 个（未注销）`);
  }

  let secondApplyOk = true;
  let secondApplyDetail = '';
  try {
    const secondDispose = await apply(fixedCtx, { autoOpenFirst: false });
    await secondDispose.ready;
  } catch (error) {
    secondApplyOk = false;
    secondApplyDetail = `${errorChain(error)}
      直接调 apply() 时路由的 ctx.effect 挂在**根** Context 上，dispose() 无法撤销；
      真 dsh 里插件由 ctx.plugin() 装载，effect 归插件 fiber 所有，卸载时由 cordis 回收。
      这一条只作为诊断信息，判定以下面那条 ctx.plugin 路径为准。`;
  }
  console.log(`[note] 直接二次 apply() ${secondApplyOk ? '成功' : '失败（路由 effect 挂在根 ctx，见下一条）'}`);

  // ── 18. 真装载路径：ctx.plugin() → fiber.dispose() ─────────────────────
  // 这才是 dsh 装载第三方插件的方式。断言卸载后路由与工具都真的消失——
  // 否则热重载第二次会撞 `duplicate exact route` / `duplicate tool name`。
  const reloadCtx = new mods.cordis.Context();
  Object.defineProperty(reloadCtx, 'logger', { value: loggerOf('ctx3'), configurable: true, writable: true });
  reloadCtx.provide('connection', { requestRejection: () => undefined });
  await reloadCtx.plugin(mods.web.WebServer, { host: '127.0.0.1', port: 0 });
  await reloadCtx.plugin(mods.prompt.SystemPrompt, {});
  await reloadCtx.plugin(mods.tools.ToolRuntime, { mode: 'native' });

  const pluginModule = await import(join(PLUGIN_ROOT, 'src/index.js'));
  let fiber = null;
  try {
    fiber = reloadCtx.plugin(pluginModule, { autoOpenFirst: false });
    await fiber;
    await new Promise((r) => setTimeout(r, 300));
    const reloadBase = reloadCtx.webServer.getOrigin();
    checkEq('CONTRACT', 'ctx.plugin() 装载后路由可用（GET /hosts 200）',
      (await httpRequest(`${reloadBase}/api/dsh-ssh/hosts`)).status, 200);
    checkEq('CONTRACT', 'ctx.plugin() 装载后 7 个工具都在', reloadCtx.tools.schemas().length, 7);

    await fiber.dispose();
    await new Promise((r) => setTimeout(r, 300));
    const afterUnload = await httpRequest(`${reloadBase}/api/dsh-ssh/hosts`);
    checkEq('CONTRACT', 'fiber.dispose() 后路由被撤销（GET /hosts 404）', afterUnload.status, 404);
    checkEq('CONTRACT', 'fiber.dispose() 后工具全部注销', reloadCtx.tools.schemas().length, 0);

    // 二次装载必须干净成功（热重载的核心诉求）。
    const secondFiber = reloadCtx.plugin(pluginModule, { autoOpenFirst: false });
    await secondFiber;
    await new Promise((r) => setTimeout(r, 300));
    checkEq('CONTRACT', '热重载：二次 ctx.plugin() 后工具仍是 7 个', reloadCtx.tools.schemas().length, 7);
    await secondFiber.dispose();
  } catch (error) {
    check('CONTRACT', 'ctx.plugin() 装载/卸载/重载全流程', false, errorChain(error));
  }

  return finish(dshHomeBefore, dshHome);
}

/**
 * 汇总 + 清理 + 退出码。
 * @param {string[]} dshHomeBefore `~/.dsh` 基线。
 * @param {string|null} tempHome 临时 DSH_HOME。
 * @returns {Promise<number>} 退出码。
 */
async function finish(dshHomeBefore, tempHome) {
  const realDsh = join(os.homedir(), '.dsh');

  // 强断言 1：真实 ~/.dsh 里不能出现任何 dsh_ssh 的落盘痕迹。
  // 强断言 2：与 dsh_ssh 相关的文件在实验前后完全一致（md5 指纹）。
  // 两件事在一次遍历里做完——见 scanDshHome 的注释。
  const needles = ['dsh_ssh', 'DSH_SSH_VAULT_KEY', PROBE, SSH_PASSWORD];
  const { lines: dshHomeAfter, hits } = await scanDshHome(needles);
  for (const needle of needles) {
    const found = hits.get(needle) ?? [];
    // 本插件自己的源码/文档不会在 ~/.dsh 里；命中的只可能是我们写的落盘数据。
    check('HYGIENE', `真实 ~/.dsh 里 grep 不到 "${needle}"`, found.length === 0,
      found.length === 0 ? '' : `命中：${found.join(', ')}`);
  }

  // 只对"与本插件相关"的路径做硬断言：~/.dsh 里还有别的进程在写
  // （our-free-model/availability.json 之类的运行时状态），把它们算进失败
  // 会变成噪声，反而让人学会忽略这条断言。
  const before = new Set(dshHomeBefore);
  const after = new Set(dshHomeAfter);
  const added = dshHomeAfter.filter((line) => !before.has(line));
  const removed = dshHomeBefore.filter((line) => !after.has(line));
  const related = [...added, ...removed].filter((line) => /dsh[-_]ssh/i.test(line));
  const unrelated = added.length + removed.length - related.length;
  check('HYGIENE', '真实 ~/.dsh 里与 dsh-ssh 相关的文件未被增删改（前后指纹一致）', related.length === 0,
    related.length === 0 ? '' : `相关变更：${related.join(', ')}`);
  if (unrelated > 0) {
    console.log(`[note] ~/.dsh 里另有 ${unrelated} 条与 dsh-ssh 无关的变更（其它进程的运行时状态），不计入失败`);
  }

  if (tempHome !== null) {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
    console.log(`\n[cleanup] 已删除临时 DSH_HOME ${tempHome}`);
  }

  const failed = results.filter((item) => !item.ok);
  const byTier = new Map();
  for (const item of results) {
    const entry = byTier.get(item.tier) ?? { pass: 0, fail: 0 };
    if (item.ok) entry.pass += 1;
    else entry.fail += 1;
    byTier.set(item.tier, entry);
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`总计 ${results.length} 条断言：通过 ${results.length - failed.length}，失败 ${failed.length}`);
  for (const [tier, entry] of byTier) console.log(`  ${tier.padEnd(10)} pass=${entry.pass} fail=${entry.fail}`);
  if (failed.length > 0) {
    console.log('\n失败清单：');
    for (const item of failed) {
      console.log(`  ✗ [${item.tier}] ${item.name}`);
      if (item.detail !== '') console.log(`      ${item.detail.split('\n').join('\n      ')}`);
    }
  }
  console.log('='.repeat(78));
  return failed.length === 0 ? 0 : 1;
}

const exitCode = await main();
process.exit(exitCode);
