/**
 * Host 半入口。
 *
 * 职责只有三件：把 patch config 变成"首次播种的主机"、建 SshSessionService
 * （传输用真实 ssh2）、注册 `/api/dsh-ssh/*` 路由。
 *
 * **分层挂载**（设计 §2.1）：底座只 inject `webServer` + `connection`，终端
 * 永远可用；持久化（`storageDomain` + `credentials`）与模型侧（`tools` +
 * `systemPrompt`）各自在自己的 `ctx.inject` 里挂载，缺哪个就只降级哪一半——
 * 一个服务没装不该让整个插件消失。
 *
 * `autoOpenFirst`（设计 §2.3 / §7.10）只在**一个会话都没有**时生效：插件激活
 * 时用户已经手动关完了标签，重启插件不该又把终端弹回来。
 */
import { SshSessionService } from './sessions.js';
import { createSsh2Transport } from './transport.js';
import { registerRoutes } from './routes.js';
import { HostStore, seedHostsFromConfig } from './hosts.js';
import { createVault } from './vault.js';
import { createSshTools } from './tools.js';
import { createChatService } from './chat.js';
import { newHostId, normalizeHostInput } from './schema.js';

export const inject = ['webServer', 'connection'];

/** 读取区间内的整数配置，越界回退默认值。 */
function intIn(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/**
 * 造一个"只打 hostId / 错误码"的日志函数（设计 §7.5）。
 *
 * 日志纪律不是洁癖：这一层手里流过的对象里有 auth 明文与 SecretBox，任何
 * 一次 `logger.info(JSON.stringify(x))` 都会把它们送进日志文件。
 * @param {object} ctx cordis 上下文。
 * @returns {(message: string) => void} 日志函数。
 */
function createLogger(ctx) {
  return (message) => {
    try {
      const logger = ctx.logger ?? (typeof ctx.get === 'function' ? ctx.get('logger') : undefined);
      if (logger !== undefined && typeof logger.info === 'function') logger.info(`[dsh-ssh] ${message}`);
    } catch {
      // 日志本身绝不能让业务流程失败。
    }
  };
}

/**
 * 无持久化层时的只读主机表（来自 patch config）。
 *
 * 只在 `storageDomain` 缺失时使用：用户能看见"配置里有这台机器"，但开不了
 * （`POST /open` 需要 store，会回 501 `storage-unavailable`）。这是设计 §2.1
 * 明确接受的降级。
 * @param {object} config patch config。
 * @returns {object[]} 主机记录数组。
 */
function buildFallbackHosts(config) {
  const now = new Date().toISOString();
  /** @type {object[]} */
  const records = [];
  for (const raw of seedHostsFromConfig(config)) {
    try {
      const normalized = normalizeHostInput(raw);
      records.push({
        id: newHostId(),
        label: normalized.label,
        host: normalized.host,
        port: normalized.port,
        username: normalized.username,
        authKind: 'none',
        hasSecret: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      // 配置里那一台写错了：跳过，不影响其余主机与路由注册。
    }
  }
  return records;
}

/**
 * 插件激活：建服务、注册路由、按依赖分层挂载持久化与模型侧。
 * @param {object} ctx cordis 上下文。
 * @param {object} [config] patch config。
 * @returns {Promise<(() => Promise<void>) & {ready: Promise<void>}>} dispose：关闭全部会话；`ready`：持久化引导完成的信号。
 */
export async function apply(ctx, config = {}) {
  const service = new SshSessionService({
    createTransport: createSsh2Transport,
    maxBufferLines: intIn(config.maxBufferLines, 2000, 100, 100000),
    maxBufferBytes: intIn(config.maxBufferBytes, 512 * 1024, 4096, 16 * 1024 * 1024),
  });
  const logger = createLogger(ctx);

  /** 晚到的依赖容器：routes 拿到的是取值函数，所以 store 后到也没问题。 */
  const state = { store: null, vault: null, chat: null };

  /**
   * 对话配置（patch config 的 `chat` 段）。
   *
   * provider/model 留空 = 运行时自动挑（第一个有模型的 provider）；
   * maxContextLines 是终端尾部进 system prompt 的行数。
   */
  const chatConfig = {
    provider: typeof config.chat?.provider === 'string' ? config.chat.provider : '',
    model: typeof config.chat?.model === 'string' ? config.chat.model : '',
    maxContextLines: intIn(config.chat?.maxContextLines, 60, 10, 500),
  };

  // 底座：路由立刻注册（不依赖任何可选服务）。
  registerRoutes(ctx, {
    service,
    store: () => state.store,
    chat: () => state.chat,
    fallbackHosts: buildFallbackHosts(config),
  });

  /** @type {Promise<void>[]} 各层引导任务，汇成 dispose.ready。 */
  const tasks = [];
  /**
   * 把 `ctx.inject()` 的返回值翻成一个可调用的 disposer。
   *
   * 真 cordis 的 `ctx.inject(deps, cb)` 返回的是 **Fiber 对象**
   * （`Fiber & PromiseLike<Fiber>`，`vendor/cordis/src/registry.ts:176`），
   * 撤销入口是它的 `fiber.dispose()` 方法，而不是"返回一个函数"。早先只判
   * `typeof === 'function'`，在真机上恒 false → `dispose()` 是空操作 →
   * 卸载后 `ctx.tools.schemas()` 里还留着 7 个工具、提示词片段也还在。
   * @param {unknown} handle `ctx.inject()` 的返回值。
   * @returns {() => unknown} 可调用的 disposer。
   */
  const toDisposer = (handle) => {
    if (typeof handle === 'function') return handle;
    if (handle !== null && typeof handle === 'object' && typeof handle.dispose === 'function') {
      return () => handle.dispose();
    }
    return () => {};
  };

  /**
   * 两个 `ctx.inject` 的 disposer。
   *
   * 真 cordis 会在插件卸载时自动跑掉 plugin scope 里的 effect，但显式持有
   * 它们更稳：宿主若只调 `apply()` 返回的这个 dispose（测试与脚本就是这么干
   * 的），工具与提示词片段也必须一起撤掉，不然二次激活会撞重名。
   * @type {Array<() => unknown>}
   */
  const halfDisposers = [];

  /**
   * 无会话时自动打开第一台已保存的主机。
   * @returns {Promise<void>} 完成即 resolve。
   */
  const autoOpenFirst = async () => {
    if (config.autoOpenFirst === false) return;
    // 只在"一个会话都没有"时生效：用户手动关完了标签就别再自动重连。
    if (service.list().length > 0) return;
    const store = state.store;
    if (store === null || store.ready !== true) return;
    const hosts = await store.list();
    if (hosts.length === 0) return;
    const [host] = hosts;
    try {
      const auth = await store.getAuth(host.id);
      service.open({ host, auth });
      logger(`auto-open ${host.id}`);
    } catch (error) {
      // 凭据解不开/连接工厂抛错：会话不进表，用户可手动重试。
      logger(`auto-open skipped ${host.id}: ${error.code ?? error.name}`);
    }
  };

  // 持久化半：有 storageDomain + credentials 才挂。
  const storageHalf = ctx.inject(['storageDomain', 'credentials'], (scoped = ctx) => {
    const storageDomain = scoped.storageDomain ?? (typeof scoped.get === 'function' ? scoped.get('storageDomain') : undefined);
    const credentials = scoped.credentials ?? (typeof scoped.get === 'function' ? scoped.get('credentials') : undefined);
    let vault;
    let store;
    try {
      vault = createVault(scoped, {
        provider: typeof config.vaultProvider === 'string' && config.vaultProvider !== '' ? config.vaultProvider : 'credentials',
        credentials,
      });
      store = new HostStore({ storageDomain, vault, logger });
    } catch (error) {
      logger(`persistence unavailable: ${error.code ?? error.name}`);
      return () => {};
    }
    state.vault = vault;
    state.store = store;
    tasks.push(
      store
        .init()
        .then(async () => {
          const seeded = await store.seed(seedHostsFromConfig(config));
          if (seeded > 0) logger(`seeded ${seeded} host(s)`);
          await autoOpenFirst();
        })
        .catch((error) => {
          // 域打不开：路由退回 patch 只读主机（store.ready 仍是 false）。
          state.store = null;
          logger(`persistence init failed: ${error.code ?? error.name}`);
        }),
    );
    return () => {
      // 插件停用：丢掉进程内缓存的 DEK（密文本身留在域里）。
      try {
        vault.forget();
      } catch {
        // ignore
      }
    };
  });
  halfDisposers.push(toDisposer(storageHalf));

  // 模型半：有 tools + systemPrompt 才挂。缺任何一个都只是"模型不能开终端"，
  // 手动 UI 完全不受影响（设计 §2.1）。
  const toolsHalf = ctx.inject(['tools', 'systemPrompt'], (scoped = ctx) => {
    const tools = scoped.tools ?? (typeof scoped.get === 'function' ? scoped.get('tools') : undefined);
    const systemPrompt = scoped.systemPrompt ?? (typeof scoped.get === 'function' ? scoped.get('systemPrompt') : undefined);
    if (tools === undefined || typeof tools.register !== 'function') {
      logger('tools half skipped: tools.register is missing');
      return () => {};
    }
    const { definitions, promptText, promptOrder } = createSshTools({
      service,
      store: () => state.store,
      config,
      logger,
    });
    /** @type {Array<() => void>} */
    const disposers = [];
    for (const definition of definitions) {
      try {
        const disposeTool = tools.register(definition);
        if (typeof disposeTool === 'function') disposers.push(disposeTool);
      } catch (error) {
        // 重名或 schema 不合规：记名字与错误码，不让整半挂掉。
        logger(`tool register failed ${definition.name}: ${error.code ?? error.name}`);
      }
    }
    if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
      const disposeSection = systemPrompt.section({
        name: 'tool:ssh',
        order: promptOrder,
        // 函数形态：每次装配求值，切标签后下一轮自动生效（设计 §2.10）。
        text: () => promptText(),
      });
      if (typeof disposeSection === 'function') disposers.push(disposeSection);
    }
    logger(`tools half mounted (${disposers.length} registrations)`);
    return () => {
      for (const disposeItem of disposers.splice(0)) {
        try {
          disposeItem();
        } catch {
          // 卸载失败不该阻断其余注册的清理。
        }
      }
    };
  });
  halfDisposers.push(toDisposer(toolsHalf));

  // 对话半：有 llm 服务才挂（右栏 AI 助手）。缺失时 /chat 回 501
  // chat-unavailable、/llm 回 {available:false}，UI 显示"未配置模型"——
  // 终端本身永远可用（设计 §2.1 的分层降级）。
  const chatHalf = ctx.inject(['llm'], (scoped = ctx) => {
    // 双保险取服务（与持久化半同一姿势）：属性访问走 fiber 链，get() 走
    // context store，两者在不同作用域可见性不同——只用一个曾让真机上
    // 对话服务拿到 null（2026-10-24 复现实测）。
    const llm = scoped.llm ?? (typeof scoped.get === 'function' ? scoped.get('llm') : undefined);
    state.chat = createChatService({
      service,
      llm: llm ?? null,
      config: chatConfig,
      logger,
      // 惰性解析 DeepSeek 账号服务（读登录态，给未登录通道打标记）。
      // 不声明进 inject——可选服务缺失不能让对话半层 pending（铁律）。
      account: () => ctx.get('deepseekAccount'),
    });
    logger(`chat half mounted${llm === undefined || llm === null ? ' (llm missing, degraded)' : ''}`);
    return () => {
      state.chat = null;
    };
  });
  halfDisposers.push(toDisposer(chatHalf));

  const dispose = async () => {
    // 先撤模型半/持久化半（工具注销、提示词片段移除、DEK 出缓存），
    // 再关会话——顺序反过来的话，注销期间仍有工具能摸到半关的会话。
    for (const disposeHalf of halfDisposers.splice(0)) {
      try {
        await disposeHalf();
      } catch {
        // 单半卸载失败不该阻断其余清理。
      }
    }
    service.closeAll();
    state.store = null;
    state.vault = null;
    state.chat = null;
  };
  /**
   * 引导完成信号。
   *
   * 真 cordis 的 `ctx.inject(deps, cb)` 是**异步激活**（返回 Fiber），回调
   * 要等依赖就绪才跑，而 `apply()` 是同步返回的。早先直接
   * `Promise.all(tasks)`：求值时 `tasks` 还是空数组，于是 `await
   * dispose.ready` 立刻 resolve，但紧接着 `POST /hosts` 仍回 501
   * `storage-unavailable`（域还没 open 完）。
   *
   * 正确顺序：先等两个 fiber 各自激活（`Fiber` 是 thenable，await 它等于
   * `fiber.await()`），此时回调已跑过、`tasks` 才被填满；再等这些任务
   * （`store.init()` → 播种 → `autoOpenFirst`）。
   * 假 ctx 的 `inject` 同步执行且返回普通函数（非 thenable），
   * `Promise.all` 会立即通过，两种宿主都正确。
   */
  dispose.ready = Promise.all([storageHalf, toolsHalf])
    .then(() => Promise.all(tasks))
    .then(() => undefined);
  return dispose;
}
