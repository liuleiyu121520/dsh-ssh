/**
 * `src/client/chatStore.js` 的 node --test 测试。
 *
 * 这一层的价值全在"重载之后还能接着聊"，所以断言都盯着三件事：
 * 1. **往返**：存进去的消息原样读回来（含命令卡的状态与结果）；
 * 2. **封口**：重载时正在流式的那条回合必须被标 interrupted 且不再转圈；
 * 3. **history 合法**：执行到一半的命令要补一条 tool 结果，否则下一轮请求
 *    会因为"有 tool-call 没有 tool 结果"被 wire 校验打回。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHAT_INDEX_KEY, CHAT_KEY_PREFIX, MAX_STORED_MESSAGES, MAX_STORED_SESSIONS,
  dropChat, loadAllChats, restoreChatState, saveChat, trimForStorage,
} from '../src/client/chatStore.js';

/** 内存版 Storage（只实现用到的那三个方法）。 */
class FakeStorage {
  constructor() {
    this.map = new Map();
    this.failNextSet = false;
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    if (this.failNextSet === true) {
      this.failNextSet = false;
      throw new Error('QuotaExceededError');
    }
    this.map.set(key, String(value));
  }

  removeItem(key) {
    this.map.delete(key);
  }
}

/** 一条用户消息。 */
const userMessage = (text) => ({ role: 'user', content: text });

/** 一条 assistant 回合（默认带一段正文）。 */
const turnMessage = (text, extra = {}) => ({ role: 'assistant', kind: 'turn', text, calls: [], ...extra });

/** 一张命令卡。 */
const callCard = (id, extra = {}) => ({
  id,
  name: 'run_command',
  command: `echo ${id}`,
  arguments: `{"command":"echo ${id}"}`,
  status: 'done',
  ok: true,
  output: 'ok',
  timedOut: false,
  resultContent: 'ok',
  resultError: false,
  ...extra,
});

test('saveChat → loadAllChats：消息原样往返', () => {
  const storage = new FakeStorage();
  const messages = [userMessage('看看磁盘'), turnMessage('先看一眼', { calls: [callCard('c1')] })];
  saveChat(storage, 'sid-a', messages);

  const chats = loadAllChats(storage);
  // 唯一的差别是回合被显式封口（streaming: false）——恢复态不该有在途标记。
  assert.deepEqual(chats['sid-a'].messages, [
    messages[0],
    { ...messages[1], streaming: false },
  ]);
  assert.equal(chats['sid-a'].streaming, false);
  assert.equal(chats['sid-a'].pending, false);
});

test('trimForStorage：条数与字符数双上限，都从最旧的丢', () => {
  const many = Array.from({ length: MAX_STORED_MESSAGES + 10 }, (_, i) => userMessage(`m${i}`));
  const trimmed = trimForStorage(many);
  assert.equal(trimmed.length, MAX_STORED_MESSAGES);
  assert.equal(trimmed.at(-1).content, `m${MAX_STORED_MESSAGES + 9}`);

  // 单条超长：字符预算比条数预算先触发，仍至少留一条。
  const huge = [userMessage('x'.repeat(200 * 1024))];
  assert.equal(trimForStorage(huge).length, 1);
});

test('saveChat：空历史等于删除（不写空数组、不占索引）', () => {
  const storage = new FakeStorage();
  saveChat(storage, 'sid-a', [userMessage('hi')]);
  assert.notEqual(storage.getItem(`${CHAT_KEY_PREFIX}sid-a`), null);

  saveChat(storage, 'sid-a', []);
  assert.equal(storage.getItem(`${CHAT_KEY_PREFIX}sid-a`), null);
  assert.deepEqual(JSON.parse(storage.getItem(CHAT_INDEX_KEY)), []);
});

test('dropChat：键与索引一起摘掉', () => {
  const storage = new FakeStorage();
  saveChat(storage, 'sid-a', [userMessage('a')]);
  saveChat(storage, 'sid-b', [userMessage('b')]);
  dropChat(storage, 'sid-a');
  assert.equal(storage.getItem(`${CHAT_KEY_PREFIX}sid-a`), null);
  assert.deepEqual(JSON.parse(storage.getItem(CHAT_INDEX_KEY)), ['sid-b']);
  assert.deepEqual(Object.keys(loadAllChats(storage)), ['sid-b']);
});

test('索引按写入顺序淘汰：只留最近 MAX_STORED_SESSIONS 个', () => {
  const storage = new FakeStorage();
  for (let i = 0; i < MAX_STORED_SESSIONS + 3; i += 1) {
    saveChat(storage, `sid-${i}`, [userMessage(`m${i}`)]);
  }
  const index = JSON.parse(storage.getItem(CHAT_INDEX_KEY));
  assert.equal(index.length, MAX_STORED_SESSIONS);
  assert.equal(index[0], `sid-${MAX_STORED_SESSIONS + 2}`);
  assert.equal(index.includes('sid-0'), false);
  assert.equal(Object.keys(loadAllChats(storage)).length, MAX_STORED_SESSIONS);
});

test('restoreChatState：流式回合被封口，标 interrupted 且不再 streaming', () => {
  const state = restoreChatState([
    userMessage('跑一下'),
    turnMessage('正在执行', { streaming: true, calls: [callCard('c1', { status: 'running', resultContent: undefined })] }),
  ], { interruptedResult: '结果未知' });

  assert.equal(state.interrupted, true);
  const turn = state.messages[1];
  assert.equal(turn.streaming, false);
  assert.equal(turn.interrupted, true);
  // running 的命令补一条"结果未知"的 tool 结果，history 才合法。
  assert.equal(turn.calls[0].status, 'failed');
  assert.equal(turn.calls[0].resultError, true);
  assert.equal(turn.calls[0].resultContent, '结果未知');
  assert.equal(state.pending, false);
});

test('restoreChatState：还有 awaiting 的命令就回到 pending（等用户点执行）', () => {
  const state = restoreChatState([
    userMessage('重启服务'),
    turnMessage('要我执行吗', { calls: [callCard('c1', { status: 'awaiting', ok: null, output: '', resultContent: undefined })] }),
  ], { interruptedResult: '结果未知' });

  assert.equal(state.pending, true);
  assert.equal(state.interrupted, false);
  assert.equal(state.messages[1].calls[0].status, 'awaiting');
});

test('restoreChatState：中间回合永远不带 interrupted，只有最后一条会', () => {
  const state = restoreChatState([
    turnMessage('第一轮', { streaming: false }),
    turnMessage('第二轮', { streaming: true }),
  ]);
  assert.equal(state.messages[0].interrupted, undefined);
  assert.equal(state.messages[1].interrupted, true);
});

test('restoreChatState：脏数据不炸（null / 缺字段 / 非数组）', () => {
  const state = restoreChatState([null, { role: 'user' }, { kind: 'turn' }, 42]);
  assert.equal(state.messages.length, 2);
  assert.deepEqual(state.messages[0], { role: 'user', content: '' });
  assert.deepEqual(state.messages[1].calls, []);
  assert.deepEqual(restoreChatState(undefined).messages, []);
});

test('quota 失败不抛出：淘汰旧会话后重试，仍失败就放弃', () => {
  const storage = new FakeStorage();
  saveChat(storage, 'sid-old', [userMessage('old')]);
  storage.failNextSet = true;
  // 第一次写失败 → 淘汰 → 重试成功。
  saveChat(storage, 'sid-new', [userMessage('new')]);
  assert.notEqual(storage.getItem(`${CHAT_KEY_PREFIX}sid-new`), null);

  // 存储彻底不可用：不能把调用方（右栏）打崩。
  const broken = new FakeStorage();
  broken.setItem = () => {
    throw new Error('nope');
  };
  assert.doesNotThrow(() => saveChat(broken, 'sid-x', [userMessage('x')]));
  assert.deepEqual(loadAllChats(null), {});
  assert.doesNotThrow(() => saveChat(null, 'sid-x', [userMessage('x')]));
});
