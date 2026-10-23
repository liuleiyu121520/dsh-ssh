/**
 * 客户端 bundle 入口。
 *
 * dsh 的客户端加载器（window.__ModuleLoader__）要的形态就是
 * `{ inject, apply }`；本文件只做再导出，真正的注册逻辑在 launchpad.js
 * （启动台适配层，唯一耦合点）。视图与终端经由 launchpad -> App.jsx 的
 * import 链被打进同一个 bundle。
 */
export { apply, inject } from './launchpad.js';
