/**
 * xterm 测试替身：记录 open/dispose 调用，不起真实 DOM。
 *
 * store.js 只用到 Terminal 的这几个方法；FitAddon 只用到 fit()。
 */
export class Terminal {
  constructor(options) {
    this.options = options;
    this.disposed = false;
    this.refreshed = [];
    this.focused = false;
    this.rows = 24;
    this.textarea = { __textarea: true };
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
  refresh(start, end) {
    this.refreshed.push([start, end]);
  }
  focus() {
    this.focused = true;
  }
  onData(listener) {
    this.listeners.data = listener;
  }
  onResize(listener) {
    this.listeners.resize = listener;
  }
  onFocus(listener) {
    this.listeners.focus = listener;
  }
  dispose() {
    this.disposed = true;
  }
}

export default { Terminal };
