/**
 * 中栏顶部标签条（M1：一主机多会话）。
 *
 * 纯展示组件：标签顺序来自 store 的 `tabs`（sid 数组），点击/关闭都只是
 * 把 sid 交回 App -> store actions。**关标签不等于关终端**——store 的
 * `closeSession` 只从 `tabs` 里摘 sid，xterm 实例仍留在 `runtimes` 里
 * （设计 §2.5 的 L2/L3 保活），重开同一会话会复用同一个实例，屏幕原处不动。
 *
 * 样式只用 `var(--dsw-alias-*)`：宿主切明暗主题时标签条跟着变，这里零判断。
 */
import React, { useState } from 'react';
import { t } from './locales.js';

/**
 * 关闭图标（×）。icons.js 里没有，就地定义，避免动 M0 的图标文件。
 * @param {{size?: number}} props 尺寸。
 * @returns {JSX.Element} SVG 元素。
 */
export function CloseIcon({ size = 12, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 标签显示名：优先会话里带的主机名，其次主机表的当前会话，最后退回 sid。
 *
 * 一台主机可以开多个标签，所以不能靠"主机表里哪一行指向这个 sid"来找名
 * 字——主机表只记得最新那个会话。会话对象上的 `host.label` 才是权威。
 * @param {string} sid 会话 id。
 * @param {Record<string, object>} sessions sid -> session。
 * @param {object[]} hosts 主机表。
 * @returns {string} 展示名。
 */
function tabLabel(sid, sessions, hosts) {
  const fromSession = sessions?.[sid]?.host?.label;
  if (typeof fromSession === 'string' && fromSession !== '') return fromSession;
  const fromHost = hosts.find((host) => host.sid === sid)?.label;
  if (typeof fromHost === 'string' && fromHost !== '') return fromHost;
  return sid;
}

/**
 * 单个标签。
 * @param {{sid: string, index: number, label: string, active: boolean, onSelect: (sid: string) => void, onClose: (sid: string) => void}} props 标签参数。
 * @returns {JSX.Element} 标签。
 */
function Tab({ sid, index, label, active, onSelect, onClose }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={label}
      onClick={() => onSelect(sid)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(sid);
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        maxWidth: '190px',
        padding: '5px 6px 5px 10px',
        borderTopLeftRadius: '8px',
        borderTopRightRadius: '8px',
        border: '0.5px solid',
        borderColor: active ? 'var(--dsw-alias-border-l2)' : 'transparent',
        borderBottomColor: active ? 'transparent' : 'transparent',
        cursor: 'pointer',
        userSelect: 'none',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
        background: active
          ? 'var(--dsw-alias-bg-layer-2)'
          : hover
            ? 'var(--dsw-alias-bg-layer-3)'
            : 'transparent',
      }}
    >
      <span
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '12px',
          lineHeight: '17px',
        }}
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        style={{
          flex: '0 0 auto',
          fontSize: '10px',
          lineHeight: '14px',
          color: 'var(--dsw-alias-label-quaternary)',
        }}
      >
        #{index + 1}
      </span>
      <button
        type="button"
        title={t('tabClose')}
        aria-label={t('tabClose')}
        onClick={(event) => {
          // 别让关闭冒泡成"选中"：否则点 × 会先切过去再关，闪一下。
          event.stopPropagation();
          onClose(sid);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '18px',
          height: '18px',
          padding: 0,
          border: 0,
          borderRadius: '4px',
          cursor: 'pointer',
          color: 'var(--dsw-alias-label-tertiary)',
          background: hover ? 'var(--dsw-alias-bg-layer-4)' : 'transparent',
          opacity: hover || active ? 1 : 0.55,
        }}
      >
        <CloseIcon size={10} />
      </button>
    </div>
  );
}

/**
 * 标签条。
 * @param {{tabs?: string[], sessions?: Record<string, object>, hosts?: object[], activeSid?: string|null, onSelect: (sid: string) => void, onClose: (sid: string) => void, onNew: () => void}} props 组件参数。
 * @returns {JSX.Element} 标签条。
 */
export function Tabs({ tabs = [], sessions = {}, hosts = [], activeSid = null, onSelect, onClose, onNew }) {
  return (
    <div
      role="tablist"
      aria-label={t('tabs')}
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: '2px',
        flex: '0 0 auto',
        padding: '6px 8px 0',
        minHeight: '34px',
        overflowX: 'auto',
        overflowY: 'hidden',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
      }}
    >
      {tabs.length === 0 ? (
        <span
          style={{
            padding: '0 4px 6px',
            fontSize: '12px',
            color: 'var(--dsw-alias-label-quaternary)',
          }}
        >
          {t('noSession')}
        </span>
      ) : (
        tabs.map((sid, index) => (
          <Tab
            key={sid}
            sid={sid}
            index={index}
            label={tabLabel(sid, sessions, hosts)}
            active={sid === activeSid}
            onSelect={onSelect}
            onClose={onClose}
          />
        ))
      )}
      <button
        type="button"
        title={t('tabNew')}
        aria-label={t('tabNew')}
        onClick={onNew}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '24px',
          height: '24px',
          margin: '0 0 3px 4px',
          padding: 0,
          border: 0,
          borderRadius: '6px',
          cursor: 'pointer',
          flex: '0 0 auto',
          color: 'var(--dsw-alias-label-tertiary)',
          background: 'transparent',
          fontSize: '16px',
          lineHeight: '20px',
        }}
      >
        +
      </button>
    </div>
  );
}
