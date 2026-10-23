/**
 * 图标：全部 24x24、currentColor、无外部引用。
 *
 * 启动台卡片用 SshIcon（与包内 icon.svg 同一构图）；其余是三栏骨架里的
 * 小控件图标。用 stroke 而非 fill，跟 dsw 的线性图标语言一致。
 */
import React from 'react';

/**
 * SSH 应用图标：主机框 + 提示符。
 * @param {{size?: number}} props 尺寸（默认 24）。
 * @returns {JSX.Element} SVG 元素。
 */
export function SshIcon({ size = 24, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
      <rect x="2.5" y="3.5" width="19" height="17" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 9.5 10.5 12 7 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 15H17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 加号（左栏"添加主机"）。
 * @param {{size?: number}} props 尺寸。
 * @returns {JSX.Element} SVG 元素。
 */
export function PlusIcon({ size = 16, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 对话气泡（右栏头部）。
 * @param {{size?: number}} props 尺寸。
 * @returns {JSX.Element} SVG 元素。
 */
export function ChatIcon({ size = 16, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
      <path
        d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4.2 3.4c-.5.4-1.3 0-1.3-.7V6.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 右箭头（右栏折叠后的展开把手）。
 * @param {{size?: number}} props 尺寸。
 * @returns {JSX.Element} SVG 元素。
 */
export function ChevronLeftIcon({ size = 16, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
      <path d="M14.5 6 8.5 12l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 右箭头（右栏头部的收起按钮）。
 * @param {{size?: number}} props 尺寸。
 * @returns {JSX.Element} SVG 元素。
 */
export function ChevronRightIcon({ size = 16, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
      <path d="M9.5 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
