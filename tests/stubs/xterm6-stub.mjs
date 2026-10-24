/**
 * xterm 6.0 公开 API 测试替身：**没有 onFocus**。
 *
 * 依据（2026-10-24 真机事故）：xterm 6.0 的公开 Terminal 类
 * （node_modules/@xterm/xterm/src/browser/public/Terminal.ts）只暴露
 * onData/onResize 等事件，onFocus 留在内部 CoreBrowserTerminal 没公开——
 * store.js 无条件调 term.onFocus() 会让每次打开会话都抛 TypeError，
 * 整个视图被启动台错误边界兜成"此应用加载失败"。本替身复刻那个形状，
 * 逼 wireRuntime 走特性检测 + textarea 兜底路径。
 */
export class Terminal {
  constructor(options) {
    this.options = options;
    this.disposed = false;
    this.rows = 24;
    /** @type {{listeners: Record<string, Function[]>, addEventListener: Function, removeEventListener: Function}} */
    this.textarea = {
      listeners: {},
      addEventListener(type, listener) {
        (this.listeners[type] ??= []).push(listener);
      },
      removeEventListener(type, listener) {
        this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== listener);
      },
    };
    this.listeners = {};
    this.openedInto = null;
  }

  loadAddon(addon) {
    this.addon = addon;
  }

  open(element) {
    this.openedInto = element;
  }

  write() {}

  refresh() {}

  focus() {}

  onData(listener) {
    this.listeners.data = listener;
  }

  onResize(listener) {
    this.listeners.resize = listener;
  }

  // 注意：**没有 onFocus**——xterm 6.0 公开 API 的真实形状。

  dispose() {
    this.disposed = true;
  }
}

export default { Terminal };
