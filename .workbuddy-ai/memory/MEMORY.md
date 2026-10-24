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

## 对话助手（llm 服务）要点
- 调模型：`ctx.get('llm')` → `listProviders()/listModels(p)/prepareCall({provider,model}).stream({provider,model,messages,system,tools,signal})`；stream 只能分发一次，每轮重新 prepareCall；options 的 provider/model 必须与 config 一致（callConfigEquals）。
- 消息块运行时形状：text `{type:'text',text}`；assistant 工具调用 `{type:'tool-call',id,name,arguments}`；工具结果 `{role:'tool',toolCallId,content,isError}`；**assistant 必须带 `source:{kind:'model',provider,model}`**（runtime forAdapter 读 source.replayState）。
- system 角色由 Host 每轮重建，客户端 history 里的 system 要丢弃。
- marker 捕获输出：正则别要求行首是 \n（真终端是 \r）；超时发 \x03。
- 用户机器的模型来源：profile 里装了 dsh-our-free-model（provider 路由 our-free-model / our-free-model-region，GLM 5.3 等免费模型）；patch 里 agent-default-model 是 zcode/GLM-5.3。
- E2E：`E2E_PASSWORD=*** node scripts/chat-e2e.mjs`（真 ssh + 真 llm 包 + 假 adapter，12 断言）。
