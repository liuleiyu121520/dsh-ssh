/**
 * 应用视图：三栏骨架 + 多标签（设计 §2）。
 *
 * 左 220px 主机列表 / 中 flex:1（标签条 + 终端）/ 右 360px 可折叠上下文卡。
 * 高度撑满父容器——启动台协议 §5 明确容器已处理高度与滚动，应用绝不写
 * height:100vh，也不加顶部避让。
 *
 * 与启动台的耦合只剩启动台协议承诺的 props（v1.2）：
 * - `active`  视图可见性。隐藏时停轮询、回来再开——协议 §5 要求靠它降频，
 *   而不是去读根元素的 hidden 属性；
 * - `onTeardown(handler)`  关标签 / 启动台卸载前**同步**通知一次，我们借此
 *   关掉全部 SSH 连接与终端 runtime（不接的后果：连接变成看不见的孤儿）。
 *
 * 其余数据一律走模块级 store，所以本组件可以被独立渲染、独立单测。
 */
import React, { useCallback, useEffect, useSyncExternalStore } from 'react';
import { actions, getState, subscribe } from './store.js';
import { Hosts, HostsToggle } from './Hosts.jsx';
import { Tabs } from './Tabs.jsx';
import { Terminal } from './Terminal.jsx';
import { ChatPane, ChatToggle } from './ChatPane.jsx';
import { HostForm } from './HostForm.jsx';
import { t } from './locales.js';

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
    // 销毁通知（v1.2）：关标签或启动台卸载时，把连接与 runtime 全部收干净。
    // handler 同步执行，所以 teardownAll 里只有本地操作，网络请求走
    // fire-and-forget——关闭动画不该等 HTTP。
    if (typeof onTeardown !== 'function') return undefined;
    return onTeardown((detail) => {
      actions.teardownAll(typeof detail?.reason === 'string' ? detail.reason : '');
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
   * 双击主机 / 点「+ 标签」：连接（已有会话则聚焦，没有就新开）。
   * @param {string} hostId Host id。
   * @returns {void}
   */
  const handleOpenTab = useCallback((hostId) => {
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
      }}
    >
      {state.hostsCollapsed ? (
        <HostsToggle onExpand={actions.toggleHosts} />
      ) : (
        <Hosts
          hosts={state.hosts}
          activeSid={state.activeSid}
          gaps={state.gaps}
          selectedHostId={state.selectedHostId}
          onSelect={handleSelect}
          onAdd={handleAdd}
          onOpenTab={handleOpenTab}
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
      {state.chatOpen ? <ChatPane /> : <ChatToggle />}
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
