# dsh-ssh-terminal

在 DeepSeek Harness（dsh）启动台里开一个 SSH 远程终端：xterm 面板 + 有界滚动缓冲 + SSE 字节流，
主机与凭据持久化到 `ctx.storageDomain`（口令走信封加密），并把手动操作暴露成七个 `ssh_*` 工具给模型。

已交付范围（M0 → M3）：

| 里程碑 | 内容 |
|---|---|
| M0 | bundle + patch + 启动台注册 + 三栏骨架 + 硬编码一台主机 + xterm 连通 + 卸载回放 |
| M1 | 主机 CRUD（`dsh_ssh` 域）、信封加密凭据、`/open` `/close` `/context` 路由、exact + prefix 双路由 |
| M2 | 七个模型工具（`ssh_hosts/open/send/read/close/upload/download`）+ 动态 `systemPrompt` 片段 |
| M3 | 右栏上下文卡（`GET /api/dsh-ssh/context` 的消费方）+ `ChatPane` 里的 `renderConversation()` 替换点 |

## 安装

```bash
dsh plugin add /path/to/dsh-ssh-terminal
```

或在本目录 `npm install && npm run build` 后整体拷贝。Host 依赖 `ssh2`（纯 JS，无原生模块）与
`zod`（表 schema）；客户端 React / xterm 由宿主或 bundle 提供。

## 配置（`cordis.patch.yml`）

| 键 | 默认 | 说明 |
|---|---|---|
| `host` / `port` / `username` / `password` | `127.0.0.1` / `22` / `''` / `''` | **一次性播种**：域里一台主机都没有时，把这一台写进去（之后用户的增删改不再被覆盖） |
| `hosts` | — | 播种列表形态（`hosts: [{label,host,port,username,password}]`），优先于平铺形态 |
| `maxBufferLines` / `maxBufferBytes` | `2000` / `524288` | 每会话滚动缓冲的上限，谁先超谁截断 |
| `autoOpenFirst` | `true` | 激活时若**一个会话都没有**，自动打开第一台已保存主机（用户手动关完后不自动重连） |
| `vaultProvider` | `credentials` | DEK 托管方。目前只支持 `credentials`，留作将来接 OS 钥匙串/passphrase KEK |
| `allowTransfer` | `false` | 模型侧 `ssh_upload/download` 总开关。写远端文件有破坏性，默认关 |
| `transferRoot` | `''`（= `process.cwd()`） | 上传/下载允许的本地根目录，`..` 与软链逃逸一律拒绝 |

客户端的保活运行时上限不是配置项，是代码常量 `src/client/store.js` 的
`MAX_KEPT_RUNTIMES`（默认 8）：超过就按 LRU 真销毁（`term.dispose()` +
`es.close()` + 摘 DOM），**绝不销毁有开着标签的**。被销毁的会话重新打开时走
`since=0` 全量回放。

## 凭据怎么存（威胁模型，别夸大）

`ctx.credentials` 是**明文**落盘（`$DSH_HOME/.credentials.yaml`，仅 0600 文件权限），所以口令
**不进**那里。采用信封加密：

| 内容 | 位置 | 形态 |
|---|---|---|
| 主机元数据 | `dsh_ssh` 域 / `hosts` 表 / `<hostId>` | `{id,label,host,port,username,authKind,hasSecret,createdAt,updatedAt}` |
| 密码 / 私钥 | `dsh_ssh` 域 / `secrets` 表 / `<hostId>` | `{v:1, iv, tag, ct}`（全 base64） |
| DEK（32B） | `ctx.credentials` ref `DSH_SSH_VAULT_KEY` | base64 随机串 |

算法 `aes-256-gcm`，12B IV，16B tag，**AAD = hostId**（把密文从 A 主机搬到 B 主机就解不开），
`node:crypto` 内置，零新增加密依赖。

- **防**：日志泄漏、HTTP 响应泄漏、`storageDomain` 公开读接口泄漏、单文件误同步/误提交、`grep` 审计。
- **不防**：已经拿到同用户本机权限的人（能同时读 DEK 与密文）。要防需要 passphrase KEK 或 OS
  钥匙串，本轮不做——`createVault(ctx, {provider})` 的 `provider` 就是留给那一步的缝。

## HTTP 路由（`/api/dsh-ssh/*`）

| 方法 | 路径 | 成功 | 错误码 |
|---|---|---|---|
| GET | `/hosts` | `{hosts:[HostView],sessions,activeSid}` | 500 |
| POST | `/hosts` | 201 `{host}` | `invalid-host` 400 / `duplicate-host` 409 / `storage-unavailable` 501 |
| PATCH | `/hosts/<id>` | 200 `{host}` | `unknown-host` 404 / `invalid-host` 400 |
| DELETE | `/hosts/<id>` | 200 `{ok,closed:[sid]}` | `unknown-host` 404 |
| POST | `/open` | 200 `{sid,session}` | `unknown-host` 404 / `vault-unavailable` 502 / `decrypt-failed` 502 |
| POST | `/close` | 200 `{ok,sid}` | `unknown-session` 404 |
| GET | `/context?sid=` | `{sid,host,status,tail,gap}` | `unknown-session` 404 |
| GET | `/stream?sid=&since=` | SSE（回放 + 实时 + `event: exit` / `event: meta`） | `unknown-session` 404 |
| POST | `/input` · `/resize` · `/focus` | `{ok,...}` | 400 / 404 |

`HostView = {id,label,host,port,username,authKind,hasSecret,status,sid,error}`——**没有**任何秘密字段，
也没有 `iv`/`tag`/`ct`。错误体统一 `{error, code}`。

`/hosts` 与 `/hosts/<id>` 共用同一个 path，靠 webServer 的 exact / prefix 双语义分开
（dsh 的 `webServer.register` 只有这两种 kind，没有路径参数）。

## 模型工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `ssh_hosts` | — | `{hosts:[{id,label,host,port,username,authKind,status,sid,active}]}` |
| `ssh_open` | `host`（id / label / 主机名）, `cols?`, `rows?` | `{sid,status,host}` |
| `ssh_send` | `text`, `submit?`（默认 true）, `sid?` | `{sid,bytes}` |
| `ssh_read` | `lines?`（默认 80，上限 500）, `sid?` | `{sid,text,truncated}` |
| `ssh_close` | `sid?` | `{sid,closed}` |
| `ssh_upload` | `local`, `remote`, `sid?` | `{bytes}` 或 `{error:'transfer-disabled'\|'path-outside-root'}` |
| `ssh_download` | `remote`, `local`, `sid?` | 同上 |

不传 `sid` 时作用于当前聚焦会话（`service.activeSid`）。`systemPrompt` 里有一段
`tool:ssh`（order `1750`）**动态求值**的提示词，切标签后下一轮自动生效。

## 开发

```bash
npm install
npm run build    # esbuild 打 lib/client.js + 自动拷贝 src/*.js 到 lib/ + 校验
npm run check    # --check 模式：全流程跑临时目录，只校验不落盘
npm test         # node --test tests/（80 个，全 fake transport + 内存 storageDomain）
npm run test:e2e # 真实 sshd 端到端（需要下面那个容器或一台真机器）
```

## 结构

```
src/
  index.js          Host：apply(ctx, config) + 分层 inject（底座/持久化/模型半）+ 播种 + autoOpenFirst
  sessions.js       SshSessionService：会话表、有界滚动缓冲（seq）、注入式 transport、readText
  transport.js      createSsh2Transport（真实 ssh2 + SFTP）+ createFakeTransport（测试）
  routes.js         /api/dsh-ssh/* 九个端点 + SSE 帧格式 + toHostView 白名单
  schema.js         zod 表 schema + 请求体归一化 + HostView
  vault.js          createVault：ensureDek / seal / open（aes-256-gcm，AAD=hostId）
  hosts.js          HostStore：dsh_ssh 域 CRUD、getAuth、patch 播种
  tools.js          七个 ToolDefinition + 动态 systemPrompt 片段
  client/
    entry.js        bundle 入口（再导出 launchpad 的 {inject, apply}）
    launchpad.js    启动台适配层——与 dsh-launchpad 的唯一耦合点
    App.jsx         三栏骨架 + 分栏拖拽（宽度解算走 columns.js）
    columns.js      三栏几何：clampWidth / solveColumns / dragCeiling（纯函数，可单测）
    SplitHandle.jsx 分栏把手：pointer capture + rAF 节流 + 拖拽基准冻结
    Hosts.jsx       左栏主机列表 + 状态灯 + 增删改
    Tabs.jsx        中栏标签条
    HostForm.jsx    新增/编辑主机弹层（密码永不回填）
    Terminal.jsx    中栏 xterm + 保活挂载
    ChatPane.jsx    右栏对话 + 上下文卡（renderConversation 替换点）
    chatStore.js    对话历史的 sessionStorage 持久层（热更新/刷新后恢复对话）
    store.js        模块级 store：跨卸载存活的状态 + xterm 运行时表
    locales.js      中英文案
    icons.js        24x24 currentColor 图标
```

## 实现要点

- **Host 半是纯 ESM JS**，构建 = 拷贝 + `node --check`（`src/*.js` 目录扫描，新增模块不用改构建脚本）；
  客户端半打成单个 `lib/client.js`（esbuild `minify: true`，体积预算 520KB 写在 `scripts/build.mjs`
  里，超了就让构建失败），外层 `window.__ModuleLoader__.load({...})`，内层 esbuild CJS 产物跑在
  自带 module 作用域里，`react` / `react-dom` 外链（宿主 `require` 提供，不进 bundle）。
- **三栏可拖拽调整宽度**：两条边界各一条 8px 命中条（`SplitHandle.jsx`，pointer capture + rAF 节流 +
  按下时冻结基准宽度），几何在 `columns.js` 解算——左栏 170–420px、右栏 280–760px，中栏保底 320px；
  容器不够宽时**先让右栏、再让左栏**，且只让步不改偏好（容器恢复后自动回到用户拖的位置）。
  宽度以 CSS 变量下发 + 两侧面板 `React.memo`，拖动时每帧只重渲外框和把手。
- **对话历史存 sessionStorage**：Host 半是无状态回合（客户端每轮 POST 完整 messages），历史只活在
  浏览器内存里——插件热更新或页面刷新会让右栏对话整段消失，而终端不会（字节流在 Host 的滚动缓冲里）。
  `chatStore.js` 按 sid 存一份消息（节流 400ms、回合结束立即落盘，40 条 / 160KB / 8 个会话封顶），
  重载后恢复并把 `pending` 按"还有没有没归属的 tool-call"重推；流式中被打断的回合标 `interrupted`，
  执行到一半的命令补一条"结果未知"的 tool 结果（否则下一轮 history 会因 tool-call 缺结果被打回）。
- **分层挂载**：`inject = ['webServer','connection']` 是底座（终端永远可用）；
  `ctx.inject(['storageDomain','credentials'], cb)` 挂持久化半（缺则退化为 patch 只读主机）；
  `ctx.inject(['tools','systemPrompt'], cb)` 挂模型半（缺则纯手动）。缺哪个只降级哪一半。
- **传输可注入**：`SshSessionService` 只认 `createTransport(config, handlers)` 契约，真实 ssh2 与测试
  fake 走同一条代码路径。
- **秘密只在两处出现**：`HostStore.getAuth()` 解出明文、`buildTransportConfig()` 拼进 transport 入参；
  函数返回即不可达。`session.host` 只有五个公开字段。
- **保活三层**（设计 §2.5）：L1 ssh2 连接在 Host；L2 xterm 实例 + SSE 订阅在客户端模块级
  `Map<sid, runtime>`；L3 xterm 的 DOM wrapper 只搬家（`appendChild` / `remove`）永不 dispose。
- **seq 回放兜底**：`GET /stream?sid=&since=` 先回放 `seq > since` 的分片再转实时。两条迟到连接边界：
  会话已是终态 → 回放后补发 `event: exit` 并收流；回放有缺口 → 先发 `event: meta`。
- **路由准入**：每条 handler 第一件事是 `ctx.connection.requestRejection(req)`。
- **删除主机三步**：`closeByHost(id)` → 删密文 → 删元数据，全成功才算成功。

## 已知边界

- 不防"已获得同用户本机权限者"（见上面的威胁模型）。
- 上下文卡是数据聚合，不是原生嵌入：`renderFactorySlot` 是 prop 不可 import，`conversation.content`
  槽在根作用域只能渲染空白，所以右栏用自家 `GET /context` 的数据 + 提示词模板。
- 凭据没有轮换提醒：DEK 一旦损坏（长度不对）会报 `vault-unavailable` 而不是静默覆盖（避免毁掉既有密文），
  需要人工 `unset` 那个 ref 后重新录入口令。
- rz/sz（ZMODEM）未做，大文件走 `ssh_upload/download`。

## 更新记录

### v0.3.0（2026-10-30）

- **三栏可拖拽调整宽度**：两条边界各一条 8px 命中条（pointer capture + rAF 节流 + 拖拽基准冻结）；
  左 170–420、右 280–760、中栏保底 320，容器变窄时先让右栏再让左栏，只让步不改偏好。
- **对话历史可恢复**：右栏消息落 `sessionStorage`（40 条 / 160KB / 8 会话封顶，节流 400ms + 回合结束立即落盘），
  插件热更新或页面刷新后对话还在；流式中被打断的回合标 `interrupted`，执行到一半的命令补一条"结果未知"的 tool 结果。
- **修输入框永久锁死**：一个批次里"自动执行 + 需确认"混合时，自动执行那条没写 `resultContent`，
  导致 pending 永远为真。pending 判据改成看卡片状态（`awaiting`），Host 的 `tool-result` 增加 `content`（进 history 的全文）。
- **修存储不可用**：`HostStore` 从不 `close()` 域句柄，热更新几次之后 `dsh_ssh` 域报 `already-open`，
  左栏退回 patch 只读主机。现在 close 句柄、`GET /hosts` 返回 `storage:{ready, reason}`、左栏底部常驻原因提示。
- **新增 `schedule_task` 工具**：右栏助手可以把"每天早上 9 点检查证书"这类需求写进 dsh 自己的调度
  （`ctx.schedule.create`），任务出现在 dsh 的定时任务列表里。会话 id 由客户端从根服务 `sessions`
  取当前会话（`retainedBy.mainView > 0`）后随 `POST /chat` 的 `dshSessionId` 传入；拿不到时明确报错，不建孤儿任务。
