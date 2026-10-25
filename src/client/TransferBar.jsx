/**
 * ZMODEM 传输浮层：rz 上传 / sz 下载的进度与交互。
 *
 * 放在终端上方（绝对定位、不占布局）——Xshell 那条传输条也是这么干的：
 * 传输是低频事件，为它常驻一块布局不值得。
 *
 * 状态来自 Host 的 SSE 控制帧（/transfer/events），与本组件无关：本组件只
 * 负责把 `state.transfers[sid]` 画出来，以及在 `need-file` 时弹出文件选择。
 */
import React, { useRef } from 'react';
import { actions } from './store.js';

/** 浮层容器：贴终端底部居中，别挡住输入焦点。 */
const barStyle = {
  position: 'absolute',
  left: '50%',
  bottom: '10px',
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  maxWidth: 'calc(100% - 24px)',
  padding: '7px 12px',
  border: '0.5px solid var(--dsw-alias-border-l3)',
  borderRadius: '8px',
  background: 'var(--dsw-alias-bg-layer-3)',
  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.3)',
  fontSize: '11px',
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-secondary)',
  zIndex: 50,
};

/** 进度条底色与填充。 */
const trackStyle = {
  width: '120px',
  height: '4px',
  borderRadius: '2px',
  background: 'var(--dsw-alias-border-l2)',
  overflow: 'hidden',
};
const fillStyle = (percent) => ({
  width: `${Math.round(percent * 100)}%`,
  height: '100%',
  background: 'var(--dsw-alias-brand-primary)',
});

/**
 * 把字节数格式成人类可读的形式。
 * @param {number} bytes 字节数。
 * @returns {string} 例如 `3.4 KB`。
 */
function humanSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 传输浮层。
 * @param {{sid: string, transfer: object}} props 会话 id 与传输状态。
 * @returns {JSX.Element|null} 有传输时返回浮层，否则 null。
 */
export function TransferBar({ sid, transfer }) {
  const fileInput = useRef(null);

  if (transfer === undefined || transfer === null) return null;

  const phase = transfer.phase;
  const percent = transfer.size > 0 ? Math.min(1, (transfer.offset ?? 0) / transfer.size) : 0;

  /** 打开文件选择框（need-file 阶段专用）。 */
  const pick = () => fileInput.current?.click();

  return (
    <div style={barStyle} role="status">
      {phase === 'need-file' ? (
        <>
          <span>对端等待接收文件（rz）</span>
          <button
            type="button"
            onClick={pick}
            style={{
              padding: '3px 10px',
              border: '0.5px solid var(--dsw-alias-brand-primary)',
              borderRadius: '5px',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: '11px',
              color: 'var(--dsw-alias-brand-primary)',
              background: 'transparent',
            }}
          >
            选择文件
          </button>
          <input
            ref={fileInput}
            type="file"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) void actions.uploadFile(sid, file);
            }}
          />
        </>
      ) : null}

      {phase === 'sending' || phase === 'progress' ? (
        <>
          <span>上传 {transfer.name ?? ''}</span>
          <div style={trackStyle}>
            <div style={fillStyle(percent)} />
          </div>
          <span>{humanSize(transfer.offset ?? 0)} / {humanSize(transfer.size ?? 0)}</span>
        </>
      ) : null}

      {phase === 'offer' ? <span>对端发送 {transfer.name ?? ''}（{humanSize(transfer.size ?? 0)}）…</span> : null}

      {phase === 'complete' ? (
        transfer.mode === 'receive' ? (
          <>
            <span>已接收 {transfer.name ?? ''}</span>
            <a
              href={`/api/dsh-ssh/transfer/download?sid=${encodeURIComponent(sid)}&name=${encodeURIComponent(transfer.name ?? '')}`}
              download={transfer.name ?? 'download'}
              style={{ color: 'var(--dsw-alias-brand-primary)' }}
            >
              下载
            </a>
          </>
        ) : (
          <span>已发送 {transfer.name ?? ''}</span>
        )
      ) : null}

      {phase === 'error' ? <span style={{ color: 'var(--dsw-alias-label-error)' }}>{transfer.message ?? '传输失败'}</span> : null}
    </div>
  );
}
