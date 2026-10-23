#!/usr/bin/env node
/**
 * 复现 dsh 桌面端 web boot 崩溃：dsh-ssh-terminal: failed
 *
 * 它抓的是"单测永远抓不到"的真机激活崩溃：仓库既有测试跑的是假 ctx 替身，
 * 不会真的走 cordis 的 fiber 激活流程，所以 `ctx.locale` 这类"未 inject 就
 * 抛异常"的行为在单测里完全隐形——只有用真 cordis + 真 cordis-plugin-loader
 * + 真 client-modules + 我们真 bundle 的 exports，在 node 里跑一遍 bootClient
 * 的逻辑，才能拿到 apply 的真实异常栈。
 *
 * 2026-10-24 桌面端启动崩溃（"应用无法启动或已意外停止"，web boot 审计抛出
 * "1 entry did not activate"）的根因即由本脚本复现确认：
 *   src/client/launchpad.js 的客户端入口 inject = ['launchpad']（没有 locale），
 *   而 cordis 4.x 中访问未在 inject 声明的服务属性（ctx.locale）会**抛异常**
 *   （"cannot get property "locale" without inject"），不会返回 undefined，
 *   于是 apply 一执行到该行就炸，fiber 状态 FAILED(3)，整个 app 起不来。
 *   修法：改走非抛异常访问器 ctx.get('locale')（服务缺失时返回 undefined，
 *   原文件的优雅降级判断才真正成立）；不能把 'locale' 加进 inject——宿主没有
 *   locale 服务时 fiber 会永远 pending，同样激活失败。
 *
 * 用法：
 *   node scripts/client-boot.repro.mjs
 * 退出码：0 = 条目全部激活（state=2）；1 = 有 entry failed/pending；2 = 前置条件不满足。
 *
 * 依赖的 harness 检出路径默认指向本机，可用环境变量覆盖：
 *   DSH_HARNESS_HOME  cordis / loader / client-modules 所在检出根目录
 *   DSH_SSH_ROOT     本仓库根目录（默认取脚本上级目录）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HARNESS_HOME = process.env.DSH_HARNESS_HOME ?? '/Users/leiyu/code/pre-study/deepseek-harness'
const ROOT = process.env.DSH_SSH_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)))

/** 按文件 URL 动态 import：路径要能 env 覆盖，静态 import 做不到。 */
const importFile = (absPath) => import(pathToFileURL(absPath).href)

const ID = 'dsh-ssh-terminal'

// 宿主契约：script 执行只注册 factory（window.__ModuleLoader__.load），
// factory(require) 在"物化"时才跑。client-modules 与我们的 bundle 同形。
const registrations = new Map()
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(desc) {
        registrations.set(desc.id, desc)
      },
    },
  },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)

// 最小 DOM 桩：只求模块物化不炸，不验证渲染行为。
const styleStub = () => ({ style: {}, sheet: { cssRules: [], insertRule() {} }, textContent: '', appendChild() {} })
sandbox.document = {
  getElementById: () => null,
  createElement: styleStub,
  createTextNode: () => ({}),
  head: { appendChild() {} },
  body: { appendChild() {}, classList: { add() {} } },
  documentElement: { style: { setProperty() {} } },
  addEventListener() {},
  removeEventListener() {},
}
sandbox.navigator = { userAgent: 'node', platform: 'node', language: 'en-US', languages: ['en-US'] }
sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} })
sandbox.getComputedStyle = () => ({ getPropertyValue: () => '' })
sandbox.queueMicrotask = queueMicrotask
sandbox.setTimeout = setTimeout
sandbox.clearTimeout = clearTimeout
sandbox.requestAnimationFrame = (cb) => setTimeout(cb, 0)
sandbox.cancelAnimationFrame = clearTimeout

const reactStub = new Proxy(
  { createElement: () => null, Fragment: Symbol('Fragment'), version: 'stub' },
  { get: (t, p) => (p in t ? t[p] : () => null) },
)
const platformRequire = (id) => {
  if (id === 'react' || id === 'react-dom') return reactStub
  throw new Error(`unexpected external require: ${id}`)
}

// 1) 真 client-modules
const cmSrc = readFileSync(
  join(HARNESS_HOME, 'packages/client/modules/lib/client.js'),
  'utf8',
)
vm.runInContext(cmSrc, sandbox, { filename: 'client-modules.js' })
const cmDesc = registrations.get('@deepseek-ai/dsh-client-modules')
if (cmDesc === undefined) throw new Error('client-modules bundle did not register')
const cmExports = cmDesc.factory(platformRequire)
const { createClientModuleSystem } = cmExports
if (typeof createClientModuleSystem !== 'function') {
  throw new Error(`createClientModuleSystem missing, got keys: ${Object.keys(cmExports ?? {})}`)
}

// 2) 我们的真 bundle（lib/client.js，app 实际加载的就是它）
const source = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
vm.runInContext(source, sandbox, { filename: 'client.js' })
const captured = registrations.get(ID)
if (captured === undefined) {
  throw new Error(`bundle did not register as ${ID}; got: ${[...registrations.keys()].join(', ')}`)
}
console.log('bundle registered id =', captured.id)
let raw
try {
  raw = captured.factory(platformRequire)
} catch (error) {
  console.log('FACTORY THREW:', error?.name, '|', error?.message)
  const stack = String(error?.stack ?? '')
  console.log('stack head:', stack.slice(0, 600))
  process.exit(2)
}
const entryExports = raw?.default ?? raw
console.log('entry exports keys =', Object.keys(entryExports ?? {}))
console.log('inject =', JSON.stringify(entryExports?.inject))

// 3) 装配 module system：我们的条目 + launchpad 提供方
const graph = {
  rev: 'graph',
  entries: [
    { id: 'dsh-launchpad', url: '/dsh-launchpad.js', rev: '1' },
    { id: ID, url: `/${ID}.js`, rev: '1' },
  ],
  batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: ['dsh-launchpad', ID] }],
}

const launchpadService = {
  register: (app) => {
    console.log('launchpad.register called with id =', app?.id)
    return () => {}
  },
  unregister: () => {},
  get: () => undefined,
  list: () => [],
  hasPanel: () => false,
  setPanels: () => {},
}

const staticModules = {
  'dsh-launchpad': {
    inject: [],
    apply: (ctx) => {
      ctx.reflect.provide('launchpad', launchpadService)
    },
  },
  [ID]: entryExports,
}

const target = {
  mode: 'queue',
  pendingQueue: [],
  load: () => {},
  create: (options) => createClientModuleSystem(target, { id: 'bootstrap', exports: {} }, options),
}
const modules = target.create({ boot: graph, staticModules, loadBundle: async () => {} })

// 4) bootClient 主流程（照 boot-client.ts 复刻）
const { Context } = await importFile(join(HARNESS_HOME, 'vendor/cordis/lib/index.js'))
const { default: Loader } = await importFile(join(HARNESS_HOME, 'vendor/loader/lib/index.js'))
const ctx = new Context()
await ctx.plugin(Loader)
const loader = ctx.logger === undefined ? undefined : ctx.loader
loader.internal = modules

const errors = []
const origError = ctx.logger.error.bind(ctx.logger)
ctx.logger.error = (...args) => {
  errors.push(args[0])
  origError(...args)
}

await modules.entries.start(loader, modules.manifest)
await loader.await()

const failures = []
for (const entry of loader.entries()) {
  const name = entry.options.name
  if (entry.fiber === undefined) {
    failures.push(`${name}: import failed (fiber undefined)`)
    continue
  }
  const state = entry.fiber.state
  console.log(`entry ${name}: fiber state = ${state} (2=active,3=failed,0=pending)`)
  if (state === 2) continue
  if (state === 0) {
    const missing = Object.keys(entry.fiber.inject).filter((s) => ctx.get(s) === undefined)
    failures.push(`${name}: pending (waiting for: ${missing.join(', ') || 'unknown'})`)
  } else {
    failures.push(`${name}: failed state=${state}`)
  }
}

console.log('---- captured logger errors ----')
for (const err of errors) {
  console.log(err && typeof err === 'object' ? (err.stack ?? String(err)) : String(err))
}
console.log('---- failures ----')
console.log(failures.join('\n') || '(none)')
await ctx.fiber.dispose()
process.exit(failures.length > 0 ? 1 : 0)
