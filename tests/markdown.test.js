/**
 * markdown 解析回归：面板"没有折行"的根因与修复。
 *
 * 2026-10-24 用户反馈：右栏回复"完全也没有折行等信息"。旧实现把整段文本塞进
 * 一个 `<span>`，HTML 折叠换行 → 多行回复变成一整坨。现在解析成块，段落/列表
 * 项用 white-space: pre-wrap 渲染，块之间用 flex gap 分隔。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkdown } from '../src/client/markdown.js';

test('paragraph keeps hard line breaks as separate lines', () => {
  const blocks = parseMarkdown('第一行\n第二行\n第三行');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'paragraph');
  assert.deepEqual(blocks[0].lines, ['第一行', '第二行', '第三行']);
});

test('blank line splits paragraphs', () => {
  const blocks = parseMarkdown('第一段\n\n第二段');
  assert.deepEqual(blocks.map((block) => block.kind), ['paragraph', 'paragraph']);
  assert.deepEqual(blocks[0].lines, ['第一段']);
  assert.deepEqual(blocks[1].lines, ['第二段']);
});

test('fenced code block keeps its own newlines and lang', () => {
  const blocks = parseMarkdown('看这个：\n```bash\ndf -h\ndu -sh *\n```\n完事');
  assert.deepEqual(blocks.map((block) => block.kind), ['paragraph', 'code', 'paragraph']);
  assert.equal(blocks[1].lang, 'bash');
  assert.equal(blocks[1].text, 'df -h\ndu -sh *');
});

test('unclosed fence runs to the end instead of swallowing nothing', () => {
  const blocks = parseMarkdown('```\nline1\nline2');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'code');
  assert.equal(blocks[0].text, 'line1\nline2');
});

test('bullet list groups consecutive items and stops at a blank line', () => {
  const blocks = parseMarkdown('- 一\n- 二\n\n结束');
  assert.deepEqual(blocks.map((block) => block.kind), ['list', 'paragraph']);
  assert.equal(blocks[0].ordered, false);
  assert.deepEqual(blocks[0].items, ['一', '二']);
});

test('ordered list keeps its own marker type', () => {
  const blocks = parseMarkdown('1. 先看磁盘\n2. 再看日志');
  assert.equal(blocks[0].kind, 'list');
  assert.equal(blocks[0].ordered, true);
  assert.deepEqual(blocks[0].items, ['先看磁盘', '再看日志']);
});

test('indented continuation joins the previous item with a newline', () => {
  const blocks = parseMarkdown('- 第一条\n  补充说明\n- 第二条');
  assert.deepEqual(blocks[0].items, ['第一条\n补充说明', '第二条']);
});

test('heading levels are preserved', () => {
  const blocks = parseMarkdown('## 结论\n正文');
  assert.equal(blocks[0].kind, 'heading');
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[0].text, '结论');
  assert.equal(blocks[1].kind, 'paragraph');
});

test('quote block is its own kind', () => {
  const blocks = parseMarkdown('> 注意：这会重启服务');
  assert.equal(blocks[0].kind, 'quote');
  assert.equal(blocks[0].text, '注意：这会重启服务');
});

test('inline markers are left for the renderer', () => {
  // 解析层不拆 `code` / **bold**：拆了就没法在 JSX 里还原成元素。
  const blocks = parseMarkdown('用 `df -h` 看，**别**用 rm');
  assert.deepEqual(blocks[0].lines, ['用 `df -h` 看，**别**用 rm']);
});

test('empty input yields no blocks', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('   \n\n'), []);
});

test('gfm table becomes a table block with alignment', () => {
  const blocks = parseMarkdown([
    '| ID | 项目 | 内存 |',
    '|:--|:--:|--:|',
    '| 0 | fasong-service | 87.8 MB |',
    '| 1 | picture-service | 86.3 MB |',
  ].join('\n'));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'table');
  assert.deepEqual(blocks[0].header, ['ID', '项目', '内存']);
  assert.deepEqual(blocks[0].align, ['left', 'center', 'right']);
  assert.deepEqual(blocks[0].rows[0], ['0', 'fasong-service', '87.8 MB']);
  assert.equal(blocks[0].rows.length, 2);
});

test('table rows are padded or trimmed to the header width', () => {
  const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |');
  assert.deepEqual(blocks[0].rows, [['1', ''], ['1', '2']]);
});

test('a pipe line without a divider row stays a paragraph', () => {
  const blocks = parseMarkdown('用 `a | b` 这种写法\n不构成表格');
  assert.equal(blocks[0].kind, 'paragraph');
});

test('table ends at a blank line and the next block parses normally', () => {
  const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n结论：正常');
  assert.deepEqual(blocks.map((block) => block.kind), ['table', 'paragraph']);
  assert.deepEqual(blocks[1].lines, ['结论：正常']);
});
