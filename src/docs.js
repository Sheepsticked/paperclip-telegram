import { button, escapeHtml, issueUrl, link, truncate } from './format.js';
import { ID_PREFIX, byPrefix } from './pick.js';
import { cleanMarkdown, escapeRich, fullTextLink, splitAtHeadings } from './rich.js';
import { threadOf } from './thread.js';

const PART_LIMIT = 3500;
const MAX_PARTS = 3;
const FOOTER_ROOM = 300;
const LIST_MAX = 30;

export function docsKeyboard(issueId, summaries) {
  const rows = summaries.slice(0, LIST_MAX).map((doc) => [button(`${doc.title || doc.key} · ${doc.key}`, `T:D:${issueId}:${doc.id.slice(0, ID_PREFIX)}`)]);
  rows.push([button('◀ Back', `T:b:${issueId}`)]);
  return rows;
}

// Escaped pieces of one line, each at most `limit` characters; an entity is never cut.
function* linePieces(line, limit) {
  let piece = '';
  for (const char of line) {
    const escaped = escapeHtml(char);
    if (piece.length + escaped.length > limit) {
      yield piece;
      piece = '';
    }
    piece += escaped;
  }
  yield piece;
}

// Packs the title (when there is one) and the body into at most MAX_PARTS messages; the last one leaves room
// for the closing note.
export function splitDocument(title, body) {
  const atoms = title === null ? [] : [`<b>${escapeHtml(truncate(title, 200))}</b>`];
  for (const line of body.split(/\r?\n/)) atoms.push(...linePieces(line.trimEnd(), PART_LIMIT - FOOTER_ROOM));
  const limits = [PART_LIMIT, PART_LIMIT, PART_LIMIT - FOOTER_ROOM];
  const parts = [''];
  for (const atom of atoms) {
    const current = parts.at(-1);
    const next = current ? `${current}\n${atom}` : atom;
    if (next.length <= limits[parts.length - 1]) {
      parts[parts.length - 1] = next;
    } else if (parts.length < MAX_PARTS) {
      parts.push(atom);
    } else {
      return { parts, truncated: true };
    }
  }
  return { parts, truncated: false };
}

// What cleaning put into Markdown that plain text should show as the author wrote it.
const asPlain = (markdown) => markdown.replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\\\$/g, '$');

// Sends the document as rich messages split at headings. When Telegram refuses one, returns the text from that
// message on (null when it was the first, so the whole document goes as written); null when all went through.
async function sendRichDocument(bot, { title, body, url, thread, issue }) {
  const head = `<b>${escapeRich(truncate(title, 200))}</b>`;
  const { parts: pieces, cut: dropped } = splitAtHeadings(cleanMarkdown(body, bot.config.uiBaseUrl), { room: head.length + 2 });
  const parts = pieces.slice(0, MAX_PARTS);
  const cut = dropped || pieces.length > MAX_PARTS;
  for (const [index, part] of parts.entries()) {
    const closing = cut && index === parts.length - 1 ? `\n\n${fullTextLink(url)}` : '';
    const sent = await bot.sendRich(`${index === 0 ? `${head}\n\n` : ''}${part}${closing}`, { thread, issue });
    if (sent === null) return { rest: index === 0 ? null : asPlain(parts.slice(index).join('\n\n')), cut };
  }
  return null;
}

// Sends one document in at most three messages: rich messages when they are on, else plain text.
export async function sendDocument(bot, cq, issueId, prefix) {
  const issue = await bot.pc.getIssue(issueId);
  const summary = byPrefix(issue.documentSummaries ?? [], prefix);
  if (!summary) return bot.answer(cq.id, 'Document not found', true);
  const doc = await bot.pc.getDocument(issueId, summary.key);
  const title = doc.title || summary.key;
  const body = String(doc.body ?? '').trim() || '(empty)';
  const url = issueUrl(bot.config.uiBaseUrl, issue.identifier);
  const thread = threadOf(bot, cq.message);
  const about = { id: issue.id, identifier: issue.identifier };
  let plain = { title, body, cut: false };
  if (!bot.richOff) {
    const left = await sendRichDocument(bot, { title, body, url: `${url}#document-${encodeURIComponent(summary.key)}`, thread, issue: about });
    if (left === null) return bot.answer(cq.id);
    if (left.rest !== null) plain = { title: null, body: left.rest, cut: left.cut };
  }
  const { parts, truncated } = splitDocument(plain.title, plain.body);
  if (truncated || plain.cut) parts[parts.length - 1] += `\n\nThe document ${link(url, 'continues in Paperclip')}`;
  for (const html of parts) await bot.send(html, { thread, issue: about });
  return bot.answer(cq.id);
}
