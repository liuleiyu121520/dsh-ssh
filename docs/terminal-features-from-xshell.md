# Xshell 7 Shell 功能对标与 dsh-ssh 落地清单

> 材料来源：Xshell7_en.pdf References p86 完整快捷键表（材料 A）＋ 同手册键盘/终端设置（材料 B）＋ example.tkm（材料 C）＋ 本仓库源码勘察：`src/client/Terminal.jsx`、`src/client/store.js`、`src/routes.js`、`src/transport.js`、`src/sessions.js`（材料 D）
> 日期：2026-10-24
> 用途：dsh-ssh 插件（启动台 SSH 终端，xterm + SSE 字节流 + ssh2）对标 Xshell 7 的权威实现参考。每条包含：Xshell 怎么做 / dsh-ssh 现状 / 要动的文件 / 浏览器与架构限制。无材料依据的论断均标注"设计建议"。

---

## 1. PTY 标准控制字符

dsh-ssh 现状（材料 D）：`store.js` 的 `term.onData` → `POST /input`（base64），xterm 默认把 Ctrl 组合键翻成控制字节透传，因此下表"xterm 默认透传"列全部为"是"。落地工作不在按键捕获，而在**服务端 PTY 配置与 shell 本地行为的预期管理**。

| 组合键 | 字节 | 语义 | xterm 默认透传 | 注意事项 |
|---|---|---|---|---|
| Ctrl+@ | 0x00 | NUL | 是 | 极少使用 |
| Ctrl+A | 0x01 | readline 行首 / tmux prefix | 是 | 在 tmux/screen 里是 prefix，勿占用为本地快捷键 |
| Ctrl+B | 0x02 | readline 左移 / 分页程序翻页 | 是 | less/vim 内有效 |
| Ctrl+C | 0x03 | SIGINT | 是 | 材料 D 确认当前已可用，无需改动 |
| Ctrl+D | 0x04 | EOF | 是 | 空行上发送 = 登出；无 readline 的裸 shell（如 `sh`）下为删除光标字符 |
| Ctrl+E | 0x05 | readline 行尾 | 是 | — |
| Ctrl+F | 0x06 | readline 右移 / 分页翻页 | 是 | 注意与浏览器"查找"的 Ctrl+F 区分（见第 2 章浏览器限制） |
| Ctrl+G | 0x07 | BEL / 取消当前行 | 是 | — |
| Ctrl+H | 0x08 | BS | 是 | Backspace 键发 0x08 还是 0x7F 可配（Xshell 材料 B 同） |
| Ctrl+I | 0x09 | TAB | 是 | 补全由 shell/readline 完成，非终端职责 |
| Ctrl+J | 0x0A | LF | 是 | — |
| Ctrl+K | 0x0B | 删至行尾 | 是 | shell 本地行为 |
| Ctrl+L | 0x0C | 清屏重绘 | 是 | **通常是 shell/readline 本地行为**，不由终端模拟器实现；期望"清 scrollback"需本地快捷键（见第 2 章 Ctrl+Shift+L） |
| Ctrl+M | 0x0D | CR | 是 | 回车主路径 |
| Ctrl+N | 0x0E | 下一条历史 / 分页翻页 | 是 | 浏览器保留 Ctrl+N（新窗口），capture 阶段也拿不到，见第 2 章 |
| Ctrl+O | 0x0F | 执行并取出下一条（readline） | 是 | — |
| Ctrl+P | 0x10 | 上一条历史 | 是 | keydown 可 preventDefault，但与浏览器"打印"撞车，不建议占用 |
| Ctrl+Q | 0x11 | XON（流控恢复） | 是 | **已知坑**：若 PTY 开 IXON，0x11 被 line discipline 吞掉，程序收不到 |
| Ctrl+R | 0x12 | 反向历史搜索 | 是 | shell 本地行为 |
| Ctrl+S | 0x13 | XOFF（流控暂停） | 是 | **已知坑**：IXON 开启时终端输出冻结、用户以为卡死；程序永远收不到 0x13 |
| Ctrl+T | 0x14 | 交换字符（readline） | 是 | — |
| Ctrl+U | 0x15 | 删整行 | 是 | shell 本地行为 |
| Ctrl+V | 0x16 | 字面量下一字符 | 是 | 浏览器粘贴事件与粘贴板 API 另走一路，互不影响 |
| Ctrl+W | 0x17 | 删一个词 | 是 | shell 本地行为 |
| Ctrl+X | 0x18 | readline 前缀扩展 | 是 | 与 ZMODEM 握手起始字节 0x18 撞车，见第 5 章 |
| Ctrl+Y | 0x19 | 粘贴 kill ring | 是 | — |
| Ctrl+Z | 0x1A | SIGTSTP（挂起） | 是 | 挂起的是远端作业，不是浏览器标签；预期管理写进文档 |
| Ctrl+[ | 0x1B | ESC | 是 | 触发 readline meta 前缀 |
| Ctrl+\ | 0x1C | SIGQUIT | 是 | core dump 语义，少见 |
| Ctrl+] | 0x1D | — | 是 | — |
| Ctrl+^ | 0x1E | — | 是 | — |
| Ctrl+_ | 0x1F | undo（readline） | 是 | — |
| Ctrl+?（即 Backspace 键位） | 0x7F | DEL | 是 | 发 0x7F 还是 0x08 取决于 Xshell 设置与 xterm 默认，保持 xterm 默认即可 |

**IXON 坑的处理（设计建议）**：`src/transport.js` 用 ssh2 开 shell 时，pty termios 默认常带 IXON。两条候选：a) 登录后由终端自动注入 `stty -ixon`（一行字节，复用现有 `/input` 路径）；b) ssh2 pty 请求传 terminal modes 关闭 IXON（以所用 ssh2 版本 API 为准，需勘察 `transport.js` 现状后定）。

---

## 2. Xshell 自定义快捷键 → dsh-ssh 落地清单

落地载体（设计建议）：新建 `src/client/keymap.js`，在 `getRuntime()` 里 `term.attachCustomKeyEventHandler(handler)` 统一分发；handler 返回 `false` 阻止 xterm 继续处理该组合键。客户端本地动作（清屏/复制/字体）直接改 runtime，需要服务端的动作走 `actions`。

| 快捷键（材料 A） | Xshell 行为 | dsh-ssh 落地方式 | 要改的文件 | 浏览器限制 |
|---|---|---|---|---|
| Ctrl+Insert | Copy | `navigator.clipboard.writeText(term.getSelection())`；失败降级 `document.execCommand('copy')` + 临时 textarea | `src/client/keymap.js`（新）、`src/client/store.js`（挂 handler） | 剪贴板 API 要求用户手势 + secure context（https 或 localhost）；无 selection 时静默。`execCommand` 已废弃但仍是唯一同步降级 |
| Pause / Ctrl+Pause | Send Break | 设计建议：先降级为发送 `\x03`（SIGINT 语义最接近），真 break 需扩展 `/input` 支持 mode 或 ssh2 channel break 请求，见第 6 章前的说明 | `src/client/keymap.js`、`src/routes.js`（若做真 break） | **Pause 键多数键盘/浏览器不产生 keydown**，必须给替代键（建议 Ctrl+Shift+K），设置界面注明 |
| Ctrl+Shift+L | Clear Screen | `term.clear()` | `src/client/keymap.js` | 无限制 |
| Ctrl+Shift+B | Clear Scrollback | `term.clear()` 后本地 `term.write('\x1b[3J')`（CSI 3 J 清 scrollback，xterm parser 支持） | `src/client/keymap.js` | 无限制；`clear()` 是否含 scrollback 以所用 xterm 版本为准，双保险写法最稳 |
| Ctrl+Shift+A | Clear Screen + Scrollback | 上两条组合 | `src/client/keymap.js` | 无限制 |
| Ctrl+Shift+R | Reconnect | 设计建议：`actions.closeSession(sid)` 后 `actions.openSession(hostId)` 复用现有端点；要保留 sid 与滚动缓冲则新增 `POST /reconnect`（服务端重开 pty 同 sid） | `src/client/store.js`（客户端路径）；`src/routes.js` + `src/sessions.js`（若做同 sid 重连） | 无限制。注意关闭 runtime 会丢 scrollback（材料 D：runtimes keyed by sid，重建即新 sid） |
| Ctrl+Shift+Alt+[ / ] | 缩小/放大字体 | `rt.term.options.fontSize = Math.max(8, Math.min(24, cur ± 1))` 后 `rt.fit.fit()`；基准值即现状 `fontSize: 13`（材料 D） | `src/client/store.js`（新增 action）、`src/client/keymap.js` | 无限制。Ctrl+Shift+Alt+ 组合在部分 Linux 窗口管理器可能被吃掉，提供 Ctrl+= / Ctrl+- 兜底 |
| Ctrl+Tab / Ctrl+Shift+Tab | 切会话标签 | 设计建议：**降级**为 Ctrl+PageUp / Ctrl+PageDown；再提供 Alt+1..9 直达第 N 个标签 | `src/client/keymap.js`、`src/client/Tabs.jsx`、`src/client/store.js`（新增 switchTab action） | **浏览器占用，不可可靠捕获**（Chrome/Firefox 均在更早阶段消费）；即使 preventDefault 成功也不跨浏览器一致，不要承诺 Ctrl+Tab |
| Ctrl+Shift+T | Session Tab（开/显隐标签栏） | 设计建议：映射为 `actions.openNewTab()`（已存在）或标签栏显隐开关 | `src/client/keymap.js`、`src/client/store.js` | 无限制（浏览器保留裸 Ctrl+T，加 Shift 后多数浏览器不再拦截，需实测） |
| Ctrl+F1~F12 | Quick Command #01~#12 | 设计建议：每主机（或全局）配 12 条命令串，触发时 `actions.postInput(sid, encode(cmd + '\n'))`；存储见第 3 章 keymap 设计 | `src/client/keymap.js`、`src/schema.js`（主机记录加 quickCommands 字段）、`src/client/HostForm.jsx`（配置 UI） | F1~F12 的 keydown 多数浏览器可捕获，但 F5（刷新）、F11（全屏）、F12（开发者工具）需 preventDefault 且行为跨浏览器不一，Quick Command 建议避开这三个 |
| Ctrl+Shift+F4 | 关闭标签 | `actions.closeSession(sid)`（已存在） | `src/client/keymap.js` | 无限制 |
| Ctrl+Alt+N / Ctrl+Alt+T | 新窗口 / 新终端 | 设计建议：dsh-ssh 是单页插件，无窗口概念；Ctrl+Alt+T 映射为 `openNewTab()`，Ctrl+Alt+N 不落地 | `src/client/keymap.js` | Ctrl+Alt+T 在部分桌面环境是系统终端快捷键，浏览器收不到 |

---

## 3. 功能键映射（.tkm 机制）

### 3.1 普通模式 vs 应用模式（DECCKM）默认序列

| 键 | xterm.js 普通模式 | xterm.js 应用模式（DECCKM） | 材料 C（example.tkm）对照 |
|---|---|---|---|
| F1 | `\eOP` | `\eOP` | `^[OP` ✔ |
| F2 | `\eOQ` | `\eOQ` | `^[OQ` ✔ |
| F3 | `\eOR` | `\eOR` | `^[OR` ✔ |
| F4 | `\eOS` | `\eOS` | `^[OS` ✔ |
| F5 | `\e[15~` | 同 | `^[Ot` ✘（旧式 xterm/SS3 单字符序列） |
| F6 | `\e[17~` | 同 | `^[Ou` ✘ |
| F7 | `\e[18~` | 同 | `^[Ov` ✘ |
| F8 | `\e[19~` | 同 | `^[Ol` ✘ |
| F9 | `\e[20~` | 同 | `^[Ow` ✘ |
| F10 | `\e[21~` | 同 | `^[Oy` ✘ |
| F11 | `\e[23~` | 同 | 字面量 `F11`（占位，✘） |
| F12 | `\e[24~` | 同 | 字面量 `F12`（占位，✘） |

结论（设计建议）：**.tkm 不能直接当 xterm 默认表用**——F1~F4 一致，F5~F12 是旧式序列，F11/F12 是占位。导入 .tkm 时必须逐条覆写，而不是"缺省用默认、命中用 tkm"。

### 3.2 可配置 keymap 设计（设计建议）

- **粒度**：对齐 .tkm 的 `[FUNCKEY]` 段——一张 `键名 → 字节序列` 映射表（`^[` 记法转 0x1B），外加 Shift/Ctrl/Alt 修饰变体；不追求 Xshell 全量 INI 语义。
- **存哪**：主机级字段 `keymap`（`src/schema.js` 白名单 + HostForm 编辑）+ 全局默认走插件 config；秘密不涉密，无需 vault。
- **热更新**：keymap 改动后广播一次 `state` 补丁，`keymap.js` 的 handler 每次事件读最新表（闭包读 store，不缓存），无需重建 runtime。
- **导入导出**：提供 `[FUNCKEY]` 段级 .tkm 导入导出（解析 `F1=^[OP` 记法），其余段忽略并提示。
- **F13~F20**：浏览器不产生这些键的 keydown（材料 B 列到 F20 纯属桌面端能力），keymap 里保留字段但不承诺可用。

---

## 4. 终端模式与类型

| VT 开关（材料 B） | Xshell 语义 | xterm 对应 | dsh-ssh 落地 |
|---|---|---|---|
| DECAWM | 自动折行 | xterm 固定开启，无开关 | 不落地；`convertEol: false`（现状，材料 D）只管 CR/LF 转换，与 DECAWM 无关 |
| DECOM | 原点模式 | parser 原生支持 | 不落地（服务端程序自己发序列） |
| DECSCNM | 反显 | parser 原生支持 | 不落地 |
| Margin | 边距 | 无对应 API | 不落地 |
| Spacing | 行距 | `lineHeight` 近似（现状 1.2，材料 D） | 可作为高级设置暴露，收益低 |

**TERM 环境变量**：设计建议——ssh2 开 shell 时 term 固定 `xterm-256color`（现状值需勘察 `src/transport.js`/`src/sessions.js` 后确认，材料 D 未记录）。选 256color 而非 `xterm`：vim/tmux 依赖 256 色，代价仅是 TERM 字符串。

**终端类型列表对 ssh2 PTY 的映射**（材料 B 八种，设计建议：仅做"发送给 ssh2 的 term 字符串"选择，xterm.js 渲染侧不受影响）：

| Xshell 选项 | ssh2 pty term 串 |
|---|---|
| VT100 / VT102 | `vt100` / `vt102` |
| VT220 / VT320 | `vt220` / `vt320` |
| ANSI | `ansi` |
| SCOANSI | `scoansi` |
| LINUX | `linux` |
| XTERM | `xterm`（推荐改 `xterm-256color`） |

---

## 5. 文件传输

### 5.1 ZMODEM 自动激活完整链路（设计建议）

1. 服务端依赖：远端主机安装 lrzsz（`rz`/`sz`），无此依赖整条链路免谈——设置 UI 里给检测提示（`which sz`）。
2. 握手探测：用户执行 `sz file` 后，PTY 输出出现 `\x18**\x18B00...` 帧；`src/sessions.js` 缓冲 → `src/routes.js` `formatSseFrame`（`data:{"seq":N,"chunk":base64}`，材料 D）承载二进制（base64 本身无损，SSE 文本安全）。
3. 客户端解码：`base64ToBytes`（`store.js` 已有）后喂 zmodem.js 解析器；握手命中即弹"接收文件"确认（Xshell 的 "Activate ZMODEM Automatically"，材料 B）。
4. 落盘：浏览器 `Blob` + `<a download>`，文件名做 sanitize（禁路径穿越，对齐 routes.js 已有的 `path-outside-root` 错误码思路）。
5. 上传：`<input type=file>` → zmodem.js 编码 → 分片走 `POST /input`。**注意 `routes.js` 的 `MAX_BODY_BYTES = 1MB`**，分片须小于该值。
6. filexfer.dat：Xshell 用该文件持久化传输目录与选项（材料 B）。dsh-ssh 的对应约束（设计建议）：接收目录固定为浏览器下载目录，不做服务端任意路径写入；上传文件名同样 sanitize。

### 5.2 SFTP 侧栏最小设计（设计建议）

- 复用 `src/transport.js` 现有 ssh2 连接的 `sftp` 子系统，不新建连接（凭据已在 vault 信封加密中，材料 D）。
- 端点（新增，遵循 routes.js 现有注册形态）：`GET /sftp/list?sid=&path=`、`GET /sftp/get?sid=&path=`（base64 分片）、`POST /sftp/put?sid=&path=`（base64 分片，同样受 1MB 限制）。
- 前端：右栏（现有 ChatPane.jsx 同侧或新面板）文件树 + 下载/上传按钮；下载复用 5.1 的 Blob 链路。

---

## 6. 隧道能力

| 能力（材料 B） | ssh2 客户端库对应 | dsh-ssh 暴露面建议 |
|---|---|---|
| TCP/IP 端口转发（本地/远程） | `client.forwardOut(...)`（本地转发出站）；远程转发用 `forwardIn` | 每主机高级设置：转发规则列表（`src/schema.js` 加 `forwards` 字段，HostForm.jsx 加编辑 UI），会话打开时由 `src/transport.js` 建立 |
| X11 转发 | ssh2 有 X11 通道支持但浏览器侧无 X server，xterm.js 渲染不了 X 应用 | **不落地**；在高级设置里显式标注"浏览器环境不支持" |
| SOCKS4/5 动态端口转发 | ssh2 库不内置 SOCKS server，需自写或引三方库 | P2 以后；若要落地，独立成 `src/socks.js`，仅绑 127.0.0.1，绝不暴露到宿主 webServer 路由 |
| Instant Tunneling（即时隧道） | 语义：随会话即时建立、随会话断开自动回收的临时隧道 | 对应"转发规则绑定 sid 生命周期"：`sessions.js` 关会话时 teardown 全部该会话隧道 |

**与现有凭据加密的衔接**（材料 D）：隧道不引入新凭据面——复用 Host 记录的 vault 信封加密凭据开 SSH 连接；SOCKS/转发本身无认证，唯一风险是端口暴露面，默认只绑 127.0.0.1。

---

## 7. 落地优先级 Backlog

P0 判定标准：不依赖新端点/新依赖、纯客户端 xterm API、崩溃修复后可立即交付。预估改动量 S ≈ ≤50 行、M ≈ 50~200 行、L ≈ >200 行。

| ID | 优先级 | 条目 | 涉及文件 | 改动量 |
|---|---|---|---|---|
| T-01 | P0 | 清屏三件套（Ctrl+Shift+L / B / A） | `src/client/keymap.js`(新)、`src/client/store.js` | S |
| T-02 | P0 | Ctrl+Shift+R 重连（close+open 客户端路径） | `src/client/keymap.js`、`src/client/store.js` | S |
| T-03 | P0 | 字体缩放（Ctrl+Shift+Alt+[ ]，含 fit 重算） | `src/client/keymap.js`、`src/client/store.js` | S |
| T-04 | P0 | Ctrl+Insert 复制（clipboard API + execCommand 降级） | `src/client/keymap.js` | S |
| T-05 | P0 | Send Break 替代键（Ctrl+Shift+K → `\x03`） | `src/client/keymap.js` | S |
| T-06 | P1 | 标签切换降级（Ctrl+PageUp/Down + Alt+数字） | `src/client/keymap.js`、`src/client/Tabs.jsx`、`src/client/store.js` | S |
| T-07 | P1 | Quick Command 框架（12 条可配置命令） | `src/client/keymap.js`、`src/schema.js`、`src/client/HostForm.jsx` | M |
| T-08 | P1 | 功能键 keymap 覆写 + .tkm `[FUNCKEY]` 导入导出 | `src/client/keymap.js`、`src/schema.js`、`src/client/HostForm.jsx` | M |
| T-09 | P1 | 同 sid 重连（`POST /reconnect`，保留滚动缓冲） | `src/routes.js`、`src/sessions.js`、`src/client/store.js` | M |
| T-10 | P1 | 开 shell 时 term 固定 `xterm-256color` + `stty -ixon` 注入 | `src/transport.js`、`src/sessions.js` | S |
| T-11 | P2 | 终端类型选择（八种 term 串映射，主机级） | `src/schema.js`、`src/client/HostForm.jsx`、`src/transport.js` | M |
| T-12 | P2 | ZMODEM 上传/下载全链路 | 新 `src/client/zmodem.js`、`src/client/store.js`、`src/sessions.js` | L |
| T-13 | P2 | SFTP 侧栏 | `src/routes.js`、`src/transport.js`、新 `src/client/SftpPane.jsx` | L |
| T-14 | P2 | 端口转发 / 即时隧道（每主机高级设置） | `src/schema.js`、`src/transport.js`、`src/sessions.js`、`src/client/HostForm.jsx` | L |

---

## 自查说明

- 所有"dsh-ssh 现状"表述均来自材料 D 并经源码核对：Terminal.jsx 仅 DOM 搬家保活、无自定义按键；store.js `wireRuntime` 三事件 + 模块级 runtimes 表；routes.js 九端点与 SSE 帧格式；字体 13px / scrollback 5000 / convertEol:false。
- 材料 D 未覆盖而本稿需要的事实（transport.js 当前 term 串、ssh2 pty modes 支持度）已标注"需勘察"或"设计建议"，未做断言。
