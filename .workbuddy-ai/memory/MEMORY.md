# dsh-ssh 项目长期记忆

## dsh/cordis 铁律（2026-10-24 崩溃换来的）
- cordis 4.x：访问**未在 inject 声明**的服务属性（`ctx.foo`）会**抛异常**，不是返回 undefined。防御式读取必须用 `ctx.get('foo')`。
- 可选服务**绝不**加进 inject：服务缺失会让 fiber 永远 pending，激活审计照样失败。
- 客户端激活类 bug 单测抓不到（假 ctx 替身）：用 `scripts/client-boot.repro.mjs` 做真机形态回归（真 cordis + 真 bundle + bootClient 流程复刻，退出码 0 为通过）。
- dsh 客户端插件契约：bundle = `window.__ModuleLoader__.load({id, factory(require)})`；script 执行只注册，factory 物化才跑模块体；react/react-dom 是唯一合法外链；产物 lib/client.js 由 `node scripts/build.mjs` 生成，改 src/client 后必须重建（app 加载的是 lib/）。

## 环境事实
- 真机 profile：`/Users/leiyu/.dsh/profiles/desktop/`，dsh-ssh-terminal 以 link 方式指向本仓库；崩溃日志在 `~/Library/Logs/DeepSeek Harness/crash-*.log`。
- dsh monorepo（真包来源）：`/Users/leiyu/code/pre-study/deepseek-harness`（vendor/cordis、vendor/loader、packages/client/modules 等）。
- macOS 是 BSD grep：`\|` 不是 alternation，要用 `grep -E`。
- 仓库 2026-10-24 才 `git init`，8b39f7b 是 root commit，无"修复前"历史。
