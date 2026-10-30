/**
 * 应用视图：三栏骨架 + 多标签（设计 §2）。
 *
 * 左栏（主机）/ 中栏 flex:1（标签条 + 终端）/ 右栏（AI 助手）。
 * 三栏宽度可拖拽调整：两条边界各有一个 8px 命中条（见 SplitHandle.jsx），
 * 几何解算在 columns.js（夹在 [MIN, MAX]、给中栏留 CENTER_MIN）。
 * 高度撑满父容器——启动台协议 §5 明确容器已处理高度与滚动，应用绝不写
 * height:100vh，也不加顶部避让。
 *
 * 与启动台的耦合只剩启动台协议承诺的 props（v1.2）：
 * - `active`  视图可见性。隐藏时停轮询、回来再开——协议 §5 要求靠它降频，
 *   而不是去读根元素的 hidden 属性；
 * - `onTeardown(handler)`  关标签 / 启动台卸载前**同步**通知一次。只有
 *   `tab-closed`（用户真关了卡片）才断连接、销毁 runtime；`launcher-disposed`
 *   是宿主把页面卸载了（切会话就触发），必须保活——见 store.teardownForReason。
 *
 * 其余数据一律走模块级 store，所以本组件可以被独立渲染、独立单测。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { actions, getState, subscribe } from './store.js';
import { Hosts, HostsToggle } from './Hosts.jsx';
import { Tabs } from './Tabs.jsx';
import { Terminal } from './Terminal.jsx';
import { ChatPane, ChatToggle } from './ChatPane.jsx';
import { HostForm } from './HostForm.jsx';
import { SplitHandle } from './SplitHandle.jsx';
import { CHAT_DEFAULT, CHAT_MIN, HOSTS_DEFAULT, HOSTS_MIN, clampWidth, dragCeiling, solveColumns } from './columns.js';
import { t } from './locales.js';

/**
 * 两栏都包一层 memo：宽度通过 CSS 变量下发（不经过 props），所以拖动时
 * props 全等 → 这两棵子树（主机行 / 整棵对话树）一次都不重渲，每帧只重渲
 * 外框和两个把手。消息很多时这就是"丝滑"与"掉帧"的分界。
 *
 * memo 不挡 store 更新：两者内部都用 useSyncExternalStore 订阅，数据变化
 * 照常重渲。
 */
const MemoHosts = React.memo(Hosts);
const MemoChatPane = React.memo(ChatPane);

/**
 * SSH 应用视图。
 * @param {object} props 启动台注入的 props。
 * @param {boolean} [props.active] 视图是否可见（v1.1 可见性信号）。
 * @param {(handler: (detail: {reason: string}) => void) => (() => void)|undefined} [props.onTeardown]
 *   注册销毁回调（v1.2）：关标签（`tab-closed`）与启动台卸载（`launcher-disposed`）
 *   前同步调用一次，返回注销函数。老启动台不传，缺省就当没有。
 * @returns {JSX.Element} 三栏布局。
 */
export function SshAppView({ active = true, onTeardown } = {}) {
  const state = useSyncExternalStore(subscribe, getState);
  const frameRef = useRef(null);
  /**
   * 容器自身宽度（不是 window.innerWidth）：应用活在启动台面板里，面板
   * 可以被拖宽拖窄，甚至和窗口没关系。量不到之前是 0，solveColumns 会
   * 先按偏好渲染，一帧后修正。
   */
  const [viewport, setViewport] = useState(0);
  // 用户拖出来的宽度偏好：容器变窄只做让步（solveColumns），不改这两个值。
  const [hostsWidth, setHostsWidth] = useState(HOSTS_DEFAULT);
  const [chatWidth, setChatWidth] = useState(CHAT_DEFAULT);
  // 拖拽中：整棵子树禁掉文本选中，否则横扫三栏会把主机名/IP 全选蓝。
  const [dragging, setDragging] = useState(false);

  // 量容器宽度：rAF 合并 ResizeObserver 的连发，避免一次拖动写出几十帧。
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (el === null) return undefined;
    let raf = null;
    let disposed = false;
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      if (width > 0) setViewport((prev) => (Math.abs(prev - width) < 0.5 ? prev : width));
    };
    measure();
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      raf ??= requestAnimationFrame(() => {
        raf = null;
        measure();
      });
    });
    observer.observe(el);
    return () => {
      disposed = true;
      observer.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  const cols = solveColumns(viewport, hostsWidth, chatWidth);
  // 拖拽回调注册在 pointer 事件上，闭包里不能拿渲染时的旧值：两个 ref 保持最新。
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  // 拖拽基准：按下那一刻的**实际**宽度（不是偏好），整个手势只加 dx。
  const hostsBase = useRef(0);
  const chatBase = useRef(0);

  const handleDragEnd = useCallback(() => setDragging(false), []);

  const handleHostsDragStart = useCallback(() => {
    hostsBase.current = colsRef.current.hosts;
    setDragging(true);
  }, []);

  const handleHostsDrag = useCallback((dx) => {
    const ceiling = dragCeiling('hosts', viewportRef.current, colsRef.current);
    setHostsWidth(clampWidth(hostsBase.current + dx, HOSTS_MIN, ceiling));
  }, []);

  const handleChatDragStart = useCallback(() => {
    chatBase.current = colsRef.current.chat;
    setDragging(true);
  }, []);

  const handleChatDrag = useCallback((dx) => {
    // 右栏把手往左拖 = 变宽，所以取负。
    const ceiling = dragCeiling('chat', viewportRef.current, colsRef.current);
    setChatWidth(clampWidth(chatBase.current - dx, CHAT_MIN, ceiling));
  }, []);

  useEffect(() => {
    // 轮询跟着 view 生命周期走：挂载刷一次 + 每 2s 更新状态灯，卸载即停。
    // store 本身（主机表、标签、终端运行时）活在模块级，不受卸载影响。
    void actions.loadHosts();
    actions.startPolling();
    return () => {
      actions.stopPolling();
    };
  }, []);

  // 可见性：协议 §5 的降频点。隐藏时停轮询，重新显示再开（两个函数都幂等）。
  useEffect(() => {
    if (active === true) {
      actions.startPolling();
    } else {
      actions.stopPolling();
    }
  }, [active]);

  useEffect(() => {
    // 销毁通知（v1.2）：关卡片或启动台卸载时，把连接与 runtime 全部收干净。
    // handler 同步执行，所以 teardown 里只有本地操作，网络请求走
    // fire-and-forget——关闭动画不该等 HTTP。
    //
    // **只有 `tab-closed` 才真拆**：`launcher-disposed` 只是宿主把启动台
    // 页面卸载了（切到别的会话就触发），连接要留着——回来时终端屏幕还在。
    // 具体取舍写在 store.teardownForReason 的注释里。
    if (typeof onTeardown !== 'function') return undefined;
    return onTeardown((detail) => {
      actions.teardownForReason(typeof detail?.reason === 'string' ? detail.reason : '');
    });
  }, [onTeardown]);

  /**
   * 点左栏某一行：
   * - 该主机已经有会话 → 选中它（若还没标签，补一个：模型侧工具开的会话
   *   第一次出现在轮询结果里时就是这种情形）；
   * - 还没有会话 → 直接开一个新标签，别让用户点了个寂寞。
   * @param {object} host HostView。
   * @returns {void}
   */
  /**
   * 单击主机：只选中高亮；已有会话则聚焦其标签（不新开连接）。
   * 连接走双击（handleOpenTab）——2026-10-24 用户要求"进应用不自动连"。
   * @param {object} host HostView。
   * @returns {void}
   */
  const handleSelect = useCallback((host) => {
    actions.selectHost(host?.id ?? '');
    const sid = host?.sid ?? null;
    if (sid !== null) {
      actions.ensureTab(sid);
      actions.setActiveSid(sid);
    }
  }, []);

  /**
   * 双击主机 / 点「+ 标签」：连接。
   *
   * 双击的语义是"连这台机器"，不是"再开一个标签"：该主机已有活着的会话
   * （open / connecting）就聚焦它，没有（或上次连失败了）才新建。
   * 需要第二个标签时走标签条上的 `+` 或主机行的 `+` 按钮。
   *
   * 为什么不无脑新建：连不上时用户会连点几次双击，每点一次多一个黑屏标签，
   * 而且"上次那个报错"被顶到看不见的地方（2026-10-25 真机）。
   * @param {string} hostId Host id。
   * @returns {void}
   */
  const handleOpenTab = useCallback((hostId) => {
    const live = Object.values(getState().sessions).find(
      (session) => session?.host?.id === hostId
        && (session.status === 'open' || session.status === 'connecting'),
    );
    if (live !== undefined && typeof live.sid === 'string') {
      actions.ensureTab(live.sid);
      actions.setActiveSid(live.sid);
      return;
    }
    void actions.openSession(hostId);
  }, []);

  const handleNewTabFor = useCallback((hostId) => {
    void actions.openSession(hostId);
  }, []);

  const handleCloseTab = useCallback((sid) => {
    void actions.closeSession(sid);
  }, []);

  const handleNewTab = useCallback(() => {
    void actions.openNewTab();
  }, []);

  const handleEdit = useCallback((host) => {
    actions.openForm('edit', host);
  }, []);

  const handleDelete = useCallback((host) => {
    void actions.deleteHost(host.id);
  }, []);

  const handleAdd = useCallback(() => {
    actions.openForm('create', null);
  }, []);

  return (
    <div
      ref={frameRef}
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
        font: '13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        // 两栏宽度以 CSS 变量下发：拖动时每帧只改样式，不触发两侧面板重渲。
        '--dsh-ssh-hosts-w': `${cols.hosts}px`,
        '--dsh-ssh-chat-w': `${cols.chat}px`,
        // 拖动中禁选中 + 全容器保持 col-resize：指针扫过终端时不要变回文本光标。
        ...(dragging ? { userSelect: 'none', cursor: 'col-resize' } : {}),
      }}
    >
      {state.hostsCollapsed ? (
        <HostsToggle onExpand={actions.toggleHosts} />
      ) : (
        <MemoHosts
          hosts={state.hosts}
          activeSid={state.activeSid}
          gaps={state.gaps}
          selectedHostId={state.selectedHostId}
          storage={state.storage}
          onSelect={handleSelect}
          onAdd={handleAdd}
          onOpenTab={handleOpenTab}
          onNewTab={handleNewTabFor}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onCollapse={actions.toggleHosts}
        />
      )}
      <main style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Tabs
          tabs={state.tabs}
          sessions={state.sessions}
          hosts={state.hosts}
          activeSid={state.activeSid}
          onSelect={actions.setActiveSid}
          onClose={handleCloseTab}
          onNew={handleNewTab}
        />
        <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', position: 'relative' }}>
          {state.activeSid !== null ? (
            <Terminal sid={state.activeSid} />
          ) : (
            <div style={{ margin: 'auto', padding: '0 24px', textAlign: 'center' }}>
              <div style={{ fontSize: '14px', color: 'var(--dsw-alias-label-secondary)' }}>{t('noSession')}</div>
              <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-quaternary)' }}>{t('noSessionHint')}</div>
            </div>
          )}
        </div>
      </main>
      {state.chatOpen ? <MemoChatPane /> : <ChatToggle />}
      {/**
       * 两条拖拽边界。收起态的窄条（36px）是固定宽度，没有把手。
       * 左边界用 left 定位、右边界用 right 定位——右栏贴容器右沿，用 right
       * 就不依赖 viewport 测量，窗口变化时把手不会慢半帧。
       */}
      {state.hostsCollapsed ? null : (
        <SplitHandle
          side="hosts"
          left={cols.hosts}
          onStart={handleHostsDragStart}
          onDrag={handleHostsDrag}
          onEnd={handleDragEnd}
        />
      )}
      {state.chatOpen ? (
        <SplitHandle
          side="chat"
          right={cols.chat}
          onStart={handleChatDragStart}
          onDrag={handleChatDrag}
          onEnd={handleDragEnd}
        />
      ) : null}
      <HostForm />
      {state.toast !== null ? (
        <div
          role="status"
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '28px',
            transform: 'translateX(-50%)',
            padding: '8px 14px',
            borderRadius: '8px',
            fontSize: '12px',
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-3)',
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.28)',
          }}
        >
          {state.toast.text}
        </div>
      ) : null}
    </div>
  );
}
