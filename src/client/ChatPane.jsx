/**
 * 右栏：会话上下文卡（M3 方案 A）。
 *
 * ── 为什么不是原生对话 ────────────────────────────────────────────────
 * `renderFactorySlot` 是**宿主注入的 prop**，不可 import（设计 §0.2 已核实：
 * ui-slots 的 `PropsRenderFactories` 只把它放在 props 上，而启动台 view 的
 * viewProps 只有 `{appId, app, back, open, t, active}`）。再加上槽必须由
 * 父级 children 先声明、`conversation.content` 是 session-maybe 作用域，
 * 根作用域下只能渲染空白。所以本轮交付「上下文卡 + 建议指令」，数据来自
 * 我们自己的 `GET /api/dsh-ssh/context`，不碰 dsh 内部会话 API。
 *
 * ── 未来替换点（唯一）────────────────────────────────────────────────
 * 本文件只有一个地方需要动：`renderConversation()`。上游启动台补上
 * `renderFactorySlot` 之后，把它的函数体换成下面这一行即可，头部、宽度、
 * 折叠逻辑一个字都不用改：
 *
 *   return renderFactorySlot(
 *     'conversation.content',
 *     { variant: 'embedded', phase, hero },
 *     { slots: { views: FixedChatConversationView } },
 *   );
 *
 * ── 数据契约（Host 侧并行实现中）──────────────────────────────────────
 * `GET /api/dsh-ssh/context?sid=` → `{sid, host, status, tail, gap}`。
 * 拿不到（404 / 网络失败 / 接口还没上）时 store 记 'unavailable'，这里显示
 * 「暂无上下文」——可选接口绝不允许把右栏打崩。
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import { ChatIcon, ChevronLeftIcon, ChevronRightIcon } from './icons.js';
import { actions, getState, subscribe } from './store.js';
import { t } from './locales.js';

/** 上下文卡里展示的输出行数（设计 §3：最后 12 行）。 */
const TAIL_LINES = 12;

/** 头部行：标题 + 收起按钮。 */
const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '10px 12px',
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-tertiary)',
  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
};

/** 图标按钮的基础样式。 */
const iconButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '24px',
  height: '24px',
  padding: 0,
  border: 0,
  borderRadius: '6px',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-tertiary)',
  background: 'transparent',
};

/** 状态 -> 状态灯颜色（与左栏同一套语义）。 */
const LIGHT_COLORS = {
  open: 'var(--dsw-alias-brand-primary)',
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
 * 把 tail 归一成字符串数组：Host 可能给字符串（带 \n），也可能给数组。
 * @param {string|string[]|null|undefined} tail 输出尾巴。
 * @returns {string[]} 行数组。
 */
function toLines(tail) {
  if (Array.isArray(tail)) return tail.map((line) => String(line));
  if (typeof tail === 'string') return tail.split('\n');
  return [];
}

/**
 * 复制文本到剪贴板：优先异步 API，失败回退到隐藏 textarea + execCommand。
 * @param {string} text 待复制文本。
 * @returns {Promise<boolean>} 是否成功。
 */
async function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒 / 非安全上下文：走回退路径。
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * 上下文卡的一行「小标题 + 右侧动作」。
 * @param {{title: string, action?: React.ReactNode}} props 参数。
 * @returns {JSX.Element} 小标题行。
 */
function SectionTitle({ title, action = null }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        margin: '14px 0 6px',
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.03em',
        color: 'var(--dsw-alias-label-tertiary)',
      }}
    >
      <span style={{ flex: '1 1 auto' }}>{title}</span>
      {action}
    </div>
  );
}

/**
 * 会话上下文卡（右栏当前内容）。
 * @param {{sid: string|null, entry: {status: string, data: object|null}|null, sessions: Record<string, object>, hosts: object[]}} props 组件参数。
 * @returns {JSX.Element} 上下文卡。
 */
function ContextCard({ sid, entry, sessions, hosts }) {
  useEffect(() => {
    // 切标签就换一份上下文；已缓存（ready）时 store 内部直接返回，不重复请求。
    void actions.loadContext(sid);
  }, [sid]);

  if (sid === null) {
    return (
      <div style={{ padding: '24px 16px' }}>
        <div style={{ fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }}>{t('noSession')}</div>
        <div style={{ marginTop: '8px', fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-quaternary)' }}>
          {t('noSessionHint')}
        </div>
      </div>
    );
  }

  const data = entry?.data ?? null;
  const status = data?.status ?? sessions?.[sid]?.status ?? 'offline';
  const label =
    (typeof data?.host === 'string' ? data.host : data?.host?.label) ??
    sessions?.[sid]?.host?.label ??
    hosts.find((host) => host.sid === sid)?.label ??
    sid;
  const gap = data?.gap ?? null;
  // 「回放缺口」警示灯的判据（Host 侧语义，别想当然）：
  // Host 的 `gap.truncated` 有**两种**成因 —— ① 滚动缓冲真的被裁剪过
  // （`dropped > 0`），② 缓冲总行数 > 本次请求的 lines（默认 80）。
  // 我们只请求 80 行、只渲染 12 行，所以只要输出超过 80 行 `truncated` 就是
  // true；拿它当警示灯会长期误亮。真正的"你少看了一段"只有 dropped > 0。
  const dropped = typeof gap?.dropped === 'number' ? gap.dropped : 0;
  const hasGap = gap?.truncated === true && dropped > 0;
  const lines = toLines(data?.tail).slice(-TAIL_LINES);
  // 首帧 entry 还不存在（effect 尚未跑完）算 loading，不要闪一下「暂无上下文」。
  const loading = entry === null || entry === undefined || entry.status === 'loading';
  const unavailable = entry?.status === 'unavailable';
  const suggestions = [t('suggestion1'), t('suggestion2'), t('suggestion3')];

  const handleCopy = (text) => {
    void copyText(text).then((ok) => {
      if (ok) actions.showToast(t('copied'));
    });
  };

  return (
    <div style={{ padding: '12px 12px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span
          aria-hidden="true"
          style={{
            width: '8px',
            height: '8px',
            flex: '0 0 auto',
            borderRadius: '50%',
            background: LIGHT_COLORS[status] ?? LIGHT_COLORS.offline,
          }}
        />
        <span
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            fontSize: '13px',
            lineHeight: '18px',
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        <span style={{ flex: '0 0 auto', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }}>
          {t(STATUS_KEYS[status] ?? 'statusOffline')}
        </span>
      </div>
      <div style={{ marginTop: '4px', fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-quaternary)' }}>
        {t('contextSubtitle')}
      </div>

      {hasGap ? (
        <div
          style={{
            marginTop: '8px',
            padding: '4px 8px',
            borderRadius: '6px',
            fontSize: '11px',
            lineHeight: '16px',
            color: 'var(--dsw-alias-label-error)',
            background: 'var(--dsw-alias-bg-layer-3)',
          }}
        >
          {t('contextGap')}
          {typeof gap?.dropped === 'number' ? ` · -${gap.dropped}` : ''}
        </div>
      ) : null}

      <SectionTitle
        title={t('contextTail')}
        action={
          <button
            type="button"
            onClick={() => void actions.refreshContext(sid)}
            style={{
              padding: '2px 6px',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              borderRadius: '5px',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: '10px',
              fontWeight: 400,
              color: 'var(--dsw-alias-label-tertiary)',
              background: 'transparent',
            }}
          >
            {t('contextRefresh')}
          </button>
        }
      />

      {unavailable ? (
        <div>
          <div style={{ fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' }}>{t('contextUnavailable')}</div>
          <div style={{ marginTop: '4px', fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-quaternary)' }}>
            {t('contextUnavailableHint')}
          </div>
        </div>
      ) : loading && lines.length === 0 ? (
        <div style={{ fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-quaternary)' }}>{t('loading')}</div>
      ) : lines.length === 0 ? (
        <div style={{ fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-quaternary)' }}>{t('contextEmpty')}</div>
      ) : (
        <pre
          style={{
            margin: 0,
            padding: '8px',
            maxHeight: '220px',
            overflow: 'auto',
            borderRadius: '6px',
            border: '0.5px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-secondary)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: '11px',
            lineHeight: '16px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {lines.join('\n')}
        </pre>
      )}

      <SectionTitle title={t('contextSuggestions')} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {suggestions.map((text, index) => (
          <button
            key={`suggestion-${index + 1}`}
            type="button"
            title={`${t('copied')} ← ${text}`}
            onClick={() => handleCopy(text)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '7px 9px',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              borderRadius: '7px',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: '11px',
              lineHeight: '16px',
              color: 'var(--dsw-alias-label-secondary)',
              background: 'var(--dsw-alias-bg-layer-2)',
            }}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 右栏面板。
 * @returns {JSX.Element} 右栏。
 */
export function ChatPane() {
  const state = useSyncExternalStore(subscribe, getState);
  const sid = state.activeSid;

  /**
   * **唯一替换点**：将来换成 `renderFactorySlot('conversation.content', ...)`
   * 的那一行（见文件头注释）。除此之外右栏没有任何与对话内容耦合的代码。
   * @returns {JSX.Element} 对话区内容。
   */
  const renderConversation = () => (
    <ContextCard
      sid={sid}
      entry={sid === null ? null : (state.contexts[sid] ?? null)}
      sessions={state.sessions}
      hosts={state.hosts}
    />
  );

  return (
    <aside
      style={{
        width: '360px',
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderLeft: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
      }}
    >
      <div style={headerStyle}>
        <ChatIcon size={14} />
        <span style={{ flex: '1 1 auto' }}>{t('contextTitle')}</span>
        <button type="button" style={iconButtonStyle} onClick={actions.toggleChat} title={t('collapse')} aria-label={t('collapse')}>
          <ChevronRightIcon size={14} />
        </button>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>{renderConversation()}</div>
    </aside>
  );
}

/**
 * 右栏收起后的展开把手。
 * @returns {JSX.Element} 窄条。
 */
export function ChatToggle() {
  return (
    <aside
      style={{
        width: '36px',
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: '10px',
        borderLeft: '0.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
      }}
    >
      <button type="button" style={iconButtonStyle} onClick={actions.toggleChat} title={t('expand')} aria-label={t('expand')}>
        <ChevronLeftIcon size={14} />
      </button>
    </aside>
  );
}
