/**
 * 右栏：AI 助手（对话 → 读面板 → 生成命令 → 执行）。
 *
 * 这不是"上下文卡 + 建议指令"了：本文件实现一个完整的对话面板——
 * 用户大白话输入 → Host 侧 `POST /chat`（SSE）跑模型轮 → 文本流式渲染 →
 * 模型要跑命令时弹命令卡：默认**人工确认**（点"执行"才跑，走
 * `POST /chat/exec`，marker 捕获输出回给模型续跑），也可开"自动执行"
 * 让模型自己连轴转。对话状态在 store 的模块级 `chats` 表里，切标签不丢。
 *
 * 与启动台的耦合只有一句话：本组件不拿 ctx，数据全走模块级 store。
 */
import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { ChatIcon, ChevronLeftIcon, ChevronRightIcon } from './icons.js';
import { actions, getState, subscribe } from './store.js';
import { t } from './locales.js';

/** 头部行：标题 + 模型选择 + 自动执行 + 收起按钮。 */
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
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: '6px',
  cursor: 'pointer',
  color: 'var(--dsw-alias-label-tertiary)',
  background: 'transparent',
};

/** 消息区与输入区的等宽字体栈。 */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/** 行内 code 样式。 */
const inlineCodeStyle = {
  padding: '1px 4px',
  borderRadius: '4px',
  background: 'var(--dsw-alias-bg-layer-2)',
  fontFamily: MONO,
  fontSize: '0.92em',
};

/** 代码块样式。 */
const codeBlockStyle = {
  margin: '6px 0',
  padding: '8px',
  borderRadius: '6px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  fontFamily: MONO,
  fontSize: '11px',
  lineHeight: '16px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  overflowX: 'auto',
};

/** 命令卡状态 → 颜色（成功=品牌色，失败=错误色，其余=弱化）。 */
const CALL_COLORS = {
  awaiting: 'var(--dsw-alias-label-tertiary)',
  running: 'var(--dsw-alias-brand-primary)',
  done: 'var(--dsw-alias-brand-primary)',
  failed: 'var(--dsw-alias-label-error)',
  skipped: 'var(--dsw-alias-label-quaternary)',
};

/** 命令卡状态 → 文案 key。 */
const CALL_LABELS = {
  awaiting: 'chatRun',
  running: 'chatRunning2',
  done: 'chatDone',
  failed: 'chatFailed',
  skipped: 'chatSkipped',
};

/**
 * 行内富文本：`code` 与 **bold**。不做完整 markdown——终端场景够用即可。
 * @param {string} text 纯文本。
 * @returns {React.ReactNode[]} 节点数组。
 */
function inlineNodes(text) {
  /** @type {React.ReactNode[]} */
  const nodes = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(
        <code key={`c${match.index}`} style={inlineCodeStyle}>
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<strong key={`b${match.index}`}>{token.slice(2, -2)}</strong>);
    }
    last = match.index + token.length;
    match = pattern.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * 段落富文本：``` 代码块 + 行内格式。未闭合的代码块按到文本末尾算。
 * @param {{text: string}} props 参数。
 * @returns {JSX.Element} 渲染结果。
 */
function RichText({ text }) {
  /** @type {Array<{kind: string, value: string}>} */
  const segments = [];
  const fence = /```[\w-]*\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let match = fence.exec(text);
  while (match !== null) {
    if (match.index > last) segments.push({ kind: 'text', value: text.slice(last, match.index) });
    segments.push({ kind: 'code', value: match[1].replace(/\n$/, '') });
    last = fence.lastIndex;
    match = fence.exec(text);
  }
  if (last < text.length) segments.push({ kind: 'text', value: text.slice(last) });
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'code' ? (
          <pre key={`seg${index}`} style={codeBlockStyle}>
            {segment.value}
          </pre>
        ) : (
          <span key={`seg${index}`}>{inlineNodes(segment.value)}</span>
        ),
      )}
    </>
  );
}

/**
 * 命令卡：一条待执行/已执行的命令。
 *
 * awaiting 状态给"执行/跳过"两个按钮（人工确认模式的核心交互）；
 * 其余状态展示结果摘要，输出折叠在 <details> 里（可能很长）。
 * @param {{sid: string, call: object}} props 参数。
 * @returns {JSX.Element} 命令卡。
 */
function CallCard({ sid, call }) {
  const color = CALL_COLORS[call.status] ?? CALL_COLORS.awaiting;
  const label = t(CALL_LABELS[call.status] ?? 'chatRun');
  return (
    <div
      style={{
        margin: '6px 0',
        borderRadius: '8px',
        border: `0.5px solid ${color}`,
        background: 'var(--dsw-alias-bg-layer-2)',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px' }}>
        <span aria-hidden="true" style={{ width: '6px', height: '6px', borderRadius: '50%', background: color, flex: '0 0 auto' }} />
        <span style={{ flex: '0 0 auto', fontSize: '10px', fontWeight: 600, color }}>{label}</span>
        {call.timedOut === true ? (
          <span style={{ flex: '0 0 auto', fontSize: '10px', color: 'var(--dsw-alias-label-error)' }}>{t('chatTimeout')}</span>
        ) : null}
      </div>
      <pre
        style={{
          margin: 0,
          padding: '0 8px 8px',
          fontFamily: MONO,
          fontSize: '11px',
          lineHeight: '16px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          color: 'var(--dsw-alias-label-primary)',
        }}
      >
        {call.command}
      </pre>
      {call.status === 'awaiting' ? (
        <div style={{ display: 'flex', gap: '6px', padding: '0 8px 8px' }}>
          <button
            type="button"
            onClick={() => void actions.resolveToolCall(sid, call.id, true)}
            style={{
              padding: '4px 12px',
              border: '0.5px solid var(--dsw-alias-brand-primary)',
              borderRadius: '6px',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: '11px',
              color: 'var(--dsw-alias-brand-primary)',
              background: 'transparent',
            }}
          >
            {t('chatRun')}
          </button>
          <button
            type="button"
            onClick={() => void actions.resolveToolCall(sid, call.id, false)}
            style={{
              padding: '4px 12px',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              borderRadius: '6px',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: '11px',
              color: 'var(--dsw-alias-label-tertiary)',
              background: 'transparent',
            }}
          >
            {t('chatSkip')}
          </button>
        </div>
      ) : null}
      {call.status !== 'awaiting' && call.output !== '' ? (
        <details style={{ padding: '0 8px 8px' }}>
          <summary style={{ fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)', cursor: 'pointer' }}>
            {t('chatOutput')}
          </summary>
          <pre
            style={{
              margin: '4px 0 0',
              padding: '6px',
              maxHeight: '200px',
              overflow: 'auto',
              borderRadius: '6px',
              background: 'var(--dsw-alias-bg-layer-3)',
              fontFamily: MONO,
              fontSize: '10px',
              lineHeight: '15px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              color: 'var(--dsw-alias-label-secondary)',
            }}
          >
            {call.output}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/**
 * 一个 assistant 回合：流式文本 + 若干命令卡。
 * @param {{sid: string, message: object}} props 参数。
 * @returns {JSX.Element} 回合块。
 */
function TurnMessage({ sid, message }) {
  const hasText = typeof message.text === 'string' && message.text !== '';
  const calls = Array.isArray(message.calls) ? message.calls : [];
  if (!hasText && calls.length === 0 && message.streaming === true) {
    return <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-quaternary)' }}>{t('chatThinking')}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--dsw-alias-label-quaternary)' }}>{t('chatAssistant')}</div>
      {hasText ? (
        <div
          style={{
            fontSize: '12px',
            lineHeight: '19px',
            color: 'var(--dsw-alias-label-primary)',
            wordBreak: 'break-word',
          }}
        >
          <RichText text={message.text} />
        </div>
      ) : null}
      {calls.map((call) => (
        <CallCard key={call.id} sid={sid} call={call} />
      ))}
    </div>
  );
}

/**
 * 消息列表：user 气泡 + assistant 回合 + 错误条。
 * @param {{sid: string}} props 参数。
 * @returns {JSX.Element} 消息列表。
 */
function ChatMessages({ sid }) {
  const chat = getState().chats[sid] ?? { messages: [], streaming: false, error: null };
  const bottomRef = useRef(null);

  useEffect(() => {
    // 新消息/流式增量到底部：对话面板的基本礼貌。
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [chat.messages, chat.streaming]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px' }}>
      {chat.messages.length === 0 && chat.streaming !== true ? (
        <div style={{ padding: '12px 4px' }}>
          <div style={{ fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' }}>{t('chatSubtitle')}</div>
          <div style={{ marginTop: '10px', fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)' }}>{t('chatSuggestHint')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
            {[t('suggestion1'), t('suggestion2'), t('suggestion3')].map((text, index) => (
              <button
                key={`suggest-${index}`}
                type="button"
                onClick={() => void actions.sendChat(text)}
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
      ) : null}
      {chat.messages.map((message, index) =>
        message.role === 'user' ? (
          <div key={`m${index}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
            <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--dsw-alias-label-quaternary)' }}>{t('chatYou')}</div>
            <div
              style={{
                maxWidth: '92%',
                padding: '7px 10px',
                borderRadius: '10px',
                fontSize: '12px',
                lineHeight: '18px',
                color: 'var(--dsw-alias-label-primary)',
                background: 'var(--dsw-alias-bg-layer-3)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {message.content}
            </div>
          </div>
        ) : (
          <TurnMessage key={`m${index}`} sid={sid} message={message} />
        ),
      )}
      {chat.streaming === true && chat.messages.every((message) => message.kind !== 'turn' || message.streaming !== true) ? (
        <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-quaternary)' }}>{t('chatThinking')}</div>
      ) : null}
      {chat.error !== null ? (
        <div
          style={{
            padding: '6px 8px',
            borderRadius: '6px',
            fontSize: '11px',
            lineHeight: '16px',
            color: 'var(--dsw-alias-label-error)',
            background: 'var(--dsw-alias-bg-layer-3)',
          }}
        >
          {t('chatError', { message: chat.error })}
        </div>
      ) : null}
      <div ref={bottomRef} />
    </div>
  );
}

/**
 * 输入区：textarea（Enter 发送 / Shift+Enter 换行）+ 发送/停止按钮。
 * @param {{sid: string, streaming: boolean}} props 参数。
 * @returns {JSX.Element} 输入区。
 */
function ChatComposer({ sid, streaming }) {
  const [draft, setDraft] = React.useState('');
  /**
   * 发送当前草稿。
   * @returns {void}
   */
  const submit = () => {
    const text = draft.trim();
    if (text === '' || streaming === true) return;
    setDraft('');
    void actions.sendChat(text);
  };
  return (
    <div style={{ borderTop: '0.5px solid var(--dsw-alias-border-l2)', padding: '8px' }}>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Enter 发送、Shift+Enter 换行——输入框的通行约定。
          if (event.key === 'Enter' && event.shiftKey !== true) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={t('chatPlaceholder')}
        rows={3}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '7px 9px',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: '8px',
          resize: 'none',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-2)',
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '6px' }}>
        {streaming === true ? (
          <button
            type="button"
            onClick={actions.stopChat}
            style={{
              padding: '5px 14px',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              borderRadius: '7px',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: '11px',
              color: 'var(--dsw-alias-label-tertiary)',
              background: 'transparent',
            }}
          >
            {t('chatStop')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={submit}
          disabled={streaming === true || draft.trim() === ''}
          style={{
            padding: '5px 16px',
            border: '0.5px solid var(--dsw-alias-brand-primary)',
            borderRadius: '7px',
            cursor: streaming === true || draft.trim() === '' ? 'default' : 'pointer',
            font: 'inherit',
            fontSize: '11px',
            color: 'var(--dsw-alias-brand-primary)',
            background: 'transparent',
            opacity: streaming === true || draft.trim() === '' ? 0.5 : 1,
          }}
        >
          {t('chatSend')}
        </button>
      </div>
    </div>
  );
}

/**
 * 模型选择 + 自动执行开关（输入区上方一行）。
 * @returns {JSX.Element} 控制行。
 */
function ChatControls() {
  const llm = getState().llm;
  const autoExec = getState().chatAutoExec;
  if (llm.status !== 'ready') return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }}>
      <span style={{ flex: '0 0 auto', fontSize: '10px', color: 'var(--dsw-alias-label-quaternary)' }}>{t('chatModel')}</span>
      <select
        value={`${llm.picked.provider}::${llm.picked.model}`}
        onChange={(event) => {
          const [provider, ...rest] = event.target.value.split('::');
          actions.setChatModel(provider, rest.join('::'));
        }}
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          padding: '3px 6px',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          borderRadius: '6px',
          font: 'inherit',
          fontSize: '10px',
          color: 'var(--dsw-alias-label-secondary)',
          background: 'var(--dsw-alias-bg-layer-2)',
        }}
      >
        {llm.providers.map((provider) => (
          <optgroup
            key={provider.id}
            label={provider.unavailable !== undefined ? `${provider.name}（${provider.unavailable}）` : provider.name}
          >
            {(provider.models ?? []).map((model) => (
              <option key={`${provider.id}::${model.id}`} value={`${provider.id}::${model.id}`}>
                {model.label !== '' ? model.label : model.id}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        type="button"
        onClick={actions.toggleAutoExec}
        title={autoExec === true ? t('chatAutoExecOn') : t('chatAutoExecOff')}
        style={{
          flex: '0 0 auto',
          padding: '3px 8px',
          border: `0.5px solid ${autoExec === true ? 'var(--dsw-alias-label-error)' : 'var(--dsw-alias-border-l2)'}`,
          borderRadius: '6px',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: '10px',
          color: autoExec === true ? 'var(--dsw-alias-label-error)' : 'var(--dsw-alias-label-tertiary)',
          background: 'transparent',
        }}
      >
        {t('chatAutoExec')}
      </button>
    </div>
  );
}

/**
 * 右栏面板：模型控制 + 消息列表 + 输入区。
 * @returns {JSX.Element} 右栏。
 */
export function ChatPane() {
  const state = useSyncExternalStore(subscribe, getState);
  const sid = state.activeSid;

  useEffect(() => {
    // 模型清单与开关偏好各拉一次：右栏挂载就要知道"能不能聊"。
    void actions.loadLlm();
    actions.restoreChatPrefs();
  }, []);

  const chat = sid === null ? null : (state.chats[sid] ?? { messages: [], streaming: false, error: null });
  const llmUnavailable = state.llm.status === 'unavailable';

  /**
   *  body 区：没会话 / 没模型 / 正常对话 三态。
   * @returns {JSX.Element} 内容。
   */
  const renderBody = () => {
    if (sid === null) {
      return (
        <div style={{ padding: '24px 16px' }}>
          <div style={{ fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }}>{t('noSession')}</div>
          <div style={{ marginTop: '8px', fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-quaternary)' }}>
            {t('chatNoSessionHint')}
          </div>
        </div>
      );
    }
    if (llmUnavailable === true) {
      return (
        <div style={{ padding: '24px 16px' }}>
          <div style={{ fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }}>{t('chatNoLlm')}</div>
          <div style={{ marginTop: '8px', fontSize: '12px', lineHeight: '19px', color: 'var(--dsw-alias-label-quaternary)' }}>
            {t('chatNoLlmHint')}
          </div>
        </div>
      );
    }
    return <ChatMessages sid={sid} />;
  };

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
        <span style={{ flex: '1 1 auto' }}>{t('chatTitle')}</span>
        <button type="button" style={iconButtonStyle} onClick={actions.toggleChat} title={t('collapse')} aria-label={t('collapse')}>
          <ChevronRightIcon size={14} />
        </button>
      </div>
      <ChatControls />
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>{renderBody()}</div>
      {sid !== null && llmUnavailable !== true ? (
        <ChatComposer sid={sid} streaming={chat?.streaming === true} />
      ) : null}
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
