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
import { ChatIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from './icons.js';
import { actions, getState, subscribe } from './store.js';
import { t } from './locales.js';
import { parseMarkdown } from './markdown.js';

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
  margin: 0,
  padding: '8px 10px',
  borderRadius: '6px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-secondary)',
  fontFamily: MONO,
  fontSize: '12px',
  lineHeight: '18px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  overflowX: 'auto',
};

/** 正文段落：**保留硬换行**（否则整段折叠成一行）。 */
const paragraphStyle = {
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

/** 标题（markdown #）。 */
const headingStyle = {
  margin: 0,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
};

/** 列表容器。 */
const listStyle = {
  margin: 0,
  paddingLeft: '18px',
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
};

/** 列表项：项内换行也要保留。 */
const listItemStyle = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

/** 引用块。 */
const quoteStyle = {
  margin: 0,
  paddingLeft: '8px',
  borderLeft: '2px solid var(--dsw-alias-border-l2)',
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

/** 表格外框：窄面板里靠横向滚动兜底，不把气泡撑破。 */
const tableWrapStyle = {
  margin: 0,
  overflowX: 'auto',
};

/** 表格本体：细边线、紧凑内边距，跟终端风格一致。 */
const tableStyle = {
  borderCollapse: 'collapse',
  width: '100%',
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
};

/** 单元格。 */
const cellStyle = {
  padding: '4px 8px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  verticalAlign: 'top',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

/** 表头单元格。 */
const headCellStyle = {
  fontWeight: 500,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-bg-layer-2)',
  whiteSpace: 'nowrap',
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

/** 思考过程折叠框：比正文更弱、限高，不抢正文的位置。 */
const reasoningBoxStyle = {
  margin: '2px 0 4px',
  padding: '6px 8px',
  borderRadius: '6px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  maxHeight: '160px',
  overflow: 'auto',
};

/** 思考过程摘要行。 */
const reasoningSummaryStyle = {
  fontSize: '10px',
  color: 'var(--dsw-alias-label-quaternary)',
  cursor: 'pointer',
};

/** 思考过程正文（等宽、弱化、可换行）。 */
const reasoningTextStyle = {
  margin: '4px 0 0',
  fontFamily: MONO,
  fontSize: '10px',
  lineHeight: '15px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  color: 'var(--dsw-alias-label-quaternary)',
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
 * 段落富文本：markdown 块（代码块/标题/列表/引用/段落）+ 行内格式。
 *
 * 关键点：**段落与列表项都保留硬换行**（white-space: pre-wrap）。以前整段
 * 文本塞进一个 <span>，HTML 把换行折叠成空格，面板上就是"一整坨字、没有
 * 折行"（2026-10-24 用户反馈）。字号/行高对齐 dsh 原生对话（13px / 1.6）。
 * @param {{text: string}} props 参数。
 * @returns {JSX.Element} 渲染结果。
 */
export function RichText({ text }) {
  const blocks = parseMarkdown(text);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {blocks.map((block, index) => {
        if (block.kind === 'code') {
          return (
            <pre key={`b${index}`} style={codeBlockStyle}>
              {block.text}
            </pre>
          );
        }
        if (block.kind === 'heading') {
          return (
            <div
              key={`b${index}`}
              style={{ ...headingStyle, fontSize: block.level <= 2 ? '14px' : '13px' }}
            >
              {inlineNodes(block.text)}
            </div>
          );
        }
        if (block.kind === 'list') {
          const ListTag = block.ordered === true ? 'ol' : 'ul';
          return (
            <ListTag key={`b${index}`} style={listStyle}>
              {block.items.map((item, itemIndex) => (
                <li key={`i${itemIndex}`} style={listItemStyle}>
                  {inlineNodes(item)}
                </li>
              ))}
            </ListTag>
          );
        }
        if (block.kind === 'table') {
          return (
            <div key={`b${index}`} style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    {block.header.map((cell, cellIndex) => (
                      <th key={`h${cellIndex}`} style={{ ...cellStyle, ...headCellStyle, textAlign: block.align[cellIndex] ?? 'left' }}>
                        {inlineNodes(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`r${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td key={`c${cellIndex}`} style={{ ...cellStyle, textAlign: block.align[cellIndex] ?? 'left' }}>
                          {inlineNodes(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === 'quote') {
          return (
            <div key={`b${index}`} style={quoteStyle}>
              {inlineNodes(block.text)}
            </div>
          );
        }
        return (
          <div key={`b${index}`} style={paragraphStyle}>
            {inlineNodes(block.lines.join('\n'))}
          </div>
        );
      })}
    </div>
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
  const reasoning = typeof message.reasoning === 'string' ? message.reasoning : '';
  const calls = Array.isArray(message.calls) ? message.calls : [];
  if (!hasText && reasoning === '' && calls.length === 0 && message.streaming === true) {
    return <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-quaternary)' }}>{t('chatThinking')}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--dsw-alias-label-quaternary)' }}>{t('chatAssistant')}</div>
      {/* 思考过程：思考型模型先想几十秒才有正文，不显示这段就只剩"卡住"的观感。 */}
      {reasoning !== '' ? (
        <details style={reasoningBoxStyle} open={message.streaming === true}>
          <summary style={reasoningSummaryStyle}>{t('chatReasoning')}</summary>
          <pre style={reasoningTextStyle}>{reasoning}</pre>
        </details>
      ) : null}
      {hasText === false && message.streaming === true ? (
        <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-quaternary)' }}>{t('chatThinking')}</div>
      ) : null}
      {hasText ? (
        <div
          style={{
            fontSize: '13px',
            lineHeight: 1.6,
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
      {chat.retrying !== null && chat.streaming === true ? (
        <div style={{ fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-quaternary)' }}>
          {t('chatRetrying', { attempt: chat.retrying.attempt, max: chat.retrying.max ?? '…' })}
        </div>
      ) : null}
      {chat.slow === true && chat.streaming === true ? (
        <div style={{ fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-quaternary)' }}>{t('chatSlow')}</div>
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

/** 输入框外框：一个圆角盒子装下输入区与底部控件（对齐 dsh 原生 composer）。 */
const composerBoxStyle = {
  margin: '8px',
  padding: '6px 6px 4px',
  border: '0.5px solid var(--dsw-alias-border-l3)',
  borderRadius: '12px',
  background: 'var(--dsw-alias-bg-layer-2)',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
};

/** 无边框输入区（描边交给外框）。 */
const composerInputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 4px 0',
  border: 'none',
  outline: 'none',
  resize: 'none',
  background: 'transparent',
  font: 'inherit',
  fontSize: '13px',
  lineHeight: '19px',
  color: 'var(--dsw-alias-label-primary)',
};

/** 底部控件行。 */
const composerRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  minHeight: '26px',
};

/** 控件胶囊（模型 / 授权）：小、低对比、不抢输入区的视觉重心。 */
const pillStyle = {
  maxWidth: '46%',
  height: '24px',
  padding: '0 6px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: '6px',
  background: 'transparent',
  font: 'inherit',
  fontSize: '11px',
  color: 'var(--dsw-alias-label-secondary)',
  cursor: 'pointer',
};

/**
 * 向上展开的胶囊下拉（模型 / 授权共用）。
 *
 * 为什么不用原生 `<select>`：它的展开方向由浏览器和操作系统决定，CSS 管不
 * 了。右栏的输入区贴着面板底边，向下只有几像素，选项必然被裁掉（2026-10-25
 * 真机反馈）。改成按钮 + 绝对定位浮层，`bottom: 100%` 保证永远向上弹；列表
 * 超高时内部滚动，不撑破面板。
 *
 * @param {object} props 参数。
 * @param {string} props.value 当前值。
 * @param {(value: string) => void} props.onChange 选中回调。
 * @param {Array<{label: string, options: Array<{value: string, label: string, hint?: string}>}>} props.groups 分组选项。
 * @param {string} props.title 悬浮提示（同时是 aria-label）。
 * @returns {JSX.Element} 控件。
 */
function UpwardSelect({ value, onChange, groups, title }) {
  const [open, setOpen] = React.useState(false);
  const boxRef = React.useRef(null);
  const current = groups
    .flatMap((group) => group.options)
    .find((option) => option.value === value);
  React.useEffect(() => {
    if (open !== true) return undefined;
    /** 指针落在浮层之外就收起（捕获阶段，先于别处的点击处理）。 */
    const onPointerDown = (event) => {
      if (boxRef.current !== null && boxRef.current.contains(event.target) !== true) {
        setOpen(false);
      }
    };
    /** Esc 收起：键盘用户不必找到鼠标。 */
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  return (
    <div ref={boxRef} style={{ position: 'relative', minWidth: 0, maxWidth: '46%' }}>
      <button
        type="button"
        onClick={() => setOpen((previous) => previous !== true)}
        title={title}
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          ...pillStyle,
          display: 'flex',
          alignItems: 'center',
          gap: '3px',
          width: '100%',
          maxWidth: '100%',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {current !== undefined ? current.label : title}
        </span>
        <ChevronDownIcon size={10} style={{ flex: '0 0 auto' }} />
      </button>
      {open === true ? (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            // 向上弹：输入区贴面板底边，向下展开必被裁。
            bottom: 'calc(100% + 4px)',
            left: 0,
            minWidth: '180px',
            maxWidth: '300px',
            // 列表可能很长（provider × model）：限高 + 内部滚动。
            maxHeight: '260px',
            overflowY: 'auto',
            zIndex: 100,
            padding: '4px',
            border: '0.5px solid var(--dsw-alias-border-l3)',
            borderRadius: '8px',
            background: 'var(--dsw-alias-bg-layer-3)',
            boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28)',
          }}
        >
          {groups.map((group) => (
            <div key={group.label}>
              <div
                style={{
                  padding: '4px 8px 2px',
                  fontSize: '10px',
                  lineHeight: '14px',
                  color: 'var(--dsw-alias-label-quaternary)',
                }}
              >
                {group.label}
              </div>
              {group.options.map((option) => {
                const active = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      padding: '4px 8px',
                      border: 'none',
                      borderRadius: '5px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      font: 'inherit',
                      fontSize: '11px',
                      lineHeight: '16px',
                      color: active === true ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
                      background: active === true ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                      fontWeight: active === true ? 600 : 400,
                    }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 输入区：一个盒子 = 输入框 + 底部控件（模型 / 授权 / 发送）。
 *
 * 控件放进盒子里是照 dsh 原生 composer 的排布：模型与授权是"这次对话怎么跑"
 * 的设置，跟输入属于同一组，放外面会让右栏多一条常驻工具栏（2026-10-24 用户
 * 要求）。
 *
 * `streaming`（在途请求）与 `pending`（等用户确认命令卡）都会锁住发送：
 * 前者是"别插队"，后者是"历史里还有没结果的 tool-call，发出去必被 wire
 * 校验拒绝"。两者的区别在按钮：只有真在跑的时候才给"停止"。
 * @param {{sid: string, streaming: boolean, pending: boolean}} props 参数。
 * @returns {JSX.Element} 输入区。
 */
function ChatComposer({ sid, streaming, pending }) {
  const [draft, setDraft] = React.useState('');
  const llm = getState().llm;
  const approval = getState().chatApproval;
  const locked = streaming === true || pending === true;
  const canSend = locked === false && draft.trim() !== '';
  /**
   * 发送当前草稿。
   * @returns {void}
   */
  const submit = () => {
    const text = draft.trim();
    if (text === '' || locked) return;
    setDraft('');
    void actions.sendChat(text);
  };
  return (
    <div style={composerBoxStyle}>
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
        rows={2}
        style={composerInputStyle}
      />
      <div style={composerRowStyle}>
        {llm.status === 'ready' ? (
          <UpwardSelect
            value={`${llm.picked.provider}::${llm.picked.model}`}
            onChange={(next) => {
              const [provider, ...rest] = next.split('::');
              actions.setChatModel(provider, rest.join('::'));
            }}
            title={t('chatModel')}
            groups={llm.providers.map((provider) => ({
              label: provider.unavailable !== undefined ? `${provider.name}（${provider.unavailable}）` : provider.name,
              options: (provider.models ?? []).map((model) => ({
                value: `${provider.id}::${model.id}`,
                label: model.label !== '' ? model.label : model.id,
              })),
            }))}
          />
        ) : null}
        <UpwardSelect
          value={approval}
          onChange={(next) => actions.setApproval(next)}
          title={t('chatApproval')}
          groups={[
            {
              label: t('chatApproval'),
              options: [
                { value: 'auto', label: t('chatApprovalAuto') },
                { value: 'danger', label: t('chatApprovalDanger') },
                { value: 'always', label: t('chatApprovalAlways') },
              ],
            },
          ]}
        />
        <span style={{ flex: '1 1 auto' }} />
        {streaming === true ? (
          <button
            type="button"
            onClick={actions.stopChat}
            style={{
              height: '24px',
              padding: '0 10px',
              border: '0.5px solid var(--dsw-alias-border-l2)',
              borderRadius: '6px',
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
          disabled={canSend === false}
          style={{
            height: '24px',
            padding: '0 12px',
            border: 'none',
            borderRadius: '6px',
            cursor: canSend === true ? 'pointer' : 'default',
            font: 'inherit',
            fontSize: '11px',
            color: 'var(--dsw-alias-label-primary-foreground)',
            background: 'var(--dsw-alias-brand-primary)',
            opacity: canSend === true ? 1 : 0.4,
          }}
        >
          {t('chatSend')}
        </button>
      </div>
      {pending === true ? (
        <div style={{ padding: '0 4px 2px', fontSize: '10px', lineHeight: '14px', color: 'var(--dsw-alias-label-quaternary)' }}>
          {t('chatPendingHint')}
        </div>
      ) : null}
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
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>{renderBody()}</div>
      {sid !== null && llmUnavailable !== true ? (
        <ChatComposer sid={sid} streaming={chat?.streaming === true} pending={chat?.pending === true} />
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
