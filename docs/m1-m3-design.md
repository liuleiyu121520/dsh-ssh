# dsh-ssh-terminal 增量设计 v0.3（M1 + M2 + M3）

> 基线：M0 已验收（26 文件 / 3410 行 / 29 测试绿 / e2e 6-6 / build 471KB）。
> 本文档是 M1+M2+M3 的实现依据，所有 API 结论都带源码行号，**不要凭印象改**。

## 0. 三个已核实的前提（推翻或修正了 v0.2 设计）

### 0.1 `ctx.credentials` 落盘是明文，不能直接存密码

- `packages/credentials/credentials-local/src/index.ts:450`：`document.setIn(['refs', ref], value)` —— 值原样进 YAML
- 同文件 `:466` records 同理，`:703/:724/:767` 只有 `writeFileAtomic(..., { mode: 0o600 })`
- 结论：`set()` = 明文写 `$DSH_HOME/.credentials.yaml`，仅靠文件权限保护，无加密

**决定**：密码/私钥**绝不进** `ctx.credentials`。改用信封加密：

| 内容 | 位置 | 形态 |
|---|---|---|
| 主机元数据 | `dsh_ssh` 域 / `hosts` 表 / `<hostId>` | `{id,label,host,port,username,authKind,hasSecret,createdAt,updatedAt}` |
| 密码/私钥 | `dsh_ssh` 域 / `secrets` 表 / `<hostId>` | `{v:1, iv, tag, ct}`（全 base64） |
| DEK 32B | `ctx.credentials` ref `DSH_SSH_VAULT_KEY` | base64 随机串 |

算法 `aes-256-gcm`，12B IV，AAD = `hostId`，tag 16B，`node:crypto` 内置（零新增依赖）。

**威胁模型（写进 README，不许夸大）**
- 防：日志泄漏、HTTP 响应泄漏、storageDomain 公开读接口泄漏、单文件误同步/误提交、grep 审计
- 不防：已获得同用户本机权限者（能同时读 DEK 与密文）。要防需 passphrase KEK 或 OS 钥匙串，本轮不做，`vault.js` 按 `createVault(ctx, {provider})` 留缝

### 0.2 `renderFactorySlot` 是 prop，不可 import → M3 不做原生嵌入

- `packages/client/ui-slots/src/index.ts:498-499`：`interface PropsRenderFactories { renderFactorySlot }`
- `dsh-launchpad/src/page.js:526`：`h(app.open.view, viewProps)`，viewProps 只有 `{appId, app, back, open, t, active}`，无 slot 能力
- 补充两道锁：槽必须先被父级 children 声明（`ui-slots:1208`）；`conversation.content` 是 `session-maybe` scope，根作用域 `sessionId===undefined` 只能渲染空白

**决定（用户已拍板 A）**：本轮交付**上下文卡 + 提示词模板**，`ChatPane` 内留唯一替换点 `renderConversation()`。数据来自自己的 `GET /api/dsh-ssh/context`，不碰 dsh 内部会话 API。

### 0.3 `ctx.webServer.register` 只有 exact / prefix，没有路径参数

- `packages/host/webserver/src/index.ts:43-44`：`WebRouteKind = 'exact' | 'prefix'`
- `:543-552` 先 exact，再最长前缀匹配 `p` 与 `p/<anything>`；`:366` 同 kind 同 path 重复注册抛错

**决定**：`/hosts` 走 exact（集合），新增 prefix 路由 `/api/dsh-ssh/hosts` 处理 `/hosts/<id>`。exact 优先，互不冲突。

## 1. 其它 API 事实

| API | 结论 | 证据 |
|---|---|---|
| `ctx.credentials` | 两套键空间：`CredentialRef` `/^[A-Za-z_][A-Za-z0-9_]*$/` 走 `resolve/describe/set/unset`；`CredentialKey` `<scope>/<id>` 走 `readRecord/modifyRecord/deleteRecord`。全 async | `credentials/src/index.ts:19-22,69-76,171-256` |
| 默认组合含 credentials | 是 | `bundle/base/cordis.patch.yml:125-126` |
| `ctx.storageDomain` | `open(spec) → Promise<Domain<S>>`；`defineDomain({name,version,tables})`；`domain.table(n)` → `get` 同步 / `put` async / `delete` / `entries` / `keys` / `size` / `update` | `storage-domain/src/index.ts:103-174`、`domain.ts:17-95`、`spec.ts:107-147` |
| domain/表名规则 | `/^[a-z][a-z0-9_]*$/` → 必须 `dsh_ssh`，`dsh-ssh` 非法 | `storage/storage/src/backend.ts:10` |
| 表 schema | 必须是 **zod** `ZodType`（`domainTable(schema)`） | `spec.ts:27-32,91-93,140-145` |
| 默认组合含 storage-domain | 是（json 后端，root `$DSH_HOME/storages`，明文文档 → 所以只放密文） | `bundle/base/cordis.patch.yml:179-190` |
| `ctx.tools.register` | `register(def) → dispose`；校验 `output{schema,render}` 必填；同层重名抛错 | `core/tools/src/index.ts:1069-1094` |
| 工具 parameters | 裸 JSON Schema，`register` 只校验 `output.schema` → **可手写 ToolDefinition，不必 import `@deepseek-ai/dsh-tools`** | `llm/llm/src/types.ts:491-502`、`tools/src/index.ts:1073` |
| JSON Schema 子集 | 仅 `type/oneOf/properties/required/additionalProperties/items/enum/const/description/title/default/examples`，**无 min/max/pattern** → 数值/格式约束在 `execute` 里自己校验 | `tools/src/json-schema.ts:1-68` |
| 工具名占用 | 全仓无 `ssh_*` 工具，七个名字安全 | grep |
| `ctx.systemPrompt` | `section({name,order,text,interpolate?,complete?})`；`text` 可为 `(ctx)=>string`，**每次装配求值** → 可动态 | `system-prompt/src/index.ts:59-79,478-491` |
| order | 用 `1750`（PTY 1700 与 WEB_SEARCH 2000 之间） | 同上 `:131-168` |
| 可选服务降级 | `ctx.inject([...], cb)` + `ctx.get('x')` 探测，缺服务只卸载该 fiber | `storage-domain/src/index.ts:223-235` |

**未验证**：`SessionReferenceSource` 是否运行时白名单（本轮不需要）；storage-json 是否有压缩/加密选项（本轮不需要）。

## 2. 关键决策

1. **分层挂载**：`inject = ['webServer','connection']` 为底座（终端永远可用）；`ctx.inject(['storageDomain','credentials'], cb)` 持久化半，缺则退化为 patch 只读主机；`ctx.inject(['tools','systemPrompt'], cb)` 模型半，缺则纯手动。
2. **主机 id 服务端生成 `h-<8hex>`**，客户端不得指定（防改 id 绕过凭据绑定）。
3. **`open`/`close` 是独立路由**，激活不再隐式连接；保留 `config.autoOpenFirst`（默认 true，仅在无任何会话时生效，用户手动关完不自动重连）。
4. **删除主机三步**：`closeByHost(id)` → `secrets.delete(id)` → `hosts.delete(id)`，全成功才算成功。
5. **多标签 = 一主机多 session**：sid 单调计数、runtimes 按 sid 保活，客户端只需加 tab 顺序数组。
6. **手写 ToolDefinition 字面量**，不 import dsh 包（第三方插件约定：只通过 ctx 服务交互；避免第二份 dsh 包副本版本漂移）。
7. **每个工具接受显式 `sid`**，缺省才回落 `service.activeSid`。
8. **`ssh_send` 的 `submit` 默认 true**。
9. **`ssh_upload/download` 默认关闭**（`allowTransfer:false`），开启后本地路径必须在 `transferRoot`（默认 `process.cwd()`）内，`..` 逃逸拒绝。
10. **`systemPrompt` 用函数求值**，不缓存，切标签后下一轮自动生效。
11. **`session.host` 永不持有秘密**：秘密只出现在 `createTransport(config)` 入参里，函数返回即不可达。

## 3. 文件清单

### 新增（Host）
| 文件 | 职责 |
|---|---|
| `src/schema.js` | zod 主机/密文 schema + `normalizeHostInput` 请求体校验 |
| `src/vault.js` | `createVault(ctx,{provider})`：`ensureDek/seal(plain,aad)/open(box,aad)` |
| `src/hosts.js` | `HostStore`：域初始化、CRUD、密文读写、patch 播种 |
| `src/tools.js` | 7 个 ToolDefinition + systemPrompt section |

### 修改（Host）
| 文件 | 改什么 |
|---|---|
| `src/index.js` | 分层 inject、建 Vault+HostStore、播种 + autoOpenFirst、dispose |
| `src/sessions.js` | `session.host` 剥离秘密；`open({host,auth})`；`readText(sid,lines)`；`closeByHost`；`listByHost` |
| `src/routes.js` | + `open/close/context`、`/hosts` exact + `/hosts/<id>` prefix、`toHostView`、错误码 |
| `src/transport.js` | 契约加可选 `uploadFile/downloadFile`（ssh2 用 `connection.sftp()`，fake 记录调用） |

### 新增（Client）
| 文件 | 职责 |
|---|---|
| `src/client/Tabs.jsx` | 中栏标签条（主机名+序号、关闭、+ 新标签） |
| `src/client/HostForm.jsx` | 新增/编辑主机弹层（密码 `type=password`，永不回填） |

### 修改（Client）
`store.js`（tabs + 6 个 action）、`App.jsx`（中栏 = Tabs + Terminal，挂 HostForm）、`Hosts.jsx`（行内 +标签/编辑/删除，删除二次确认）、`ChatPane.jsx`（`renderConversation()` 单点 + ContextCard）、`locales.js`（约 20 条文案）

### 测试
`tests/stubs/fake-services.mjs`（新，内存 storageDomain/credentials + 支持 prefix 的 mountRoutes）、`tests/vault.test.js`（新）、`tests/hosts.test.js`（新）、`tests/tools.test.js`（新）、`tests/routes.test.js`（改）、`tests/store.test.js`（改）、`scripts/e2e.mjs`（改）

### 配置
`package.json`（+`zod@4.4.3`，**name 改 `dsh-ssh-terminal`**）、`scripts/build.mjs`（HOST_FILES 自动发现 `src/*.js`）、`cordis.patch.yml`（+`autoOpenFirst/vaultProvider/allowTransfer/transferRoot/maxTabs`）

## 4. 路由表

| 方法 | 路径 | 请求体 | 成功 | 错误 |
|---|---|---|---|---|
| GET | `/api/dsh-ssh/hosts` | — | `{hosts:[HostView],sessions,activeSid}` | 500 |
| POST | `/api/dsh-ssh/hosts` | `{label,host,port,username,auth:{kind,password?,privateKey?,passphrase?}}` | 201 `{host}` | 400 `invalid-host` / 409 `duplicate-host` / 501 `storage-unavailable` |
| PATCH | `/api/dsh-ssh/hosts/<id>` | 同上，`auth` 可省=不改 | 200 `{host}` | 404 `unknown-host` |
| DELETE | `/api/dsh-ssh/hosts/<id>` | — | 200 `{ok,closed:[sid]}` | 404 |
| POST | `/api/dsh-ssh/open` | `{hostId,cols?,rows?}` | 200 `{sid,session}` | 404 `unknown-host` / 502 `vault-unavailable` |
| POST | `/api/dsh-ssh/close` | `{sid}` | 200 `{ok,sid}` | 404 `unknown-session` |
| GET | `/api/dsh-ssh/context?sid=` | — | `{sid,host,status,tail,gap}` | 404 |

`HostView = {id,label,host,port,username,authKind,hasSecret,status,sid,error}`，**无 password/privateKey/iv/tag/ct**。
错误体 `{error, code}`（向后兼容 M0 只有 `error`）。

## 5. 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `ssh_hosts` | — | `{hosts:[{id,label,host,port,username,authKind,status,sid,active}]}` |
| `ssh_open` | `host`(required), `cols`?, `rows`? | `{sid,status}` |
| `ssh_send` | `text`(required), `submit`?(默认 true), `sid`? | `{sid,bytes}` |
| `ssh_read` | `lines`?(默认 80, ≤500), `sid`? | `{sid,text,truncated}` |
| `ssh_close` | `sid`? | `{sid,closed}` |
| `ssh_upload` | `local`, `remote`(required), `sid`? | `{bytes}` |
| `ssh_download` | `remote`, `local`(required), `sid`? | `{bytes}` |

`systemPrompt.section({name:'tool:ssh', order:1750, text: () => 有会话 ? '当前 SSH 会话：<label>（user@host:port，状态 open）。ssh_send/ssh_read 默认作用于它。' : '当前没有打开的 SSH 会话。'})`

## 6. 任务列表

### T01 基础设施（P0，无依赖）
`package.json`（+zod 4.4.3，name→dsh-ssh-terminal）、`build.mjs`（HOST_FILES 自动发现）、`cordis.patch.yml`（5 个新配置项）、`tests/stubs/fake-services.mjs`
**验收**：29/29 仍绿；`npm run check` 绿；`node -e "import('zod')..."` 输出 function；fake-services 自带 3 条自测（prefix 匹配 / 最长前缀 / domain 读写）

### T02 凭据与主机持久化（P0，依赖 T01）
`src/schema.js`、`src/vault.js`、`src/hosts.js`、`tests/vault.test.js`、`tests/hosts.test.js`
**验收**：
- seal→open 往返；改 1 bit ct/iv 抛 `decrypt-failed`；用 B 的 hostId 解 A 的密文抛错
- **明文断言**：建主机后整个 domain 快照 `JSON.stringify` 不含密码子串；credentials stub 里 `DSH_SSH_VAULT_KEY` 恰好 1 条
- `update` 不带 auth 时密文不变（ct 字节相等）；`remove` 后 `secrets.get(id) === undefined`
- 29/29 仍绿

### T03 会话生命周期与路由（P0，依赖 T02）
`src/sessions.js`、`src/routes.js`、`src/index.js`、`tests/routes.test.js`、`scripts/e2e.mjs`
**验收**：
- `GET /hosts` 响应体 grep `password|privateKey|"ct"|"iv"|"tag"` 为空
- open→close→open 循环；`DELETE /hosts/<id>` 返回 closed 数组且 `service.list()` 为空
- prefix 路由命中 `/hosts/h-abc`，`/hosts` 仍走 exact（两条独立断言）
- e2e 6 项 + 新增 open/close/context 3 项全过（`npm run test:e2e -- --require`）
- 29 测试绿（harness 换 mountRoutes）

### T04 模型侧接管（P1，依赖 T03）
`src/tools.js`、`src/index.js`、`src/transport.js`、`tests/tools.test.js`
**验收**：
- 7 个 register 全成功；重名注册抛错（证明 dispose 生效）
- `ssh_send` 不传 sid → fake transport 收到 activeSid 会话的字节；传 sid → 打到指定会话
- `ssh_read({lines:3})` 返回最后 3 行，中文/ANSI 不乱码
- `allowTransfer:false` → `{error:'transfer-disabled'}` 且不调 transport；`local:'../../etc/passwd'` 被拒
- promptText 调两次、activeSid 变了 → 文本不同
- 去掉 `tools` 服务后 `apply()` 仍成功（分层 inject）

### T05 客户端 UI（P0，依赖 T01，可与 T02-T04 并行）
`store.js`、`App.jsx`、`Hosts.jsx`、`Tabs.jsx`、`HostForm.jsx`、`ChatPane.jsx`、`locales.js`、`tests/store.test.js`
**验收**：
- 一主机开 3 标签：`runtimes.size===3`，切标签后 term 实例引用不变
- 关标签 → 该 sid runtime 仍保留，重开复用同一实例
- 表单编辑时密码框 `value===''` 且 placeholder「留空保持不变」
- 删除有会话的主机 → 先 POST /close 再 DELETE（fetch 桩断言顺序）
- `npm run build` externals 仍只有 react/react-dom；体积 ≤ 520KB
- 29/29 绿 + store 新断言

依赖图：`T01 → T02 → T03 → T04`，`T01 → T05`

## 7. 共享约定（硬性）

1. **命名**：hostId `h-<8hex>`；sid `s<n>`；domain `dsh_ssh`；表 `hosts`/`secrets`；ref `DSH_SSH_VAULT_KEY`
2. **store action**：`loadHosts/refreshHosts/openSession/closeSession/createHost/updateHost/deleteHost/openForm/closeForm/setActiveSid/toggleChat/showToast`
3. **错误码**：`invalid-host` `duplicate-host` `unknown-host` `unknown-session` `storage-unavailable` `vault-unavailable` `decrypt-failed` `transfer-disabled` `path-outside-root`
4. **状态机**：`connecting → open → closed | error`；主机 `status = session?.status ?? 'offline'`
5. **日志纪律**：只允许打 hostId/sid/错误码，**禁止**打 auth 对象、请求体全文、SecretBox 任何字段
6. **响应体纪律**：序列化前必过 `toHostView()`，新增字段显式白名单，禁止 `...host` 展开
7. **每条路由第一件事**仍是 `ctx.connection.requestRejection(req)`
8. **构建约束**：客户端 `.jsx` + esbuild 单 bundle，react/react-dom 外链；Host 纯 ESM JS（拷贝 + `node --check`）；**不引入 TS 构建链**
9. **`session.host` 永不持有秘密**
10. **`autoOpenFirst`** 只在无任何会话时生效
