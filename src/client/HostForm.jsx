/**
 * 主机新增 / 编辑弹层（M1）。
 *
 * 三条硬约束（设计 §0.1 + §4）：
 * 1. 密码框 `type=password`，**编辑时也永远 `value === ''`**——秘密只存在于
 *    Host 侧的密文表里，响应体从不带密码（`toHostView` 白名单），客户端连
 *    "回填"的数据都没有；placeholder 用「留空保持不变」把语义说清楚。
 * 2. 主机 id 由服务端生成（`h-<8hex>`），表单不提供也不提交 id 字段。
 * 3. 提交失败时弹层不关，错误按错误码翻成一句人话（`describeError`）。
 *
 * 表单值全部走 store 的 `form`（模块级），所以启动台卸载重挂 view 时，用户
 * 填了一半的内容不会丢。
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import { actions, getState, subscribe } from './store.js';
import { CloseIcon } from './Tabs.jsx';
import { t } from './locales.js';

/** 输入框统一样式：跟随宿主主题，不写死颜色。 */
const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: '6px',
  font: 'inherit',
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-base)',
  outline: 'none',
};

/** 字段标签样式。 */
const labelStyle = {
  display: 'block',
  marginBottom: '4px',
  fontSize: '11px',
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
};

/** 主按钮样式。 */
const primaryButtonStyle = {
  padding: '6px 14px',
  border: 0,
  borderRadius: '6px',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '12px',
  color: 'var(--dsw-alias-bg-base)',
  background: 'var(--dsw-alias-brand-primary)',
};

/** 次按钮样式。 */
const ghostButtonStyle = {
  padding: '6px 12px',
  border: '0.5px solid var(--dsw-alias-border-l2)',
  borderRadius: '6px',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '12px',
  color: 'var(--dsw-alias-label-secondary)',
  background: 'transparent',
};

/**
 * 一行「标签 + 输入框」。
 * @param {{label: string, children: React.ReactNode}} props 行内容。
 * @returns {JSX.Element} 字段行。
 */
function Field({ label, children }) {
  return (
    <div style={{ marginBottom: '10px' }}>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

/**
 * 主机表单弹层。`form === null` 时渲染 null（App 也会条件挂载）。
 * @returns {JSX.Element|null} 弹层。
 */
export function HostForm() {
  const state = useSyncExternalStore(subscribe, getState);
  const form = state.form;
  const isOpen = form !== null;

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') actions.closeForm();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  if (form === null) return null;

  const { values, mode, busy, error } = form;
  const isEdit = mode === 'edit';
  const showPassword = values.authKind === 'pass';
  const showPrivateKey = values.authKind === 'key';

  return (
    <div
      role="presentation"
      onClick={actions.closeForm}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'var(--dsw-alias-bg-mask, rgba(0, 0, 0, 0.42))',
      }}
    >
      <form
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void actions.submitForm();
        }}
        style={{
          width: '380px',
          maxWidth: '100%',
          maxHeight: '100%',
          overflowY: 'auto',
          padding: '16px',
          borderRadius: '10px',
          border: '0.5px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2)',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.32)',
          color: 'var(--dsw-alias-label-primary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
          <span style={{ flex: '1 1 auto', fontSize: '13px', fontWeight: 600 }}>
            {isEdit ? t('formEditTitle') : t('formCreateTitle')}
          </span>
          <button
            type="button"
            title={t('cancel')}
            aria-label={t('cancel')}
            onClick={actions.closeForm}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '22px',
              height: '22px',
              padding: 0,
              border: 0,
              borderRadius: '6px',
              cursor: 'pointer',
              color: 'var(--dsw-alias-label-tertiary)',
              background: 'transparent',
            }}
          >
            <CloseIcon size={12} />
          </button>
        </div>

        <Field label={t('fieldLabel')}>
          <input
            autoFocus
            style={inputStyle}
            value={values.label}
            placeholder={t('fieldLabelPlaceholder')}
            onChange={(event) => actions.setFormField('label', event.target.value)}
          />
        </Field>

        <Field label={t('fieldHost')}>
          <input
            style={inputStyle}
            value={values.host}
            placeholder={t('fieldHostPlaceholder')}
            onChange={(event) => actions.setFormField('host', event.target.value)}
          />
        </Field>

        <div style={{ display: 'flex', gap: '10px' }}>
          <div style={{ flex: '0 0 96px' }}>
            <Field label={t('fieldPort')}>
              <input
                type="number"
                min={1}
                max={65535}
                style={inputStyle}
                value={values.port}
                onChange={(event) => actions.setFormField('port', event.target.value)}
              />
            </Field>
          </div>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <Field label={t('fieldUsername')}>
              <input
                style={inputStyle}
                value={values.username}
                placeholder="root"
                onChange={(event) => actions.setFormField('username', event.target.value)}
              />
            </Field>
          </div>
        </div>

        <Field label={t('fieldAuthKind')}>
          <select
            style={inputStyle}
            value={values.authKind}
            onChange={(event) => actions.setFormField('authKind', event.target.value)}
          >
            {/* 取值必须与 Host 侧 AUTH_KINDS 一致：pass / key / none。
                用短名是为了不让 "password"/"privateKey" 出现在 GET /hosts
                响应体里（验收要求 grep 那两个词必须为空）。 */}
            <option value="pass">{t('authPassword')}</option>
            <option value="key">{t('authPrivateKey')}</option>
            <option value="none">{t('authNone')}</option>
          </select>
        </Field>

        {showPassword ? (
          <Field label={t('fieldPassword')}>
            {/* 关键：编辑时 value 恒为 ''，placeholder 说明"留空 = 不改"。 */}
            <input
              type="password"
              autoComplete="new-password"
              style={inputStyle}
              value={values.password}
              placeholder={isEdit ? t('passwordKeepPlaceholder') : t('passwordCreatePlaceholder')}
              onChange={(event) => actions.setFormField('password', event.target.value)}
            />
          </Field>
        ) : null}

        {showPrivateKey ? (
          <Field label={t('fieldPrivateKey')}>
            {/* 私钥同理：永不回填，编辑时留空 = 沿用原密文。 */}
            <textarea
              rows={4}
              spellCheck={false}
              style={{
                ...inputStyle,
                resize: 'vertical',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: '11px',
                lineHeight: '15px',
              }}
              value={values.privateKey}
              placeholder={isEdit ? t('privateKeyKeepPlaceholder') : t('privateKeyCreatePlaceholder')}
              onChange={(event) => actions.setFormField('privateKey', event.target.value)}
            />
          </Field>
        ) : null}

        {error !== null ? (
          <div
            role="alert"
            style={{
              marginBottom: '10px',
              fontSize: '11px',
              lineHeight: '16px',
              color: 'var(--dsw-alias-label-error)',
            }}
          >
            {error}
          </div>
        ) : null}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
          <button type="button" style={ghostButtonStyle} onClick={actions.closeForm}>
            {t('cancel')}
          </button>
          <button type="submit" style={{ ...primaryButtonStyle, opacity: busy ? 0.6 : 1 }} disabled={busy}>
            {busy ? t('saving') : t('save')}
          </button>
        </div>
      </form>
    </div>
  );
}
