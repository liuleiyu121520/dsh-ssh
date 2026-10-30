/**
 * 左栏：主机列表 + 行内操作（M1：CRUD 入口）。
 *
 * 数据全部来自 `GET /api/dsh-ssh/hosts`（经 store），没有自己的请求逻辑：
 * - 「+ 标签」→ `onOpenTab(hostId)` → store.openSession（POST /open）；
 * - 「编辑」→ `onEdit(host)` → store.openForm('edit', host)；
 * - 「删除」→ 行内二次确认 → `onDelete(host)` → store.deleteHost，后者保证
 *   先 `POST /close` 关掉该主机的全部会话、再 `DELETE /hosts/<id>`。
 *
 * 行内操作不占常驻宽度（2026-10-30 用户要求）：默认整行文字铺到最右，
 * 只有 hover/二次确认时才在右侧让出操作区。做法是操作区绝对定位悬浮在行
 * 右端（不参与布局），同时给主标题区加 padding-right 过渡——默认宽度全给
 * 文字，"120.53.14.173:22 · 已断开" 这类副标题不再被提前截断。
 */
import React, { useState } from 'react';
import { PlusIcon } from './icons.js';
import { t } from './locales.js';

/** 状态 -> 状态灯颜色。只用 --dsw-alias-* 变量，不判断明暗。 */
const LIGHT_COLORS = {
  // 已连接用系统状态绿（与 dsh 其它"在线"指示一致），品牌蓝留给可点操作。
  open: 'var(--dsw-alias-state-success-primary)',
  connecting: 'var(--dsw-alias-label-tertiary)',
  closed: 'var(--dsw-alias-label-tertiary)',
  error: 'var(--dsw-alias-label-error)',
  offline: 'var(--dsw-alias-label-quaternary)',
};

/** 状态 -> 状态文案 key。 */
const STATUS_KEYS = {
  open: 'statusOpen',
  connecting: 'statusConnecting',
  closed: 'statusClosed',
  error: 'statusError',
  offline: 'statusOffline',
};

/**
 * 铅笔图标（编辑）。
 * @param {{size?: number}} props 尺寸。
 * @returns {JSX.Element} SVG 元素。
 */
function PencilIcon({ size = 12, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
      <path
        d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * 垃圾桶图标（删除）。
 * @param {{size?: number}} props 尺寸。
 * @returns {JSX.Element} SVG 元素。
 */
function TrashIcon({ size = 12, ...rest }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
      <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 行内小按钮的样式（图标按钮）。 */
const actionButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '20px',
  height: '20px',
  padding: 0,
  border: 0,
  borderRadius: '5px',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-tertiary)',
  background: 'transparent',
};

/**
 * hover 时右侧要让出的宽度（px）：3 个 20px 图标 + 2 个 1px 间隙 + 6px 右边距。
 *
 * 与操作区的实际占位保持同一个数——两边不一致时，要么文字被按钮压住，
 * 要么让出来的空白比按钮还宽，副标题会白丢一段可显示宽度。
 */
const ACTION_SLOT = 70;

/**
 * 一行主机（含 hover 操作与删除二次确认）。
 *
 * 交互（2026-10-24 用户要求）：单击只选中高亮（已有会话则聚焦其标签），
 * **双击才发起连接**——避免进应用就顺手连上。行内 `+` 是"再开一个标签"，
 * 与双击不同：双击有活会话就聚焦，`+` 总是新建（一主机多会话）。
 * @param {{host: object, active: boolean, selected: boolean, gap: object|null, onSelect: (host: object) => void, onOpenTab: (hostId: string) => void, onNewTab: (hostId: string) => void, onEdit: (host: object) => void, onDelete: (host: object) => void}} props 行数据。
 * @returns {JSX.Element} 主机行。
 */
function HostRow({ host, active, selected = false, gap, onSelect, onOpenTab, onNewTab, onEdit, onDelete }) {
  const [hover, setHover] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const color = LIGHT_COLORS[host.status] ?? LIGHT_COLORS.offline;
  const showActions = hover || confirming;
  const subtitle = `${host.host}:${host.port} · ${t(STATUS_KEYS[host.status] ?? 'statusOffline')}${
    gap !== null && gap !== undefined ? ` · ${t('replayGap')}` : ''
  }`;
  const highlight = active || selected;

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        margin: '1px 0',
        borderRadius: '8px',
        background: highlight
          ? 'var(--dsw-alias-interactive-bg-active)'
          : hover
            ? 'var(--dsw-alias-bg-layer-3)'
            : 'transparent',
      }}
    >
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => onSelect(host)}
          onDoubleClick={() => onOpenTab(host.id)}
          title={`${host.username === '' ? '(no user)' : host.username}@${host.host}:${host.port}（双击连接）`}
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            paddingTop: '8px',
            paddingBottom: '8px',
            paddingLeft: '10px',
            // 默认只留 4px：整行宽度都给文字，副标题能完整显示。
            // hover 时让出 ACTION_SLOT 给右侧操作区，过渡避免文字硬跳。
            paddingRight: showActions ? `${ACTION_SLOT}px` : '4px',
            transition: 'padding-right 120ms ease',
            border: 0,
            borderRadius: '8px',
            cursor: 'pointer',
            textAlign: 'left',
            font: 'inherit',
            color: 'var(--dsw-alias-label-primary)',
            background: 'transparent',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: '8px',
              height: '8px',
              flex: '0 0 auto',
              borderRadius: '50%',
              background: color,
            }}
          />
          <span style={{ flex: '1 1 auto', minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: '13px', lineHeight: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {host.label}
            </span>
            <span style={{ display: 'block', fontSize: '11px', lineHeight: '15px', color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {subtitle}
            </span>
          </span>
        </button>
        <div
          style={{
            // 绝对定位：不占布局宽度，默认状态下文字能一直铺到行右端。
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            gap: '1px',
            paddingRight: '6px',
            opacity: showActions ? 1 : 0,
            pointerEvents: showActions ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
          }}
        >
          <button
            type="button"
            title={t('hostOpenTab')}
            aria-label={t('hostOpenTab')}
            onClick={() => onNewTab(host.id)}
            style={actionButtonStyle}
          >
            <PlusIcon size={12} />
          </button>
          <button
            type="button"
            title={t('hostEdit')}
            aria-label={t('hostEdit')}
            onClick={() => onEdit(host)}
            style={actionButtonStyle}
          >
            <PencilIcon size={12} />
          </button>
          <button
            type="button"
            title={t('hostDelete')}
            aria-label={t('hostDelete')}
            onClick={() => setConfirming(true)}
            style={{ ...actionButtonStyle, color: 'var(--dsw-alias-label-error)' }}
          >
            <TrashIcon size={12} />
          </button>
        </div>
      </div>

      {confirming ? (
        <div
          style={{
            padding: '0 10px 8px',
            fontSize: '11px',
            lineHeight: '16px',
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          <div style={{ color: 'var(--dsw-alias-label-error)' }}>{t('deleteHostConfirm')}</div>
          <div style={{ color: 'var(--dsw-alias-label-quaternary)', marginBottom: '6px' }}>{t('deleteHostDetail')}</div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                onDelete(host);
              }}
              style={{
                padding: '3px 8px',
                border: 0,
                borderRadius: '5px',
                cursor: 'pointer',
                font: 'inherit',
                fontSize: '11px',
                color: 'var(--dsw-alias-bg-base)',
                background: 'var(--dsw-alias-label-error)',
              }}
            >
              {t('confirmDelete')}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              style={{
                padding: '3px 8px',
                border: '0.5px solid var(--dsw-alias-border-l2)',
                borderRadius: '5px',
                cursor: 'pointer',
                font: 'inherit',
                fontSize: '11px',
                color: 'var(--dsw-alias-label-secondary)',
                background: 'transparent',
              }}
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 左栏组件。
 * @param {{hosts: object[], activeSid: string|null, gaps?: object, onSelect: (host: object) => void, onAdd: () => void, onOpenTab: (hostId: string) => void, onEdit: (host: object) => void, onDelete: (host: object) => void}} props 组件参数。
 * @returns {JSX.Element} 左栏。
 */
export function Hosts({ hosts, activeSid, gaps = {}, selectedHostId = null, onSelect, onAdd, onOpenTab, onNewTab, onEdit, onDelete, onCollapse }) {
  return (
    <aside
      style={{
        width: '220px',
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderRight: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', paddingLeft: '14px', paddingRight: '8px', paddingTop: '12px', paddingBottom: '8px' }}>
        <span
          style={{
            flex: '1 1 auto',
            fontSize: '12px',
            fontWeight: 600,
            letterSpacing: '0.04em',
            color: 'var(--dsw-alias-label-tertiary)',
          }}
        >
          {t('hosts')}
        </span>
        {onCollapse !== undefined ? (
          <button
            type="button"
            onClick={onCollapse}
            title={t('hostsCollapse')}
            aria-label={t('hostsCollapse')}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '22px',
              height: '22px',
              padding: 0,
              border: 0,
              borderRadius: '5px',
              cursor: 'pointer',
              color: 'var(--dsw-alias-label-quaternary)',
              background: 'transparent',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : null}
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '0 6px' }}>
        {hosts.length === 0 ? (
          <div style={{ padding: '8px 10px', fontSize: '12px', color: 'var(--dsw-alias-label-quaternary)' }}>{t('loading')}</div>
        ) : (
          hosts.map((host) => (
            <HostRow
              key={host.id}
              host={host}
              active={host.sid !== null && host.sid === activeSid}
              selected={host.id === selectedHostId}
              gap={host.sid === null ? null : (gaps[host.sid] ?? null)}
              onSelect={onSelect}
              onOpenTab={onOpenTab}
              onNewTab={onNewTab}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
      <div style={{ padding: '8px' }}>
        <button
          type="button"
          onClick={onAdd}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            width: '100%',
            padding: '7px 0',
            border: '0.5px solid var(--dsw-alias-border-l2)',
            borderRadius: '8px',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '12px',
            color: 'var(--dsw-alias-label-secondary)',
            background: 'var(--dsw-alias-bg-layer-2)',
          }}
        >
          <PlusIcon size={14} />
          {t('addHost')}
        </button>
      </div>
    </aside>
  );
}

/**
 * 左栏收起后的展开条（与右栏 ChatToggle 同款交互）。
 * @returns {JSX.Element} 窄条。
 */
export function HostsToggle({ onExpand }) {
  return (
    <aside
      style={{
        width: '36px',
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: '10px',
        borderRight: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
      }}
    >
      <button
        type="button"
        onClick={onExpand}
        title={t('hostsExpand')}
        aria-label={t('hostsExpand')}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '24px',
          height: '24px',
          padding: 0,
          border: 0,
          borderRadius: '5px',
          cursor: 'pointer',
          color: 'var(--dsw-alias-label-tertiary)',
          background: 'transparent',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </aside>
  );
}
