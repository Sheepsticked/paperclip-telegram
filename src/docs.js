import { button, escapeHtml, issueUrl, link, truncate } from './format.js';
import { ID_PREFIX, byPrefix } from './pick.js';
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

// Packs the title and the body into at most MAX_PARTS messages; the last one leaves room for the closing note.
export function splitDocument(title, body) {
  const atoms = [`<b>${escapeHtml(truncate(title, 200))}</b>`];
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

// Sends one document as plain text in at most three messages.
export async function sendDocument(bot, cq, issueId, prefix) {
  const issue = await bot.pc.getIssue(issueId);
  const summary = byPrefix(issue.documentSummaries ?? [], prefix);
  if (!summary) return bot.answer(cq.id, 'Document not found', true);
  const doc = await bot.pc.getDocument(issueId, summary.key);
  const { parts, truncated } = splitDocument(doc.title || summary.key, String(doc.body ?? '').trim() || '(empty)');
  if (truncated) {
    const url = issueUrl(bot.config.uiBaseUrl, issue.identifier);
    parts[parts.length - 1] += `\n\nThe document ${link(url, 'continues in Paperclip')}`;
  }
  const thread = threadOf(bot, cq.message);
  for (const html of parts) await bot.send(html, { thread, issue: { id: issue.id, identifier: issue.identifier } });
  return bot.answer(cq.id);
}
