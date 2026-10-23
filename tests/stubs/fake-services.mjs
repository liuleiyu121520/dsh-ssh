/**
 * 测试替身：内存版 `ctx.storageDomain` / `ctx.credentials` + 路由挂载器。
 *
 * 为什么要有这个文件：M1 起 Host 半要用到三个 dsh 服务（storageDomain、
 * credentials、webServer 的 exact/prefix 双语义）。这些包不随插件发布，测试
 * 也不该 import dsh 内部模块，所以这里按设计文档 §1 记录的**行为契约**做一份
 * 内存实现：
 *
 * - `createFakeStorageDomain()`：`open(spec)` 返回 `Domain`，`domain.table(n)`
 *   提供 `get/put/delete/entries/keys/size`；`put` 时用 spec 里的 zod schema
 *   校验（与真实现一致——schema 写错在测试里就会炸，而不是留到真机上）。
 * - `createFakeCredentials()`：`resolve/describe/set/unset` 四个方法，全 async。
 * - `createFakeCtx()`：假 cordis 上下文，`webServer.register` 收集路由，
 *   `inject(deps, cb)` 按"服务在不在"决定是否运行（分层 inject 的测试基础）。
 * - `mountRoutes(ctx)`：起一个真 http.Server，按 `packages/host/webserver` 的
 *   分发语义（`:543-552`）——先 exact 精确命中，再对 prefix 路由取**最长**
 *   的 `p` 且要求 `pathname === p || pathname.startsWith(p + '/')`。
 *
 * 这些替身只服务于测试与 e2e 脚本，不进 lib/ 产物。
 */
import http from 'node:http';

/**
 * 域/表名合法性（`storage/storage/src/backend.ts:10`）：`/^[a-z][a-z0-9_]*$/`。
 * 假实现也校验，避免 `dsh-ssh` 这类非法名在测试里"恰好能跑"。
 */
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * 建一个内存版 storageDomain。
 *
 * `restore` 是"模拟一次进程重启"的原语：把上一次 `snapshot()` 的内容当作
 * **介质上已存在的数据**灌回来，`open()` 会像真 dsh 一样在打开时用
 * `valueSchema` 校验每条已存记录（`storage-domain/src/index.ts:119-141`）。
 * 没有这个入口，"存了主机 → 重启 → 主机还在吗"这条最重要的路径永远测不到。
 * @param {object} [options] 选项。
 * @param {object} [options.restore] `snapshot()` 的形状：`{<domain>: {<table>: {<key>: value}}}`。
 * @returns {object} 服务替身：`{open, domains, snapshot}`。
 */
export function createFakeStorageDomain(options = {}) {
  /** @type {Map<string, {spec: object, tables: Map<string, Map<string, unknown>>}>} */
  const domains = new Map();
  /** @type {object} 介质上的存量数据（`open()` 时灌进新建的域）。 */
  const medium = options.restore ?? {};

  /**
   * 把域状态导出成可 JSON.stringify 的纯对象——明文断言测试靠它。
   * @returns {object} `{<domain>: {<table>: {<key>: value}}}`。
   */
  function snapshot() {
    /** @type {object} */
    const out = {};
    for (const [domainName, entry] of domains) {
      /** @type {object} */
      const tables = {};
      for (const [tableName, rows] of entry.tables) {
        /** @type {object} */
        const rowsObject = {};
        for (const [key, value] of rows) rowsObject[key] = value;
        tables[tableName] = rowsObject;
      }
      out[domainName] = tables;
    }
    return out;
  }

  /**
   * 从表规格里取出 zod schema。
   *
   * **真契约是 `tableSpec.valueSchema`**（`storage-domain/src/spec.ts:27-32` 的
   * `DomainTableSpec`，`domainTable(schema)` 返回 `{ valueSchema: schema }`）。
   * 裸 zod schema 也接受，是为了让替身的写入校验比真实现更严一点（严格不会
   * 掩盖 bug），但 `validateStored` 只认 `valueSchema`——那条路径必须与真 dsh
   * 一模一样，否则"重启后数据还能不能读回来"就测不出来。
   * @param {unknown} tableSpec spec 里的表声明。
   * @returns {object|undefined} zod schema。
   */
  function zodOf(tableSpec) {
    if (tableSpec === undefined || tableSpec === null) return undefined;
    if (typeof tableSpec.safeParse === 'function') return tableSpec;
    if (tableSpec.valueSchema !== undefined) return tableSpec.valueSchema;
    if (typeof tableSpec.schema?.safeParse === 'function') return tableSpec.schema;
    return undefined;
  }

  /**
   * 按 spec 的 zod schema 校验待写入的值（比真实现严格：真 dsh 只在读边界校验）。
   * @param {object} entry 域条目。
   * @param {string} tableName 表名。
   * @param {unknown} value 待写入值。
   * @returns {unknown} 校验后的值（zod 会剥离未知键）。
   */
  function validateWrite(entry, tableName, value) {
    const zodSchema = zodOf(entry.spec.tables?.[tableName]);
    if (zodSchema === undefined) return value;
    const result = zodSchema.safeParse(value);
    if (!result.success) {
      throw new Error(`fake-storage-domain: ${tableName} value failed schema: ${result.error.message}`);
    }
    return result.data;
  }

  /**
   * 校验一条**介质上已存在**的记录——与真 dsh 的 `open()` 完全同形。
   *
   * 真实现（`storage-domain/src/index.ts:126`）读的是 `tableSpec.valueSchema.parse(raw)`：
   * 表规格没给 `valueSchema` 时这里是 `undefined.parse`，包成 `invalid-record`，
   * 整个 `open()` 失败。替身必须复现这个失败，否则"规格形状写错"在单测里
   * 永远是绿的。
   * @param {object} entry 域条目。
   * @param {string} tableName 表名。
   * @param {string} key 记录主键。
   * @param {unknown} raw 介质上的原始值。
   * @returns {unknown} 校验后的值。
   */
  function validateStored(entry, tableName, key, raw) {
    const tableSpec = entry.spec.tables?.[tableName];
    const zodSchema = tableSpec?.valueSchema;
    if (zodSchema === undefined) {
      throw new Error(
        `fake-storage-domain: invalid-record — domain '${entry.name}' stored record '${key}' in table '${tableName}' `
        + 'does not match its schema (table spec has no valueSchema; real dsh reads tableSpec.valueSchema.parse)',
      );
    }
    const result = zodSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `fake-storage-domain: invalid-record — domain '${entry.name}' stored record '${key}' in table '${tableName}' `
        + `does not match its schema: ${result.error.message}`,
      );
    }
    return result.data;
  }

  /**
   * 取一张表的句柄。表不存在（spec 里没声明）时抛错，与真实现一致。
   * @param {object} entry 域条目。
   * @param {string} tableName 表名。
   * @returns {object} 表句柄。
   */
  function tableHandle(entry, tableName) {
    if (!entry.tables.has(tableName)) {
      throw new Error(`fake-storage-domain: unknown table ${JSON.stringify(tableName)}`);
    }
    const rows = /** @type {Map<string, unknown>} */ (entry.tables.get(tableName));

    /**
     * 按 spec 的 zod schema 校验待写入的值。
     * @param {unknown} value 待写入值。
     * @returns {unknown} 校验后的值。
     */
    function validate(value) {
      return validateWrite(entry, tableName, value);
    }

    return {
      /**
       * 同步读一行。
       * @param {string} key 主键。
       * @returns {unknown} 值或 undefined。
       */
      get(key) {
        return rows.get(key);
      },
      /**
       * 写一行（async，与真实现同形）。
       * @param {string} key 主键。
       * @param {unknown} value 值。
       * @returns {Promise<void>} 完成后 resolve。
       */
      async put(key, value) {
        rows.set(key, validate(value));
      },
      /**
       * 删一行。
       * @param {string} key 主键。
       * @returns {Promise<void>} 完成后 resolve。
       */
      async delete(key) {
        rows.delete(key);
      },
      /**
       * 遍历 `[key, value]`。
       * @returns {Iterable<[string, unknown]>} 条目迭代器。
       */
      entries() {
        return [...rows.entries()];
      },
      /**
       * 遍历主键。
       * @returns {string[]} 主键数组。
       */
      keys() {
        return [...rows.keys()];
      },
      /** 行数。 */
      get size() {
        return rows.size;
      },
      /** 清空表（测试清理用，不在 dsh 契约里）。 */
      clear() {
        rows.clear();
      },
    };
  }

  return {
    domains,
    snapshot,
    /**
     * 打开（或创建）一个域。
     * @param {object} spec `{name, version, tables}`。
     * @returns {Promise<object>} 域句柄。
     */
    async open(spec) {
      const name = spec?.name;
      if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
        throw new Error(`fake-storage-domain: illegal domain name ${JSON.stringify(name)}`);
      }
      let entry = domains.get(name);
      if (entry === undefined) {
        /** @type {Map<string, Map<string, unknown>>} */
        const tables = new Map();
        for (const tableName of Object.keys(spec.tables ?? {})) {
          if (!NAME_PATTERN.test(tableName)) {
            throw new Error(`fake-storage-domain: illegal table name ${JSON.stringify(tableName)}`);
          }
          tables.set(tableName, new Map());
        }
        entry = { spec, name, tables };
        domains.set(name, entry);

        // 介质上已有的记录：像真 dsh 一样在 open() 时逐条校验再灌入内存。
        // 任何一条不过 → 整个 open 失败（不吞、不跳过）。
        const stored = medium[name] ?? {};
        for (const [tableName, rowsObject] of Object.entries(stored)) {
          const rows = tables.get(tableName);
          if (rows === undefined) {
            throw new Error(`fake-storage-domain: medium holds unknown table ${JSON.stringify(tableName)} in domain '${name}'`);
          }
          for (const [key, raw] of Object.entries(rowsObject ?? {})) {
            rows.set(key, validateStored(entry, tableName, key, raw));
          }
        }
      }
      const domainEntry = entry;
      return {
        name,
        version: spec?.version ?? 1,
        /**
         * 取表句柄。
         * @param {string} tableName 表名。
         * @returns {object} 表句柄。
         */
        table(tableName) {
          return tableHandle(domainEntry, tableName);
        },
        /** 导出该域的快照。 */
        snapshot() {
          /** @type {object} */
          const out = {};
          for (const [tableName, rows] of domainEntry.tables) {
            /** @type {object} */
            const rowsObject = {};
            for (const [key, value] of rows) rowsObject[key] = value;
            out[tableName] = rowsObject;
          }
          return out;
        },
        /** 关闭域（假实现里是空操作，只为对齐契约）。 */
        close() {},
      };
    },
  };
}

/**
 * 建一个内存版 credentials 服务。
 * @param {object} [initial] 初始 ref -> value。
 * @returns {object} 服务替身：`{resolve, describe, set, unset, refs, entries}`。
 */
export function createFakeCredentials(initial = {}) {
  /** @type {Map<string, string>} */
  const refs = new Map(Object.entries(initial).map(([ref, value]) => [ref, String(value)]));

  return {
    refs,
    /**
     * 读一个 ref 的明文值。
     *
     * **返回形状必须与真实现同形**：真 `CredentialProvider.resolve()` 的契约是
     * `Promise<ResolvedCredential | undefined>`，而
     * `ResolvedCredential = { value: string, source: string }`
     * （`packages/credentials/credentials/src/index.ts:118-123`）。
     * 早先这里返回裸字符串，把 `src/vault.js` 里
     * `typeof stored === 'string'` 的判断伪装成正确——真机上它恒为 false，
     * 每次进程启动都会重新生成 DEK 并覆盖旧的，既有密文永久不可解。
     * @param {string} ref CredentialRef。
     * @returns {Promise<{value: string, source: string}|undefined>} 值与来源，未配置时 undefined。
     */
    async resolve(ref) {
      const value = refs.get(ref);
      if (value === undefined) return undefined;
      return { value, source: 'file' };
    },
    /**
     * 读一个 ref 的元信息（绝不返回明文本身）。
     *
     * 形状与真 `CredentialInfo` 一致：`{ configured, source?, writable }`
     * （`credentials/src/types.ts:67-74`）。早先这里是 `{ref, present, length}`，
     * 一个只存在于替身里的形状——虽然 `src/` 目前不调 `describe`，但替身
     * 编造契约正是上一轮漏掉 DEK 轮换 bug 的同一个成因。
     * @param {string} ref CredentialRef。
     * @returns {Promise<{configured: boolean, source?: string, writable: boolean}>} 元信息。
     */
    async describe(ref) {
      if (!refs.has(ref)) return { configured: false, writable: true };
      return { configured: true, source: 'file', writable: true };
    },
    /**
     * 写一个 ref（真实现是明文落 YAML，所以这里也只存明文——这正是
     * vault.js 不把密码放这里的原因）。
     * @param {string} ref CredentialRef。
     * @param {string} value 值。
     * @returns {Promise<void>} 完成后 resolve。
     */
    async set(ref, value) {
      refs.set(ref, String(value));
    },
    /**
     * 删一个 ref。
     * @param {string} ref CredentialRef。
     * @returns {Promise<void>} 完成后 resolve。
     */
    async unset(ref) {
      refs.delete(ref);
    },
    /**
     * 全部条目（断言"某个 ref 恰好一条"用）。
     * @returns {Array<[string, string]>} 条目数组。
     */
    entries() {
      return [...refs.entries()];
    },
    /** ref 总数。 */
    get size() {
      return refs.size;
    },
  };
}

/**
 * 按 dsh webServer 的分发语义挑路由。
 *
 * `packages/host/webserver/src/index.ts:543-552`：先找 `kind==='exact'` 且
 * path 全等的；没有再找 prefix 路由里**最长**的 `p`，要求 `pathname === p`
 * 或 `pathname.startsWith(p + '/')`。顺序反了会出现 `/hosts` 被 prefix 吃掉。
 * @param {object[]} routes 注册的路由数组。
 * @param {string} pathname 请求路径（不含 query）。
 * @returns {object|undefined} 命中的路由。
 */
export function matchRoute(routes, pathname) {
  const exact = routes.find((route) => route.kind === 'exact' && route.path === pathname);
  if (exact !== undefined) return exact;
  /** @type {object|null} */
  let best = null;
  for (const route of routes) {
    if (route.kind !== 'prefix') continue;
    const path = route.path;
    if (pathname !== path && !pathname.startsWith(`${path}/`)) continue;
    if (best === null || path.length > best.path.length) best = route;
  }
  return best ?? undefined;
}

/**
 * 建一个假 cordis 上下文。
 *
 * 只需要被测代码用到的四个能力：
 * - `webServer.register(route)` 收集路由，返回 disposer；
 * - `connection.requestRejection(req)` 默认放行（传 `reject` 可模拟拒绝）；
 * - `effect(cb)` 立即执行并托管 disposer（真 cordis 语义）；
 * - `inject(deps, cb)` 全依赖就绪才运行 cb，否则跳过并记一条 skipped。
 * @param {object} [options] 选项。
 * @param {object} [options.storageDomain] storageDomain 替身。
 * @param {object} [options.credentials] credentials 替身。
 * @param {object} [options.tools] tools 替身。
 * @param {object} [options.systemPrompt] systemPrompt 替身。
 * @param {number|undefined} [options.reject] 非 undefined 时所有请求被拒。
 * @returns {object} 假上下文。
 */
export function createFakeCtx(options = {}) {
  /** @type {Map<string, object>} */
  const services = new Map();
  for (const name of ['storageDomain', 'credentials', 'tools', 'systemPrompt']) {
    if (options[name] !== undefined) services.set(name, options[name]);
  }

  /** @type {object[]} 已注册路由。 */
  const routes = [];
  /** @type {Array<() => unknown>} effect disposer。 */
  const disposers = [];
  /** @type {string[][]} 因缺服务被跳过的 inject 依赖列表。 */
  const skipped = [];

  const ctx = {
    routes,
    services,
    skipped,
    /**
     * 取服务（cordis `ctx.get`）。
     * @param {string} name 服务名。
     * @returns {object|undefined} 服务实例。
     */
    get(name) {
      return services.get(name);
    },
    /** 给服务表补一个替身（测试里晚注入用）。 */
    provide(name, service) {
      services.set(name, service);
      return service;
    },
    webServer: {
      /**
       * 注册路由。
       * @param {object} route `{kind, path, handler}`。
       * @returns {() => void} disposer。
       */
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    connection: {
      /**
       * 连接层准入。
       * @returns {number|undefined} 拒绝状态码或放行。
       */
      requestRejection() {
        return options.reject;
      },
    },
    /**
     * cordis effect：立即执行，托管返回的 disposer。
     * @param {() => unknown} callback effect 体。
     * @param {string} [label] 标签（假实现不落日志）。
     * @returns {() => void} disposer。
     */
    effect(callback, label = 'effect') {
      void label;
      const result = callback();
      const disposer = typeof result === 'function' ? result : () => {};
      disposers.push(disposer);
      return disposer;
    },
    /**
     * cordis 分层注入：依赖齐了才跑。
     *
     * **返回值形状必须与真 cordis 同形**：真 `ctx.inject(deps, cb)` 返回一个
     * `Fiber` 对象（有 `.dispose()`，且 thenable），**不是** disposer 函数。
     * 替身早先返回裸函数，于是 `src/index.js` 里
     * `if (typeof storageHalf === 'function') halfDisposers.push(...)` 在测试里
     * 恰好成立、在真宿主里恒为 false——dispose() 变成空操作，插件热重载时
     * 工具与提示词片段不会被撤销。
     * @param {string[]} deps 依赖服务名。
     * @param {(scoped: object) => unknown} callback 注入回调。
     * @returns {{dispose: () => unknown}} Fiber 形状的句柄（未运行时 dispose 是空操作）。
     */
    inject(deps, callback) {
      const missing = deps.filter((dep) => !services.has(dep));
      if (missing.length > 0) {
        skipped.push(missing);
        return { dispose: () => {} };
      }
      const result = callback(ctx);
      const disposer = typeof result === 'function' ? result : () => {};
      disposers.push(disposer);
      return { dispose: disposer };
    },
    /** 依次跑所有 disposer（模拟插件卸载）。 */
    async disposeAll() {
      while (disposers.length > 0) {
        const disposer = disposers.pop();
        await disposer();
      }
      routes.length = 0;
    },
  };
  return ctx;
}

/**
 * 把 `ctx.routes` 挂到一个真 http.Server 上，按 exact/prefix 语义分发。
 *
 * 分发规则与真 webServer 一致，因此"`/hosts` 走 exact、`/hosts/h-abc` 走
 * prefix"这类断言在这里是真的被验证，而不是绕过。
 * @param {object} ctx 假上下文（含 `routes`）。
 * @returns {Promise<{baseUrl: string, port: number, close: () => Promise<void>}>} 服务器句柄。
 */
export async function mountRoutes(ctx) {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const route = matchRoute(ctx.routes, pathname);
    if (route === undefined) {
      res.statusCode = 599;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'no route', path: pathname }));
      return;
    }
    void Promise.resolve(route.handler(req, res)).catch((error) => {
      // handler 自己会把已知错误转成响应；到这里说明是包装之外的漏网异常。
      if (!res.headersSent) {
        res.statusCode = 599;
        res.setHeader('content-type', 'application/json; charset=utf-8');
      }
      res.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = /** @type {{port: number}} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * 发一个 HTTP 请求并把响应体收完（测试与 e2e 共用）。
 * @param {string} url 完整 URL。
 * @param {object} [options] 选项。
 * @param {string} [options.method] 方法，默认 GET。
 * @param {object} [options.body] JSON body。
 * @returns {Promise<{status: number, headers: object, text: string, json: unknown}>} 响应摘要。
 */
export function request(url, options = {}) {
  const method = options.method ?? 'GET';
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers:
          payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        /** @type {Buffer[]} */
        const parts = [];
        res.on('data', (chunk) => parts.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * 造一个可脚本化的 tools 服务替身（T04 用）。
 * @returns {object} 替身：`{definitions, register, dispose}`。
 */
export function createFakeTools() {
  /** @type {object[]} */
  const definitions = [];
  return {
    definitions,
    /**
     * 注册工具：同层重名抛错（与 `core/tools/src/index.ts:1069-1094` 一致）。
     * @param {object} definition ToolDefinition。
     * @returns {() => void} disposer。
     */
    register(definition) {
      if (definitions.some((item) => item.name === definition.name)) {
        throw new Error(`fake-tools: duplicate tool name ${JSON.stringify(definition.name)}`);
      }
      definitions.push(definition);
      return () => {
        const index = definitions.indexOf(definition);
        if (index >= 0) definitions.splice(index, 1);
      };
    },
    /**
     * 按名字取工具（测试直接调 execute）。
     * @param {string} name 工具名。
     * @returns {object|undefined} ToolDefinition。
     */
    byName(name) {
      return definitions.find((item) => item.name === name);
    },
  };
}

/**
 * 造一个 systemPrompt 服务替身（T04 用）。
 * @returns {object} 替身：`{sections, section}`。
 */
export function createFakeSystemPrompt() {
  /** @type {object[]} */
  const sections = [];
  return {
    sections,
    /**
     * 注册一个提示词片段。
     * @param {object} section `{name, order, text}`。
     * @returns {() => void} disposer。
     */
    section(section) {
      sections.push(section);
      return () => {
        const index = sections.indexOf(section);
        if (index >= 0) sections.splice(index, 1);
      };
    },
    /**
     * 求值某个片段的文本——`text` 是函数时按真实现"每次装配求值"调用它。
     * @param {string} name 片段名。
     * @returns {string} 文本。
     */
    render(name) {
      const section = sections.find((item) => item.name === name);
      if (section === undefined) return '';
      return typeof section.text === 'function' ? String(section.text()) : String(section.text ?? '');
    },
  };
}
