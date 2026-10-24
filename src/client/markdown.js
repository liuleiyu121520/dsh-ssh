/**
 * 极简 markdown 解析：只做对话里真正会出现的那几种块。
 *
 * 为什么需要它：模型回复里的换行/列表/标题，如果只丢进一个 `<span>`，
 * HTML 会把所有换行折叠成空格——面板上就是"一整坨字，没有折行"
 * （2026-10-24 用户反馈）。这里把文本切成块，块内保留原始换行。
 *
 * 解析成**数据**而不是 JSX，是为了能在没有 DOM 的 node:test 里直接测
 * （见 tests/markdown.test.js）。渲染在 ChatPane.jsx。
 *
 * 支持的块：围栏代码块、ATX 标题、无序/有序列表、引用、段落（保留硬换行）。
 * 行内格式（`code`、**bold**）由渲染层处理，这里不拆。
 */

/** 围栏代码块的开头（```lang）。 */
const FENCE = /^\s*```([\w+#.-]*)\s*$/;
/** 围栏代码块的结尾。 */
const FENCE_END = /^\s*```\s*$/;
/** ATX 标题。 */
const HEADING = /^(#{1,6})\s+(.*)$/;
/** 无序列表项。 */
const BULLET = /^\s*[-*+]\s+(.*)$/;
/** 有序列表项。 */
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
/** 引用行。 */
const QUOTE = /^\s*>\s?(.*)$/;
/** 表格分隔行（| --- | :---: |）。 */
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * 把一行表格拆成单元格。
 * @param {string} line 表格行。
 * @returns {string[]} 单元格（已去首尾竖线与空白）。
 */
function splitRow(line) {
  // 转义的竖线先换成占位符，免得被当分隔符劈开。
  const text = line.replace(/\\\|/g, '\u0000');
  const trimmed = text.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.replace(/\u0000/g, '|').trim());
}

/**
 * 判断某一行是不是表格分隔行（决定上一行是不是表头）。
 * @param {string|undefined} line 下一行。
 * @returns {boolean} 是分隔行返回 true。
 */
function isTableDivider(line) {
  if (line === undefined || line.includes('|') === false) return false;
  return TABLE_DIVIDER.test(line);
}

/**
 * 分隔行 → 每列的对齐方式。
 * @param {string} line 分隔行。
 * @returns {Array<'left'|'center'|'right'|null>} 对齐方式。
 */
function parseAlign(line) {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

/**
 * 解析 markdown 文本为块数组。
 *
 * 块形状：
 * - `{kind:'code', lang, text}`
 * - `{kind:'heading', level, text}`
 * - `{kind:'list', ordered, items: string[]}`（items 里可能有 `\n` 续行）
 * - `{kind:'quote', text}`
 * - `{kind:'paragraph', lines: string[]}`（lines 逐行保留，渲染时硬换行）
 * @param {string} text 原文。
 * @returns {object[]} 块数组。
 */
export function parseMarkdown(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  /** @type {object[]} */
  const blocks = [];
  /** @type {string[]} */
  let paragraph = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', lines: paragraph });
    paragraph = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    const fence = line.match(FENCE);
    if (fence !== null) {
      flush();
      const body = [];
      index += 1;
      while (index < lines.length && FENCE_END.test(lines[index]) === false) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过收尾围栏（未闭合时自然到末尾）
      blocks.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flush();
      index += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading !== null) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    const bullet = line.match(BULLET);
    const ordered = line.match(ORDERED);
    if (bullet !== null || ordered !== null) {
      flush();
      const isOrdered = ordered !== null;
      /** @type {string[]} */
      const items = [];
      while (index < lines.length) {
        const nextBullet = lines[index].match(BULLET);
        const nextOrdered = lines[index].match(ORDERED);
        if (isOrdered === true && nextOrdered !== null) {
          items.push(nextOrdered[2].trim());
          index += 1;
          continue;
        }
        if (isOrdered === false && nextBullet !== null) {
          items.push(nextBullet[1].trim());
          index += 1;
          continue;
        }
        // 缩进续行并进上一条（列表项里换行写的说明）。
        if (items.length > 0 && /^\s+\S/.test(lines[index]) && nextBullet === null && nextOrdered === null) {
          items[items.length - 1] = `${items[items.length - 1]}\n${lines[index].trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    const quote = line.match(QUOTE);
    if (quote !== null) {
      flush();
      blocks.push({ kind: 'quote', text: quote[1] });
      index += 1;
      continue;
    }

    // 表格：当前行含竖线，且下一行是 `| --- |` 分隔行。
    if (line.includes('|') === true && isTableDivider(lines[index + 1]) === true) {
      flush();
      const header = splitRow(line);
      const align = parseAlign(lines[index + 1]);
      index += 2;
      /** @type {string[][]} */
      const rows = [];
      while (index < lines.length && lines[index].trim() !== '' && lines[index].includes('|') === true) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      // 列数对齐表头：短的补空，长的截断（表格结构不能因为某行多一格就崩）。
      const width = header.length;
      const normalized = rows.map((row) => {
        const cells = row.slice(0, width);
        while (cells.length < width) cells.push('');
        return cells;
      });
      blocks.push({ kind: 'table', header, align, rows: normalized });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flush();
  return blocks;
}
