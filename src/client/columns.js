/**
 * 三栏几何：左（主机）/ 中（终端）/ 右（AI 助手）的宽度解算。
 *
 * 写法对齐 dsh 自身的 ui-layout（`packages/client/ui-layout/src/client/columns.ts`）：
 * - **偏好**（用户拖出来的宽度）与**实际宽度**分开——窗口变窄只做让步，
 *   不改偏好，窗口变宽后自动回到用户拖的位置；
 * - 让步顺序：右栏先缩 → 左栏再缩 → 最后才允许中栏低于下限；
 * - 拖拽时把偏好夹在本栏的 [MIN, MAX] 里（不夹的话拖过头会"粘住"：
 *   偏好存成 900、实际停在 420，回拖要先走完 480px 才开始动）。
 *
 * 纯函数、无 DOM 依赖，单测直接覆盖（tests/columns.test.js）。
 */

/** 左栏默认宽度（px）：与加宽前的固定值一致，视觉上不跳。 */
export const HOSTS_DEFAULT = 220;
/** 左栏拖拽下限：再窄主机名和 IP 就全成省略号了。 */
export const HOSTS_MIN = 170;
/** 左栏拖拽上限。 */
export const HOSTS_MAX = 420;
/** 右栏默认宽度（px）：与加宽前的固定值一致。 */
export const CHAT_DEFAULT = 360;
/** 右栏拖拽下限：再窄输入框和"停止/发送"会被挤成竖排。 */
export const CHAT_MIN = 280;
/** 右栏拖拽上限。 */
export const CHAT_MAX = 760;
/** 中栏（终端）受保护的宽度：左右两栏让到这个值就不再让。 */
export const CENTER_MIN = 320;

/**
 * 把一个宽度夹进区间（取整）。
 * @param {number} px 期望宽度。
 * @param {number} min 下限。
 * @param {number} max 上限。
 * @returns {number} 夹好的宽度；`px` 不是有限数时给下限。
 */
export function clampWidth(px, min, max) {
  if (!Number.isFinite(px)) return min;
  return Math.min(max, Math.max(min, Math.round(px)));
}

/**
 * 解算一帧的三栏宽度。
 * @param {number} viewport 容器可用宽度（px）；测量前传 0。
 * @param {number} hosts 左栏偏好宽度。
 * @param {number} chat 右栏偏好宽度。
 * @returns {{hosts: number, chat: number, center: number}} 实际宽度；三项之和等于 viewport（除非容器比三个下限还窄）。
 */
export function solveColumns(viewport, hosts, chat) {
  const h = clampWidth(hosts, HOSTS_MIN, HOSTS_MAX);
  const c = clampWidth(chat, CHAT_MIN, CHAT_MAX);
  // 还没量到容器宽度：先用偏好，中栏交给 flex 去撑（首帧，一帧后就被修正）。
  if (!(viewport > 0)) return { hosts: h, chat: c, center: 0 };

  const room = viewport - CENTER_MIN;
  if (h + c <= room) return { hosts: h, chat: c, center: viewport - h - c };

  // 右栏先让步，让到下限为止。
  const chatFit = Math.max(CHAT_MIN, room - h);
  // 左栏再让步，同样止于下限。
  const hostsFit = Math.max(HOSTS_MIN, room - chatFit);
  return { hosts: hostsFit, chat: chatFit, center: Math.max(0, viewport - hostsFit - chatFit) };
}

/**
 * 拖某一栏时允许的宽度上限：本栏 MAX 与"给中栏留够下限后的剩余空间"取小。
 *
 * 拖拽写偏好时用它，而不是只用 MAX——否则容器不够宽时偏好会存到一个
 * 渲染不出来的值，把手从鼠标底下脱开。
 * @param {'hosts'|'chat'} side 拖的是哪一栏。
 * @param {number} viewport 容器可用宽度（px）。
 * @param {{hosts: number, chat: number}} cols 当前实际宽度。
 * @returns {number} 该栏此刻的宽度上限。
 */
export function dragCeiling(side, viewport, cols) {
  const other = side === 'hosts' ? cols.chat : cols.hosts;
  const contractMax = side === 'hosts' ? HOSTS_MAX : CHAT_MAX;
  const contractMin = side === 'hosts' ? HOSTS_MIN : CHAT_MIN;
  if (!(viewport > 0)) return contractMax;
  return Math.max(contractMin, Math.min(contractMax, viewport - CENTER_MIN - other));
}
