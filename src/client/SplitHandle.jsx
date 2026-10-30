/**
 * 分栏拖拽把手（左栏边界 / 右栏边界各一个）。
 *
 * 交互与 dsh 自己的 ui-layout 一致（`AppFrame.tsx` 的 `DragHandle`）：
 * - **pointer capture**：按下即抓住指针，鼠标飞出 8px 命中条、飞出窗口都还在拖；
 * - **rAF 节流**：pointermove 只记录最新 X，真正的宽度计算每帧最多一次；
 * - **基准冻结**：`onStart` 时把当时的宽度记进 `base`，整个手势都用
 *   `base + dx` 计算——不在每次 move 上累加，所以不会漂移、不会和
 *   React 的异步渲染打架。
 *
 * 视觉上只有一条 8px 宽的透明命中条（比 1px 分割线好抓），hover/拖拽时
 * 才浮出一条 2px 的品牌色细线做反馈——常驻的话三栏看起来全是竖线。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

/** 命中条宽度（px）：两侧各溢出边框 4px。 */
const HIT = 8;

/**
 * 分栏把手。
 * @param {object} props 参数。
 * @param {'hosts'|'chat'} props.side 拖的是哪一栏（决定用 left 还是 right 定位）。
 * @param {number} [props.left] 左边界的 x（side='hosts'）。
 * @param {number} [props.right] 距容器右边缘的距离（side='chat'）。
 * @param {() => void} props.onStart 按下：调用方在此冻结拖拽基准。
 * @param {(dx: number) => void} props.onDrag 位移量（相对按下点，px）。
 * @param {() => void} props.onEnd 抬手/取消。
 * @returns {JSX.Element} 命中条。
 */
export function SplitHandle({ side, left, right, onStart, onDrag, onEnd }) {
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const origin = useRef(0);
  const latest = useRef(0);
  const frame = useRef(null);
  const capture = useRef(null);
  // 回调放 ref：父组件每次渲染都会换新的函数引用，但拖动中途不能因此重绑。
  const callbacks = useRef({ onStart, onDrag, onEnd });
  callbacks.current = { onStart, onDrag, onEnd };

  const endDrag = useCallback(() => {
    const active = capture.current;
    if (active === null) return;
    capture.current = null;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    setDragging(false);
    callbacks.current.onEnd();
  }, []);

  // 组件卸载（收起该栏）时可能正拖着：把指针捕获和待执行的帧一起收干净。
  useEffect(() => endDrag, [endDrag]);

  const handlePointerDown = useCallback((event) => {
    if (event.button !== 0 || capture.current !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    capture.current = { element: event.currentTarget, id: event.pointerId };
    origin.current = event.clientX;
    latest.current = event.clientX;
    callbacks.current.onStart();
    setDragging(true);
  }, []);

  const handlePointerMove = useCallback((event) => {
    if (capture.current?.id !== event.pointerId) return;
    latest.current = event.clientX;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      callbacks.current.onDrag(latest.current - origin.current);
    });
  }, []);

  const handlePointerUp = useCallback((event) => {
    if (capture.current?.id !== event.pointerId) return;
    // 松手这一帧可能还有未执行的 rAF：直接补最后一次位移，别丢最后几像素。
    callbacks.current.onDrag(event.clientX - origin.current);
    endDrag();
  }, [endDrag]);

  const handlePointerCancel = useCallback((event) => {
    if (capture.current?.id === event.pointerId) endDrag();
  }, [endDrag]);

  const active = dragging || hover;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      data-side={side}
      data-dragging={dragging || undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: `${HIT}px`,
        // 定位：左边界用 left，右边界用 right（右栏贴容器右沿，用 right 定位
        // 就不依赖容器宽度测量，窗口变化时不会慢半帧）。
        ...(side === 'hosts' ? { left: `${left}px`, marginLeft: `${-HIT / 2}px` } : { right: `${right}px`, marginRight: `${-HIT / 2}px` }),
        cursor: 'col-resize',
        // 触摸设备上别让浏览器把拖拽当成滚动。
        touchAction: 'none',
        zIndex: 12,
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: '2px',
          height: '100%',
          borderRadius: '1px',
          background: 'var(--dsw-alias-brand-primary)',
          opacity: active ? (dragging ? 0.9 : 0.45) : 0,
          transition: dragging ? 'none' : 'opacity 120ms ease',
        }}
      />
    </div>
  );
}
