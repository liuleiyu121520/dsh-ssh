/**
 * 图标：小控件图标全部 24x24、currentColor；只有应用图标 SshIcon 例外。
 *
 * 应用图标必须自带颜色（蓝底白提示符），与包内 icon.svg 同一构图：宿主把
 * 插件图标当 <img> 塞进 40/48px 的框里，纯 currentColor 的线框在深色主题下
 * 只剩一圈灰线，和系统自带插件（蓝白渐变）摆在一起明显不统一
 * （2026-10-24 用户截图）。三栏骨架里的小控件图标继续走 currentColor。
 */
import React from 'react';

/**
 * SSH 应用图标：蓝色渐变方块 + 白色提示符（与 icon.svg 同一构图）。
 * @param {{size?: number}} props 尺寸（默认 24）。
 * @returns {JSX.Element} SVG 元素。
 */
export function SshIcon({ size = 24, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-hidden="true" {...rest}>
      <rect x="4" y="6" width="28" height="24" rx="7" fill="url(#dsh-ssh-tile)" />
      <path d="M11.5 13.2 17 18 11.5 22.8" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19.2 22.8H24.8" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
      <defs>
        <linearGradient id="dsh-ssh-tile" x1="6" y1="7" x2="30" y2="29" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6FB2EE" />
          <stop offset="1" stopColor="#3E58D6" />
        </linearGradient>
      </defs>
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

/**
 * 下箭头（输入框里的胶囊下拉：模型 / 授权）。
 * @param {{size?: number}} props 尺寸。
 * @returns {JSX.Element} SVG 元素。
 */
export function ChevronDownIcon({ size = 16, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
      <path d="M6 9.5l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
