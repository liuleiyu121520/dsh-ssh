/**
 * 文案：中英双份字面量。
 *
 * M0 组件里直接 `t('key')` 取中文；en 字典与注册调用位（见 launchpad.js）
 * 先备好，M1 把组件字面量换成 ctx.locale 命名空间时零迁移成本。
 * 只做 {param} 插值，不引入 ICU——启动台卡片与三栏骨架用不到复数规则。
 */

/** 简体中文（M0 实际展示语言）。 */
export const zh = {
  subtitle: '远程终端',
  hosts: '主机',
  addHost: '+ 添加主机',
  addHostSoon: '主机管理将在下个版本提供',
  statusOpen: '已连接',
  statusConnecting: '连接中',
  statusClosed: '已关闭',
  statusError: '连接失败',
  statusOffline: '未连接',
  replayGap: '回放缺口',
  noSession: '尚未建立会话',
  noSessionHint: '插件激活时会自动连接 cordis.patch.yml 里配置的主机',
  terminal: '终端',
  chat: '对话栏',
  collapse: '收起',
  expand: '展开',
  chatPlaceholderTitle: '对话栏 · 后续版本接入原生会话',
  chatPlaceholderBody: '这里将嵌入 dsh 原生对话（conversation.content，embedded），输入框、流式与工具卡片全是原生的。',
  loading: '加载中…',

  // ── 多标签（M1）──
  tabNew: '新建标签',
  tabClose: '关闭标签',
  tabs: '会话标签',
  noHostForTab: '先添加一台主机，再开标签',

  // ── 主机行内操作（M1）──
  hostOpenTab: '开标签',
  hostEdit: '编辑',
  hostDelete: '删除',
  deleteHostConfirm: '确认删除该主机？',
  deleteHostDetail: '会先关闭它的全部会话，密码也一并删除',
  confirmDelete: '确认删除',
  cancel: '取消',

  // ── 主机表单（M1）──
  formCreateTitle: '添加主机',
  formEditTitle: '编辑主机',
  fieldLabel: '名称',
  fieldLabelPlaceholder: '例如：生产机',
  fieldHost: '主机地址',
  fieldHostPlaceholder: '例如：10.0.0.12',
  fieldPort: '端口',
  fieldUsername: '用户名',
  fieldAuthKind: '认证方式',
  fieldPassword: '密码',
  passwordKeepPlaceholder: '留空保持不变',
  passwordCreatePlaceholder: '仅保存在本机，加密落盘',
  fieldPrivateKey: '私钥',
  privateKeyKeepPlaceholder: '留空保持不变',
  privateKeyCreatePlaceholder: '粘贴 OpenSSH 私钥内容（以 -----BEGIN 开头）',
  authPassword: '密码',
  authPrivateKey: '私钥',
  authNone: '免密（主机已授权 / SSH Agent）',
  save: '保存',
  saving: '保存中…',
  hostSaved: '主机已保存',
  hostDeleted: '主机已删除',

  // ── 右栏上下文卡（M3 方案 A）──
  contextTitle: '会话上下文',
  contextSubtitle: '把这块交给模型，它就知道你屏幕上发生了什么',
  contextEmpty: '暂无上下文',
  contextUnavailable: '暂无上下文',
  contextUnavailableHint: '上下文接口尚未就绪，不影响终端使用',
  contextTail: '最后 12 行输出',
  contextSuggestions: '建议指令',
  contextRefresh: '刷新',
  contextGap: '回放缺口',
  suggestion1: '解释屏幕上最后一段输出，并给出下一步该敲的命令',
  suggestion2: '找出这段输出里的报错原因，给出最小修复方案',
  suggestion3: '根据当前目录和进程状态，写一条健康检查命令',
  copied: '已复制到剪贴板',

  // ── 右栏 AI 助手（对话 → 读面板 → 生成命令 → 执行）──
  chatTitle: 'AI 助手',
  chatSubtitle: '大白话指挥它：看终端、跑命令、出结论',
  chatPlaceholder: '例如：看看现在磁盘占用，告诉我谁在吃空间',
  chatSend: '发送',
  chatStop: '停止',
  chatThinking: '思考中…',
  chatRunning: '执行中…',
  chatAutoExec: '自动执行',
  chatAutoExecOn: '自动执行：开（命令将直接运行）',
  chatAutoExecOff: '自动执行：关（每条命令等你确认）',
  chatModel: '模型',
  chatModelAuto: '自动选择',
  chatRun: '执行',
  chatSkip: '跳过',
  chatRunning2: '执行中',
  chatDone: '已完成',
  chatFailed: '执行失败',
  chatSkipped: '已跳过',
  chatTimeout: '超时已中断',
  chatOutput: '输出',
  chatYou: '你',
  chatAssistant: '助手',
  chatNoLlm: '宿主没有可用的模型服务',
  chatNoLlmHint: '在 dsh 里配置模型（设置 → 模型）后，这里就能对话了',
  chatNoSessionHint: '先连上一台主机，助手才能帮你操作终端',
  chatError: '出错了：{message}',
  chatUserSkipped: '用户跳过了这条命令的执行',
  chatSuggestHint: '试试这些：',
  chatAutoSwitched: '这条通道调用失败，已自动切到：{model}',
  chatNoHealthy: '这个通道调用失败，且没有其它可用通道——请在"模型"里换一个',
  chatWatchdog: '等待模型响应超时（3 分钟没有任何动静），请重试或切换模型',
  chatReasoning: '思考过程',
  chatSlow: '模型还在思考（已超过 60 秒），继续等待或点"停止"换模型',
  chatRetrying: '通道抖动，正在重试（{attempt}/{max}）…',
  chatPendingHint: '先处理上方的命令卡（执行或跳过），才能继续发消息',
  hostsCollapse: '收起主机列表',
  hostsExpand: '展开主机列表',

  // ── 错误提示（按设计 §7.3 的错误码）──
  errorInvalidHost: '主机信息不合法，请检查地址、端口与用户名',
  errorDuplicateHost: '这台主机已经存在',
  errorUnknownHost: '主机不存在，可能已被删除',
  errorUnknownSession: '会话不存在，可能已经结束',
  errorStorageUnavailable: '存储不可用：当前未启用持久化主机表',
  errorVaultUnavailable: '凭据服务不可用，无法读取密码',
  errorDecryptFailed: '密码解密失败，请重新填写',
  errorTransferDisabled: '文件传输未开启',
  errorPathOutsideRoot: '路径超出允许范围',
  errorGeneric: '操作失败：{message}',
};

/** English fallback (wired up in M1). */
export const en = {
  subtitle: 'Remote terminal',
  hosts: 'Hosts',
  addHost: '+ Add host',
  addHostSoon: 'Host management arrives in the next release',
  statusOpen: 'Connected',
  statusConnecting: 'Connecting',
  statusClosed: 'Closed',
  statusError: 'Connection failed',
  statusOffline: 'Offline',
  replayGap: 'Replay gap',
  noSession: 'No session yet',
  noSessionHint: 'The plugin auto-connects the host configured in cordis.patch.yml on activation',
  terminal: 'Terminal',
  chat: 'Chat',
  collapse: 'Collapse',
  expand: 'Expand',
  chatPlaceholderTitle: 'Chat pane - native conversation lands in a later release',
  chatPlaceholderBody: 'This slot will embed the native dsh conversation (conversation.content, embedded): composer, streaming and tool cards included.',
  loading: 'Loading...',

  // Tabs (M1)
  tabNew: 'New tab',
  tabClose: 'Close tab',
  tabs: 'Session tabs',
  noHostForTab: 'Add a host first, then open a tab',

  // Host row actions (M1)
  hostOpenTab: 'Open tab',
  hostEdit: 'Edit',
  hostDelete: 'Delete',
  deleteHostConfirm: 'Delete this host?',
  deleteHostDetail: 'All of its sessions are closed first and the stored password is removed',
  confirmDelete: 'Delete',
  cancel: 'Cancel',

  // Host form (M1)
  formCreateTitle: 'Add host',
  formEditTitle: 'Edit host',
  fieldLabel: 'Name',
  fieldLabelPlaceholder: 'e.g. production',
  fieldHost: 'Host address',
  fieldHostPlaceholder: 'e.g. 10.0.0.12',
  fieldPort: 'Port',
  fieldUsername: 'Username',
  fieldAuthKind: 'Authentication',
  fieldPassword: 'Password',
  passwordKeepPlaceholder: 'Leave blank to keep the current one',
  passwordCreatePlaceholder: 'Stored locally, encrypted at rest',
  fieldPrivateKey: 'Private key',
  privateKeyKeepPlaceholder: 'Leave blank to keep the current one',
  privateKeyCreatePlaceholder: 'Paste the OpenSSH private key (starts with -----BEGIN)',
  authPassword: 'Password',
  authPrivateKey: 'Private key',
  authNone: 'No secret (host-authorized key / SSH agent)',
  save: 'Save',
  saving: 'Saving...',
  hostSaved: 'Host saved',
  hostDeleted: 'Host deleted',

  // Context card (M3 option A)
  contextTitle: 'Session context',
  contextSubtitle: 'Hand this to the model so it knows what is on your screen',
  contextEmpty: 'No context yet',
  contextUnavailable: 'No context yet',
  contextUnavailableHint: 'The context endpoint is not ready yet; the terminal still works',
  contextTail: 'Last 12 lines of output',
  contextSuggestions: 'Suggested prompts',
  contextRefresh: 'Refresh',
  contextGap: 'Replay gap',
  suggestion1: 'Explain the last block of output and tell me the next command to run',
  suggestion2: 'Find the root cause of the error in this output and give the minimal fix',
  suggestion3: 'Write a health check command based on the current directory and processes',
  copied: 'Copied to clipboard',

  chatTitle: 'AI Assistant',
  chatSubtitle: 'Talk to it in plain language: read the terminal, run commands, get answers',
  chatPlaceholder: 'e.g. check disk usage and tell me what is eating space',
  chatSend: 'Send',
  chatStop: 'Stop',
  chatThinking: 'Thinking…',
  chatRunning: 'Running…',
  chatAutoExec: 'Auto-run',
  chatAutoExecOn: 'Auto-run: ON (commands run immediately)',
  chatAutoExecOff: 'Auto-run: OFF (each command waits for you)',
  chatModel: 'Model',
  chatModelAuto: 'Auto',
  chatRun: 'Run',
  chatSkip: 'Skip',
  chatRunning2: 'Running',
  chatDone: 'Done',
  chatFailed: 'Failed',
  chatSkipped: 'Skipped',
  chatTimeout: 'Timed out',
  chatOutput: 'Output',
  chatYou: 'You',
  chatAssistant: 'Assistant',
  chatNoLlm: 'No model service available in the host',
  chatNoLlmHint: 'Configure a model in dsh (Settings → Models) and this panel comes alive',
  chatNoSessionHint: 'Connect a host first so the assistant can drive your terminal',
  chatError: 'Error: {message}',
  chatUserSkipped: 'User skipped this command',
  chatSuggestHint: 'Try:',
  chatAutoSwitched: 'This channel failed; switched to: {model}',
  chatNoHealthy: 'This channel failed and no other channel is available. Pick another model above',
  chatWatchdog: 'Timed out waiting for the model (3 minutes of total silence). Retry or switch models',
  chatReasoning: 'Thinking',
  chatSlow: 'The model is still thinking (over 60s). Keep waiting, or press Stop and switch models',
  chatRetrying: 'Channel hiccup, retrying ({attempt}/{max})…',
  chatPendingHint: 'Resolve the command card above (Run or Skip) before sending another message',
  hostsCollapse: 'Collapse hosts',
  hostsExpand: 'Expand hosts',

  // Errors (design §7.3 codes)
  errorInvalidHost: 'Invalid host: check address, port and username',
  errorDuplicateHost: 'This host already exists',
  errorUnknownHost: 'Host not found, it may have been deleted',
  errorUnknownSession: 'Session not found, it may have ended',
  errorStorageUnavailable: 'Storage unavailable: no persistent host table in this build',
  errorVaultUnavailable: 'Credential service unavailable, cannot read the password',
  errorDecryptFailed: 'Failed to decrypt the password, please enter it again',
  errorTransferDisabled: 'File transfer is disabled',
  errorPathOutsideRoot: 'Path is outside the allowed root',
  errorGeneric: 'Request failed: {message}',
};

/** 注册给 ctx.locale 的两份字典。 */
export const messages = { zh, en };

/** 当前语言。M0 固定中文；M1 起由 ctx.locale 驱动。 */
let current = 'zh';

/**
 * 取一条文案。
 * @param {string} key 字典键。
 * @param {Record<string, string|number>} [params] {name} 占位替换。
 * @returns {string} 文案；键缺失时原样返回 key，方便定位漏翻。
 */
export function t(key, params) {
  const table = current === 'en' ? en : zh;
  const raw = table[key] ?? key;
  if (params === undefined) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

/**
 * 切换语言（M1 由 ctx.locale 的 change 事件调用）。
 * @param {'zh'|'en'} locale 语言码。
 * @returns {void}
 */
export function setLocale(locale) {
  current = locale === 'en' ? 'en' : 'zh';
}
