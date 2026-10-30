/**
 * `src/client/columns.js` 的 node --test 测试。
 *
 * 三栏几何是纯函数，但性质比"能算"重要得多：
 * 1. **永远不越界**：拖到 -9999 或 9999，结果都落在该栏的 [MIN, MAX] 里；
 * 2. **中栏优先**：容器不够宽时先让右栏、再让左栏，中栏拿到 CENTER_MIN 之前
 *    两侧不许再抢；
 * 3. **三项之和守恒**：解出来的 hosts + chat + center 必须正好等于容器宽度，
 *    否则 flex 会把某栏挤成 0（或者溢出被 overflow:hidden 切掉）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CENTER_MIN, CHAT_DEFAULT, CHAT_MAX, CHAT_MIN, HOSTS_DEFAULT, HOSTS_MAX, HOSTS_MIN,
  clampWidth, dragCeiling, solveColumns,
} from '../src/client/columns.js';

test('clampWidth：越界值夹回区间并取整', () => {
  assert.equal(clampWidth(-9999, HOSTS_MIN, HOSTS_MAX), HOSTS_MIN);
  assert.equal(clampWidth(9999, HOSTS_MIN, HOSTS_MAX), HOSTS_MAX);
  assert.equal(clampWidth(240.6, HOSTS_MIN, HOSTS_MAX), 241);
  assert.equal(clampWidth(Number.NaN, HOSTS_MIN, HOSTS_MAX), HOSTS_MIN);
});

test('solveColumns：宽容器下用偏好值，中栏吃掉剩余', () => {
  const cols = solveColumns(1200, HOSTS_DEFAULT, CHAT_DEFAULT);
  assert.deepEqual(cols, { hosts: 220, chat: 360, center: 620 });
});

test('solveColumns：偏好越界也夹在契约区间内', () => {
  const cols = solveColumns(2000, 5, 5000);
  assert.equal(cols.hosts, HOSTS_MIN);
  assert.equal(cols.chat, CHAT_MAX);
  assert.equal(cols.hosts + cols.chat + cols.center, 2000);
});

test('solveColumns：容器变窄时右栏先让步，左栏不动', () => {
  // 900 - 320 = 580 < 220 + 360 → 右栏从 360 缩到 360，左栏保持 220。
  const cols = solveColumns(900, 220, 360);
  assert.equal(cols.hosts, 220);
  assert.equal(cols.chat, 360);
  assert.equal(cols.center, 320);

  // 再窄一点：右栏缩到下限，左栏仍然不动。
  const tighter = solveColumns(820, 220, 360);
  assert.equal(tighter.hosts, 220);
  assert.equal(tighter.chat, CHAT_MIN);
  assert.equal(tighter.center, 320);
});

test('solveColumns：右栏到下限后左栏才让，中栏最后才低于下限', () => {
  const cols = solveColumns(700, 220, 360);
  assert.equal(cols.chat, CHAT_MIN);
  assert.equal(cols.hosts, HOSTS_MIN);
  assert.equal(cols.center, 700 - HOSTS_MIN - CHAT_MIN);

  // 比三个下限之和还窄：中栏归零，不许出现负数。
  const squeezed = solveColumns(400, 220, 360);
  assert.equal(squeezed.center, 0);
  assert.ok(squeezed.hosts + squeezed.chat >= 0);
});

test('solveColumns：测量前（viewport=0）先按偏好渲染', () => {
  const cols = solveColumns(0, 300, 420);
  assert.deepEqual(cols, { hosts: 300, chat: 420, center: 0 });
});

test('solveColumns：任意容器宽度下三栏之和守恒', () => {
  for (let viewport = 600; viewport <= 1600; viewport += 37) {
    for (const hosts of [HOSTS_MIN, 220, HOSTS_MAX]) {
      for (const chat of [CHAT_MIN, 360, CHAT_MAX]) {
        const cols = solveColumns(viewport, hosts, chat);
        assert.equal(
          cols.hosts + cols.chat + cols.center,
          viewport,
          `viewport=${viewport} hosts=${hosts} chat=${chat}`,
        );
        assert.ok(cols.hosts >= HOSTS_MIN && cols.hosts <= HOSTS_MAX);
        assert.ok(cols.chat >= CHAT_MIN && cols.chat <= CHAT_MAX);
        assert.ok(cols.center >= 0);
      }
    }
  }
});

test('dragCeiling：不超过契约上限，也不把中栏挤到下限以下', () => {
  const cols = { hosts: 220, chat: 360, center: 620 };
  // 容器 1200：左栏最多 1200 - 320 - 360 = 520 → 仍被 HOSTS_MAX 420 压住。
  assert.equal(dragCeiling('hosts', 1200, cols), HOSTS_MAX);
  // 容器 800：左栏最多 800 - 320 - 360 = 120 → 低于下限，给下限。
  assert.equal(dragCeiling('hosts', 800, cols), HOSTS_MIN);
  // 右栏：容器 1000 → 1000 - 320 - 220 = 460。
  assert.equal(dragCeiling('chat', 1000, cols), 460);
  // 未测量时退回契约上限，别把把手卡在最小值上。
  assert.equal(dragCeiling('chat', 0, cols), CHAT_MAX);
});
