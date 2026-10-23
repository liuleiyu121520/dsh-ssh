/**
 * 应用视图：三栏骨架 + 多标签（设计 §2）。
 *
 * 左 220px 主机列表 / 中 flex:1（标签条 + 终端）/ 右 360px 可折叠上下文卡。
 * 高度撑满父容器——启动台协议 §5 明确容器已处理高度与滚动，应用绝不写
 * height:100vh，也不加顶部避让。
 *
 * 本组件与启动台彻底解耦：props 只用 `active`（v1.1 草案的可见性信号），
 * 数据一律走模块级 store。因此它可以被独立渲染、独立单测。
 */
import React, { useCallback, useEffect, useSyncExternalStore } from 'react';
import { actions, getState, subscribe } from './store.js';
import { Hosts } from './Hosts.jsx';
import { Tabs } from './Tabs.jsx';
import { Terminal } from './Terminal.jsx';
import { ChatPane, ChatToggle } from './ChatPane.jsx';
import { HostForm } from './HostForm.jsx';
import { t } from './locales.js';

/**
 * SSH 应用视图。
 * @param {{active?: boolean}} props 启动台注入的 props（M0 只用得到 active）。
 * @returns {JSX.Element} 三栏布局。
 */
export function SshAppView({ active: _active = true } = {}) {
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

  /**
   * 点左栏某一行：
   * - 该主机已经有会话 → 选中它（若还没标签，补一个：模型侧工具开的会话
   *   第一次出现在轮询结果里时就是这种情形）；
   * - 还没有会话 → 直接开一个新标签，别让用户点了个寂寞。
   * @param {object} host HostView。
   * @returns {void}
   */
  const handleSelect = useCallback((host) => {
    const sid = host?.sid ?? null;
    if (sid === null) {
      void actions.openSession(host?.id ?? '');
      return;
    }
    actions.ensureTab(sid);
    actions.setActiveSid(sid);
  }, []);

  const handleCloseTab = useCallback((sid) => {
    void actions.closeSession(sid);
  }, []);

  const handleNewTab = useCallback(() => {
    void actions.openNewTab();
  }, []);

  const handleOpenTab = useCallback((hostId) => {
    void actions.openSession(hostId);
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
      <Hosts
        hosts={state.hosts}
        activeSid={state.activeSid}
        gaps={state.gaps}
        onSelect={handleSelect}
        onAdd={handleAdd}
        onOpenTab={handleOpenTab}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
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
