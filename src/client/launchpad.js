/**
 * 启动台适配层——本插件与 dsh-launchpad 的唯一耦合点（设计 §1）。
 *
 * 只依赖协议 §2 承诺的三件事：
 * 1. `register()` 返回幂等 dispose，必须交给 `ctx.effect`；
 * 2. 容器给 width:100%、高度撑满、overflow:auto、padding 0、继承 --dsw-alias-*；
 * 3. view 的 props 只有 {appId, app, back, open, active, t}，拿不到 ctx——
 *    所以数据一律走我们自己的模块级 store（store.js）。
 *
 * 启动台改协议时只改这一个文件；SshAppView 本身与启动台无关。
 */
import { SshAppView } from './App.jsx';
import { SshIcon } from './icons.js';
import { messages, t } from './locales.js';

export const inject = ['launchpad'];

/**
 * 注册 SSH 应用卡片。
 *
 * `keepAlive: true` 是 v1.1 草案字段：老启动台忽略它（不报错），视图该被
 * 卸载还是被卸载——所以保活的正确性前提是 store.js 的三层保活，这个字段
 * 只是"少卸载一半"的优化开关（设计 §2.5）。
 * @param {object} ctx 客户端 cordis 上下文（已注入 launchpad）。
 * @returns {void}
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.launchpad.register({
        id: 'ssh',
        title: 'SSH',
        subtitle: t('subtitle'),
        keywords: ['ssh', 'terminal', '远程', '终端', 'shell'],
        icon: SshIcon,
        keepAlive: true,
        open: { view: SshAppView },
      }),
    'dsh-ssh: launchpad registration',
  );

  // 协议 §5：公共文案用启动台命名空间的 t()，插件自己的文案走
  // ctx.locale.register。M0 组件里先硬编码中文（locales.js 已备好中英两份），
  // M1 换命名空间 t() 时这段注册直接生效——调用位先留好。
  //
  // 注意必须走 ctx.get('locale') 而不是 ctx.locale：cordis 4.x 里访问未在
  // inject 声明中列出的服务属性会**抛异常**（"cannot get property "locale"
  // without inject"），不会返回 undefined；而 ctx.get 是非抛异常访问器，
  // 服务缺失时返回 undefined——下面这个"优雅降级"判断才真正成立。
  // 也不能把 'locale' 加进 inject：宿主没有 locale 服务时 fiber 会永远
  // pending，同样激活失败（2026-10-24 桌面端启动崩溃即此根因）。
  const locale = ctx.get('locale');
  if (locale !== undefined && typeof locale.register === 'function') {
    ctx.effect(() => locale.register('dsh-ssh', messages), 'dsh-ssh: locale registration');
  }
}
