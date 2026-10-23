/**
 * 中栏：xterm 终端 + 保活挂载（设计 §2.5）。
 *
 * 这个组件本身"随便卸载"——它只做一件事：把模块级运行时的 DOM wrapper
 * 搬进自己的容器，卸载时再搬出来。xterm 实例、SSE 订阅、滚动缓冲全在
 * store.js 的 runtimes 表里活着，与本组件无关。
 *
 * 四个边界（设计 §2.5）对应四行关键代码：
 * 1. 尺寸归零   —— ResizeObserver 回调里 `wrap.isConnected` 守卫；
 * 2. 渲染器白屏 —— 重挂载后 `term.refresh(0, rows-1)`；
 * 3. 焦点丢失   —— 记 `hadFocus`，回来时 `focus()`；
 * 4. 内存上限   —— store 的 LRU 淘汰（MAX_RUNTIMES）。
 */
import React, { useLayoutEffect, useRef } from 'react';
// xterm 的 CSS 在构建时被 esbuild 读成字符串（--loader:.css=text），这里
// 运行时注入一次 <style>；不引 CDN，离线可用。
import xtermCss from '@xterm/xterm/css/xterm.css';
import { getRuntime } from './store.js';

/** 保证 xterm 样式只注入一次。 */
if (typeof document !== 'undefined' && document.getElementById('dsh-ssh-xterm-css') === null) {
  const style = document.createElement('style');
  style.id = 'dsh-ssh-xterm-css';
  style.textContent = xtermCss;
  document.head.appendChild(style);
}

/**
 * 终端视图。
 * @param {{sid: string}} props 会话 id。
 * @returns {JSX.Element} 一个撑满容器的空 div（xterm 的 wrapper 会搬进来）。
 */
export function Terminal({ sid }) {
  const box = useRef(null);

  useLayoutEffect(() => {
    const container = box.current;
    if (container === null) return;
    const rt = getRuntime(sid);

    // 挂载：DOM 搬家，不是重建。
    container.appendChild(rt.wrap);
    const observer = new ResizeObserver(() => {
      // 守卫：卸载后容器 0x0，此时 fit 会算出 0 列把终端搞坏。
      if (rt.wrap.isConnected) rt.fit.fit();
    });
    observer.observe(container);

    const raf = requestAnimationFrame(() => {
      rt.fit.fit();
      // canvas/webgl 渲染器在 DOM 搬家后必须主动刷，否则白屏。
      rt.term.refresh(0, rt.term.rows - 1);
    });

    if (rt.hadFocus) rt.term.focus();

    return () => {
      cancelAnimationFrame(raf);
      // 先 disconnect 再摘 DOM：避免观察者在 wrapper 离文档后触发 fit。
      observer.disconnect();
      rt.hadFocus = document.activeElement === rt.term.textarea;
      rt.wrap.remove();
    };
  }, [sid]);

  return <div ref={box} style={{ width: '100%', height: '100%', minHeight: 0 }} />;
}
