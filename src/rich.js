import { MENTION_ROOM, escapeHtml, truncate } from './format.js';

// Telegram's rich message limits: characters of the Markdown, and blocks of the parsed message.
export const RICH_LIMIT = 32768;
export const RICH_BLOCK_LIMIT = 500;
// The length a rich alert is built to, so the owner mention still fits.
export const RICH_ALERT_LIMIT = RICH_LIMIT - MENTION_ROOM;

export const RICH_QUOTE_MAX = 4000;
// Quote budgets tried in turn, like QUOTE_LEVELS for the classic message.
export const RICH_QUOTE_LEVELS = [RICH_QUOTE_MAX, 2000, 1000, 400, 150, 0];

const FOLD_LINES = 3;
const FOLD_CHARS = 300;
const SUMMARY_MAX = 80;
const FULL_TEXT = 'Full text in Paperclip';
// The named entities Telegram's parser knows; any other `&` is escaped.
const KNOWN_ENTITY = /^&(?:#\d+|#x[0-9a-fA-F]+|lt|gt|amp|quot|apos|nbsp|hellip|mdash|ndash|lsquo|rsquo|ldquo|rdquo);/;
const MARKDOWN_SPECIAL = /[\\`*_~[\]#|$]|==/g;
const LIST_START = /^([ \t]*)([-+]|\d{1,9}[.)])(?=\s)/gm;

const length = (text) => Array.from(text).length;
// The text without blank lines around it; the indent of its first line stays (it can be a code block).
const trimBlank = (text) => text.replace(/^(?:[ \t]*\n)+/, '').trimEnd();

// Escapes a plain string (a title, a name) so neither HTML nor Markdown formats it.
export function escapeRich(text) {
  return escapeHtml(text)
    .replace(MARKDOWN_SPECIAL, (mark) => (mark === '==' ? '\\=\\=' : `\\${mark}`))
    .replace(LIST_START, (_, indent, marker) => `${indent}${marker.slice(0, -1)}\\${marker.at(-1)}`);
}

// Blocks of a rich message, one paragraph each; empty ones are dropped.
export const richJoin = (blocks) => blocks.filter((block) => block !== '' && block != null).join('\n\n');

// True when a Telegram reply to a rich message holds a text mention of the user.
export function hasRichMention(node, userId) {
  if (Array.isArray(node)) return node.some((child) => hasRichMention(child, userId));
  if (node === null || typeof node !== 'object') return false;
  if (node.type === 'text_mention' && node.user?.id === userId) return true;
  return Object.values(node).some((child) => hasRichMention(child, userId));
}

// --- fences ---------------------------------------------------------------------------------

const FENCE = /^[\s>]*(`{3,}|~{3,})(.*)$/;

// The fence state after `line`: null outside a code block, else the opening marker.
function fenceAfter(fence, line) {
  const match = FENCE.exec(line);
  if (!match) return fence;
  const [, marker, rest] = match;
  if (!fence) return marker[0] === '`' && rest.includes('`') ? null : marker;
  return marker[0] === fence[0] && marker.length >= fence.length && rest.trim() === '' ? null : fence;
}

// Closes a code block that the text leaves open, so what follows it is not swallowed.
function closeFence(text) {
  let fence = null;
  for (const line of text.split('\n')) fence = fenceAfter(fence, line);
  return fence ? `${text}\n${fence}` : text;
}

// --- cleaning ---------------------------------------------------------------------------------

const percent = (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

// An absolute http(s) address for a link target, or null when the link cannot be one.
function absoluteUrl(target, uiBaseUrl) {
  const url = String(target).trim().replace(/\\([!-/:-@[-`{-~])/g, '$1');
  const full = /^https?:\/\//i.test(url) ? url : url.startsWith('/') && !url.startsWith('//') ? `${uiBaseUrl}${url}` : null;
  if (full === null || full.length <= 8) return null;
  return full.replace(/[()\s<>[\]\\]/g, percent);
}

const backtickRun = (text, at) => /^`+/.exec(text.slice(at))[0].length;

// Index of the closing backtick run of the same length, or -1.
function closingRun(text, from, size) {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== '`') continue;
    const run = backtickRun(text, i);
    if (run === size) return i;
    i += run - 1;
  }
  return -1;
}

// Index of the `]` that closes the `[` at `start`, or -1.
function closingBracket(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') {
      i += 1;
    } else if (char === '`') {
      const size = backtickRun(text, i);
      const close = closingRun(text, i + size, size);
      i = close >= 0 ? close + size - 1 : i + size - 1;
    } else if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The `(target "title")` part that follows a link label at `start`; null when it is not one.
function linkTarget(text, start) {
  if (text[start] !== '(') return null;
  let i = start + 1;
  while (text[i] === ' ') i += 1;
  let target;
  if (text[i] === '<') {
    const close = text.indexOf('>', i);
    if (close < 0) return null;
    target = text.slice(i + 1, close);
    i = close + 1;
  } else {
    const from = i;
    let depth = 0;
    for (; i < text.length && !/\s/.test(text[i]); i += 1) {
      if (text[i] === '\\') i += 1;
      else if (text[i] === '(') depth += 1;
      else if (text[i] === ')' && depth-- === 0) break;
    }
    target = text.slice(from, i);
  }
  while (text[i] === ' ') i += 1;
  if (text[i] === '"' || text[i] === "'") {
    const close = text.indexOf(text[i], i + 1);
    if (close < 0) return null;
    i = close + 1;
    while (text[i] === ' ') i += 1;
  }
  return text[i] === ')' ? { target, end: i + 1 } : null;
}

// Cleans one line of text outside code. `flat` is set inside a link label, where links and images are plain text.
function cleanInline(text, uiBaseUrl, flat = false) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const char = text[i];
    if (char === '\\' && i + 1 < text.length) {
      out += text[i + 1] === '<' ? '&lt;' : text.slice(i, i + 2);
      i += 2;
    } else if (char === '`') {
      const size = backtickRun(text, i);
      const close = closingRun(text, i + size, size);
      const end = close >= 0 ? close + size : i + size;
      out += text.slice(i, end);
      i = end;
    } else if (char === '<') {
      // An address in angle brackets stays a link; any other `<` is text.
      const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(text.slice(i));
      const url = auto ? absoluteUrl(auto[1], uiBaseUrl) : null;
      out += url === null ? '&lt;' : flat ? escapeRich(auto[1]) : `[${escapeRich(auto[1])}](${url})`;
      i += url === null ? 1 : auto[0].length;
    } else if (char === '&') {
      out += KNOWN_ENTITY.test(text.slice(i)) ? '&' : '&amp;';
      i += 1;
    } else if (char === '$') {
      out += '\\$';
      i += 1;
    } else if (char === '[' || (char === '!' && text[i + 1] === '[')) {
      const image = char === '!';
      const open = image ? i + 1 : i;
      const close = closingBracket(text, open);
      const target = close >= 0 ? linkTarget(text, close + 1) : null;
      if (target === null) {
        // A `![` that is not a whole image stays text; the backslash keeps it from becoming a reference-style image.
        out += image ? '\\!' : char;
        i += 1;
        continue;
      }
      const inner = text.slice(open + 1, close);
      const url = absoluteUrl(target.target, uiBaseUrl);
      if (image) {
        const alt = inner.trim() || 'image';
        out += url === null || flat ? escapeRich(alt) : `[${escapeRich(alt)}](${url})`;
      } else {
        const label = cleanInline(inner, uiBaseUrl, true);
        out += url === null || flat ? label : `[${label || url}](${url})`;
      }
      i = target.end;
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

const DEFINITION = /^(\s{0,3})\[([^\]^][^\]]*)\]:\s*(<[^>]*>|\S+)(.*)$/;

// Paperclip Markdown made safe for a rich message: links absolute or plain, images as links, no raw HTML,
// every `&` that is not a known entity escaped. Code spans and fenced code blocks stay as written.
export function cleanMarkdown(markdown, uiBaseUrl) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  for (const line of lines) {
    const inFence = fence !== null;
    fence = fenceAfter(fence, line);
    if (inFence || fence !== null) {
      out.push(line);
      continue;
    }
    const definition = DEFINITION.exec(line);
    if (definition) {
      const url = absoluteUrl(definition[3].replace(/^<|>$/g, ''), uiBaseUrl);
      if (url !== null) out.push(`${definition[1]}[${definition[2]}]: ${url}`);
      continue;
    }
    out.push(cleanInline(line, uiBaseUrl));
  }
  return out.join('\n');
}

// --- cutting --------------------------------------------------------------------------------

// A line cut to `max` UTF-16 units (whole characters only) at a space where possible, never inside an entity or
// after a lone backslash.
function cutLine(line, max) {
  let cut = '';
  for (const char of line) {
    if (cut.length + char.length > max) break;
    cut += char;
  }
  const space = cut.lastIndexOf(' ');
  if (space > cut.length * 0.6) cut = cut.slice(0, space);
  return closeSpan(cut.replace(/&#?\w*$/, '').replace(/(?<!\\)(\\\\)*\\$/, '$1').trimEnd(), line);
}

export const fullTextLink = (url) => `[${FULL_TEXT}](${url})`;

// A line cut short, with a code span that the cut left open closed again, so what it holds stays text.
// `whole` is the line before the cut.
function closeSpan(cut, whole) {
  for (let i = 0; i < cut.length; ) {
    if (cut[i] === '\\') {
      i += 2;
    } else if (cut[i] !== '`') {
      i += 1;
    } else {
      const size = backtickRun(cut, i);
      const close = closingRun(cut, i + size, size);
      if (close >= 0) i = close + size;
      else if (closingRun(whole, i + size, size) >= 0) return `${cut} ${'`'.repeat(size)}`;
      else i += size;
    }
  }
  return cut;
}

// The text cut at a line boundary to at most `max` characters, with an open code block closed and, when
// something was cut, a link to the full text. `fullUrl` may be null.
export function cutMarkdown(markdown, max, fullUrl = null) {
  const text = trimBlank(String(markdown ?? ''));
  if (length(text) <= max) return closeFence(text);
  const lines = text.split('\n');
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = length(line) + 1;
    if (used + cost > max) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0) kept.push(cutLine(lines[0], max));
  const body = closeFence(kept.join('\n').trimEnd());
  return `${body}\n\n${fullUrl ? fullTextLink(fullUrl) : '…'}`;
}

// --- folding --------------------------------------------------------------------------------

const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

// True when the first line opens a code block, a table or a list.
function opensBlock(first, next = '') {
  if (FENCE.test(first) || /^(?: {4}|\t)/.test(first) || LIST_ITEM.test(first)) return true;
  const line = first.trim();
  return line.startsWith('|') || (line.includes('|') && TABLE_RULE.test(next));
}

// The first line as plain text: heading, quote and emphasis marks, links, images and tags removed.
function plainLine(line) {
  return line
    .trim()
    .replace(/^(?:#{1,6}\s+|>\s*)+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<(https?:[^>\s]+)>/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(`+)([^`]*?)\1/g, '$2')
    .replace(/(\*\*|~~)(.+?)\1/g, '$2')
    .replace(/(?<!\w)__(.+?)__(?!\w)/g, '$1')
    .replace(/(?<![\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1')
    .replace(/(?<![\w])_(?!\s)([^_]+?)_(?!\w)/g, '$1')
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const ENTITY_TEXT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

// Text with the entities that cleaning leaves in place turned back into characters.
const decodeEntities = (text) =>
  text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(\w+));/g, (whole, dec, hex, name) => {
    if (name) return ENTITY_TEXT[name] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

// The summary of a folded body and whether the first line is already fully in it. A line the summary
// cannot carry whole (cut, or with a link or tag) stays in the folded text too.
function summaryOf(first, next) {
  if (opensBlock(first, next)) return { summary: 'Show all', whole: true };
  const plain = decodeEntities(plainLine(first));
  if (plain === '') return { summary: 'Show all', whole: true };
  const cut = truncate(plain, SUMMARY_MAX);
  return { summary: escapeRich(cut), whole: cut !== plain || /\]\(|<\/?[A-Za-z]/.test(first) };
}

const quoteLines = (lines) => lines.map((line) => (line.trim() ? `> ${line}` : '>')).join('\n');

const ENDS_IN_BREAK = /(?: {2}|(?<!\\)(?:\\\\)*\\)$/;
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/;

// The column that `text` ends at, a tab moving to the next multiple of 4.
function widthOf(text) {
  let width = 0;
  for (const char of text) width += char === '\t' ? 4 - (width % 4) : 1;
  return width;
}

// Whether each line of a run of paragraph lines ends inside a code span; a span can run over several lines.
function endsInSpan(lines) {
  const text = lines.join('\n');
  const spans = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] === '\\') {
      i += 2;
    } else if (text[i] !== '`') {
      i += 1;
    } else {
      const size = backtickRun(text, i);
      const close = closingRun(text, i + size, size);
      if (close >= 0) spans.push([i, close]);
      i = close >= 0 ? close + size : i + size;
    }
  }
  let end = -1;
  return lines.map((line) => {
    end += line.length + 1;
    return spans.some(([open, close]) => open < end && end < close);
  });
}

// Which lines are text, that is not blank, not in or around a fenced code block and not indented code. An indented
// line is code when it starts four columns past the text of the list item it is in (none: past the left margin)
// and does not continue a paragraph.
function textLines(lines) {
  let fence = null;
  let offset = 0;
  let paragraph = false;
  return lines.map((line) => {
    const before = fence;
    fence = fenceAfter(fence, line);
    const text = before === null && fence === null && line.trim() !== '';
    const marker = text ? LIST_MARKER.exec(line) : null;
    const indent = widthOf(/^[ \t]*/.exec(line)[0]);
    if (text && !paragraph && !marker && indent < offset) offset = 0;
    const code = text && !paragraph && indent >= offset + 4;
    if (text && !code && marker) {
      const gap = /^ */.exec(line.slice(marker[0].length))[0].length;
      offset = widthOf(marker[0]) + (gap >= 1 && gap <= 4 ? gap : 1);
    }
    paragraph = text && !code;
    return paragraph;
  });
}

// Ends every non-blank line that a non-blank line follows with two spaces, so a single newline shows as a line
// break (as Paperclip shows it in a comment). Code, fenced or indented, and the end of a line inside a code span
// stay as written.
export function withHardBreaks(markdown) {
  const lines = markdown.split('\n');
  const text = textLines(lines);
  const inSpan = lines.map(() => false);
  for (let start = 0; start < lines.length; start += 1) {
    if (!text[start]) continue;
    let end = start;
    while (text[end + 1]) end += 1;
    endsInSpan(lines.slice(start, end + 1)).forEach((flag, offset) => {
      inSpan[start + offset] = flag;
    });
    start = end;
  }
  return lines
    .map((line, index) => {
      const next = lines[index + 1];
      if (!text[index] || inSpan[index] || next === undefined || next.trim() === '' || ENDS_IN_BREAK.test(line)) return line;
      return `${line.trimEnd()}  `;
    })
    .join('\n');
}

// A short body as a quote; a longer one (over 3 lines or 300 characters) folded under its first line.
// `hardBreaks` turns a single newline into a line break first.
export function foldMarkdown(markdown, hardBreaks = false) {
  const lines = (hardBreaks ? withHardBreaks(markdown) : markdown).split('\n');
  const filled = lines.filter((line) => line.trim() !== '').length;
  if (filled <= FOLD_LINES && length(markdown) <= FOLD_CHARS) return quoteLines(lines);
  const index = lines.findIndex((line) => line.trim() !== '');
  const { summary, whole } = summaryOf(lines[index], lines.slice(index + 1).find((line) => line.trim() !== ''));
  const rest = trimBlank((whole ? lines : lines.slice(index + 1)).join('\n'));
  return `<details><summary>${summary}</summary>\n\n${rest}\n\n</details>`;
}

// Context for the helpers below: `uiBaseUrl` makes relative links absolute, `fullUrl` is where the full text lives,
// `hardBreaks` shows a single newline as a line break (comments do in Paperclip; descriptions and documents do not).

// Paperclip Markdown as a block of a rich message: cleaned, cut to `max` characters and folded or quoted.
// An empty text or a budget of 0 gives an empty string.
export function richBody(markdown, max, { uiBaseUrl, fullUrl = null, hardBreaks = false }) {
  const clean = trimBlank(cleanMarkdown(markdown, uiBaseUrl));
  return clean && max > 0 ? foldMarkdown(cutMarkdown(clean, max, fullUrl), hardBreaks) : '';
}

// The same, as plain paragraphs: cleaned and cut but neither folded nor quoted.
export function richText(markdown, max, { uiBaseUrl, fullUrl = null, hardBreaks = false }) {
  const clean = trimBlank(cleanMarkdown(markdown, uiBaseUrl));
  if (!clean || max <= 0) return '';
  const cut = cutMarkdown(clean, max, fullUrl);
  return hardBreaks ? withHardBreaks(cut) : cut;
}

// --- documents ------------------------------------------------------------------------------

// A rough count of the blocks Telegram will see: one per non-empty line outside code, two for list and quote
// lines (the item and its paragraph), one per code block.
export function estimateBlocks(markdown) {
  let blocks = 0;
  let fence = null;
  for (const line of markdown.split('\n')) {
    const before = fence;
    fence = fenceAfter(fence, line);
    if (before) continue;
    if (fence || FENCE.test(line)) blocks += 1;
    else if (line.trim()) blocks += LIST_ITEM.test(line) || /^\s*>/.test(line) ? 2 : 1;
  }
  return blocks;
}

// Lengths here are UTF-16 units, the stricter count, so a part that fits is never over the limit Telegram checks.
const fits = (text, chars, blocks) => text.length <= chars && estimateBlocks(text) <= blocks;

// Lines packed into pieces that fit; a code block cut by a split is closed and opened again. A line longer than
// a piece is cut, and `onCut` is called.
function packLines(lines, chars, blocks, onCut) {
  const pieces = [];
  let current = [];
  let fence = null;
  const flush = () => {
    if (current.length) pieces.push(closeFence(current.join('\n')));
    current = fence ? [fence] : [];
  };
  for (const line of lines) {
    // Room is kept for a code block to be closed and opened again around the line.
    const tooLong = line.length > chars - 10;
    if (tooLong) onCut();
    const text = tooLong ? cutLine(line, chars - 10) : line;
    const after = fenceAfter(fence, text);
    if (current.length > 0 && !fits([...current, text, ...(after ? [after] : [])].join('\n'), chars, blocks)) flush();
    current.push(text);
    fence = after;
  }
  if (current.some((line) => line.trim())) pieces.push(closeFence(current.join('\n')));
  return pieces;
}

// The Markdown cut into sections that start at a heading outside code.
function sections(markdown) {
  const out = [];
  let current = [];
  let fence = null;
  for (const line of markdown.split('\n')) {
    if (!fence && /^#{1,6}\s/.test(line) && current.length > 0) {
      out.push(current.join('\n').trimEnd());
      current = [];
    }
    current.push(line);
    fence = fenceAfter(fence, line);
  }
  out.push(current.join('\n').trimEnd());
  return out;
}

// Splits a document into messages that each fit the rich limits, cutting at headings first, then at blank
// lines, then at lines. `room` is what the first message keeps free for its title. `cut` is true when a line
// was too long for a message and its end was dropped.
export function splitAtHeadings(markdown, { chars = RICH_LIMIT - 200, blocks = RICH_BLOCK_LIMIT - 50, room = 0 } = {}) {
  const parts = [];
  let current = '';
  let cut = false;
  const limitOf = () => (parts.length === 0 ? chars - room : chars);
  const add = (piece) => {
    const joined = current ? `${current}\n\n${piece}` : piece;
    if (current && !fits(joined, limitOf(), blocks)) {
      parts.push(current);
      current = piece;
    } else {
      current = joined;
    }
  };
  for (const section of sections(trimBlank(markdown))) {
    if (fits(section, limitOf(), blocks)) {
      add(section);
      continue;
    }
    // A section too big for one message: by paragraphs, then by lines.
    let paragraph = [];
    let fence = null;
    const paragraphs = [];
    for (const line of section.split('\n')) {
      if (!fence && line.trim() === '' && paragraph.length > 0) {
        paragraphs.push(paragraph.join('\n'));
        paragraph = [];
      } else {
        paragraph.push(line);
      }
      fence = fenceAfter(fence, line);
    }
    if (paragraph.length > 0) paragraphs.push(paragraph.join('\n'));
    for (const text of paragraphs) {
      if (fits(text, limitOf(), blocks)) add(text);
      else for (const piece of packLines(text.split('\n'), limitOf(), blocks, () => { cut = true; })) add(piece);
    }
  }
  if (current) parts.push(current);
  return { parts: parts.map(closeFence), cut };
}
