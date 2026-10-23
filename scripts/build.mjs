#!/usr/bin/env node
/**
 * 构建脚本：esbuild 打客户端 bundle + 拷贝 Host 半 + 校验。
 *
 * 两半分开处理（对齐 dsh-wallpaper 的形状）：
 * - Host 半是纯 ESM JS，没有第三方 import 之外的编译需求，"构建"= 拷贝 +
 *   `node --check` 语法校验；
 * - 客户端半必须打成**一个文件** lib/client.js：esbuild（bundle, cjs,
 *   react/react-dom 外链）产出后，外面套上 dsh 客户端模块加载器契约
 *   （window.__ModuleLoader__.load）。React 由宿主通过 factory 的 require
 *   参数提供，绝不能打进 bundle——否则宿主会加载两份 React。
 *
 * `--check` 模式：全流程跑进临时目录、只校验不落盘，供 CI 门禁。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const checkMode = process.argv.includes('--check');

/**
 * Host 半文件：`src/*.js` 自动发现，原样拷贝进 lib/。
 *
 * 早先这里是硬编码数组（index/sessions/transport/routes），新增一个模块就
 * 会漏拷，产物在真机上才炸——目录扫描把"新增文件"从两处改动降为一处。
 * `src/client/` 是子目录，不在扫描范围内：客户端代码已被 esbuild 打进
 * lib/client.js，不需要单独拷贝。
 * @type {string[]}
 */
const HOST_FILES = readdirSync(join(root, 'src'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => entry.name)
  .sort();

// 入口必须存在：目录扫描若因路径变化扫空，构建要以明确原因失败，
// 而不是安静产出一个没有 index.js 的 lib/。
if (!HOST_FILES.includes('index.js')) {
  throw new Error(`build: src/index.js not found (scanned: ${HOST_FILES.join(', ') || 'none'})`);
}
/** 客户端入口与产物。 */
const CLIENT_ENTRY = join('src', 'client', 'entry.js');
const CLIENT_OUT = join('lib', 'client.js');

/**
 * 客户端 bundle 体积预算（字节，520KB）。
 *
 * 宿主每次启动都要把这个文件读进内存并执行，它不是"大一点没关系"的产物。
 * 预算写进构建脚本而不是写在文档里，是因为文档没人拦得住——超了就让构建
 * 失败，改的人必须当场决定是删代码还是调预算。
 */
const MAX_CLIENT_BYTES = 520 * 1024;

/**
 * 构建客户端 CJS bundle 到指定路径。
 *
 * `minify: true`：不加的话 519KB 的产物离 520KB 预算只剩 13KB，任何一次正常
 * 迭代都会撞线；minify 后体积砍到 ~200KB，预算才真正起到"防回归"的作用。
 * 这里只有一处 build 调用，`--check` 与正式构建共用同一套选项——不会出现
 * "check 绿、build 炸"的分裂。
 * @param {string} outfile 输出文件（相对 root）。
 * @returns {Promise<void>}
 */
async function bundleClient(outfile) {
  await build({
    entryPoints: [join(root, CLIENT_ENTRY)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    // xterm 的 CSS 在构建时读成字符串，运行时注入 <style>（见 Terminal.jsx）。
    // 客户端源码按设计用 .js/.jsx 混排（icons.js 里也是 JSX），.js 统一按
    // jsx 解析——它是 js 的语法超集，对纯 JS 文件无副作用。
    loader: { '.css': 'text', '.js': 'jsx' },
    // classic 运行时：JSX 只依赖 React.createElement，外链面收窄到 react 一个。
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    external: ['react', 'react-dom'],
    legalComments: 'none',
    logLevel: 'warning',
  });
}

/**
 * 把 esbuild 产物包进 dsh 客户端模块加载器契约。
 *
 * esbuild 的 CJS 代码引用 module/exports/require；这里给它一个自带的
 * module 作用域（IIFE 传参），require 由 loader 的 factory 参数提供。
 * 纯字符串拼接，不用 eval。
 * @param {string} bundlePath esbuild 产物路径。
 * @returns {string} 完整的 lib/client.js 内容。
 */
function wrapClientBundle(bundlePath) {
  const bundle = readFileSync(bundlePath, 'utf8').trimEnd();
  return [
    '/**',
    ' * dsh-ssh 客户端 bundle —— 由 scripts/build.mjs 生成，请勿手改。',
    ' *',
    ' * 外层是 dsh 客户端模块加载器契约（window.__ModuleLoader__.load）；',
    ' * 内层是 esbuild 的 CJS 产物，跑在一个自带的 module 作用域里。',
    ' * React 由宿主通过 factory 的 require 参数提供，没有打进本文件。',
    ' */',
    "window.__ModuleLoader__.load({",
    "  id: 'dsh-ssh-terminal',",
    '  factory(require) {',
    '    const module = { exports: {} };',
    '    (function (module, exports, require) {',
    bundle,
    '    })(module, module.exports, require);',
    '    return module.exports;',
    '  },',
    '})',
    '',
  ].join('\n');
}

/**
 * 校验客户端产物：加载器注册在、外链只剩 react/react-dom、体积在预算内。
 * @param {string} source lib/client.js 全文。
 * @returns {string[]} 发现的外链模块 id 列表（校验信息用）。
 */
function validateClientBundle(source) {
  if (!source.includes('__ModuleLoader__.load')) {
    throw new Error('client bundle: missing __ModuleLoader__.load registration');
  }
  /** @type {Set<string>} */
  const externals = new Set();
  const pattern = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) externals.add(match[2]);
  const leaked = [...externals].filter((id) => id !== 'react' && id !== 'react-dom');
  if (leaked.length > 0) {
    throw new Error(`client bundle: unexpected external require(s): ${leaked.join(', ')}`);
  }
  if (!externals.has('react')) {
    throw new Error('client bundle: react must be an external require');
  }
  // 体积预算：按 **UTF-8 字节**算，不是 String.length。文件里有中文注释与
  // 非 ASCII 字符串，两者能差出上百字节，预算必须和 `ls -la` 对得上。
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_CLIENT_BYTES) {
    throw new Error(
      `client bundle: ${bytes} bytes exceeds the ${MAX_CLIENT_BYTES}-byte budget ` +
        `(over by ${bytes - MAX_CLIENT_BYTES}); trim the client or raise MAX_CLIENT_BYTES on purpose`,
    );
  }
  return [...externals];
}

/**
 * 用 node --check 校验一个 JS 文件的语法（ESM，package.json type: module）。
 * @param {string} path 文件路径。
 * @returns {void}
 */
function checkSyntax(path) {
  execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
}

/** 主流程。 */
async function main() {
  let workDir = root;
  let tempDir = null;
  if (checkMode) {
    // --check：产物进临时目录，绝不碰 lib/。
    tempDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-build-'));
    workDir = tempDir;
    mkdirSync(join(workDir, 'lib'), { recursive: true });
  } else {
    rmSync(join(root, 'lib'), { recursive: true, force: true });
    mkdirSync(join(root, 'lib'), { recursive: true });
  }

  try {
    // 1) 客户端 bundle。
    await bundleClient(join(workDir, CLIENT_OUT));
    const clientSource = wrapClientBundle(join(workDir, CLIENT_OUT));
    if (!checkMode) writeFileSync(join(root, CLIENT_OUT), clientSource);
    const externals = validateClientBundle(clientSource);

    // 2) Host 半拷贝 + 语法校验。
    for (const file of HOST_FILES) {
      const from = join(root, 'src', file);
      const to = join(workDir, 'lib', file);
      if (!checkMode) cpSync(from, to);
      checkSyntax(checkMode ? from : to);
    }

    const mode = checkMode ? 'check' : 'build';
    const clientBytes = Buffer.byteLength(clientSource, 'utf8');
    const budgetPercent = Math.round((clientBytes / MAX_CLIENT_BYTES) * 1000) / 10;
    console.log(
      `dsh-ssh ${mode}: lib/client.js (${clientBytes} bytes = ${budgetPercent}% of the ${MAX_CLIENT_BYTES}-byte budget, ` +
        `externals: ${externals.join(', ') || 'none'}) ` +
        `+ ${HOST_FILES.length} host files${checkMode ? ' (temp dir, lib/ untouched)' : ''}`,
    );
  } finally {
    if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`build failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
