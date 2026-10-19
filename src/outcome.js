import { escapeHtml, fitMessage, flat, link } from './format.js';
import { escapeRich } from './rich.js';

const SEPARATOR = ' · ';

// What a settled message says happened: `kind` (bold), an optional `detail`, and `at`, the settle time as an ISO
// string. `ref` is an optional link ({ label, url }) that leads the detail.
export function makeOutcome(kind, detail, nowMs, ref = null) {
  const text = flat(detail);
  return { kind, detail: text || null, at: new Date(nowMs).toISOString(), ...(ref ? { ref } : {}) };
}

// The settle time as the date-time entity Telegram shows relative to now ("5 minutes ago"); the visible text, which
// clients that do not know the entity show, is the UTC clock time. Empty when the outcome has no usable time.
function timePart(at, rich) {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return '';
  const unix = Math.floor(ms / 1000);
  const clock = `${new Date(ms).toISOString().slice(11, 16)} UTC`;
  return rich ? `![${clock}](tg://time?unix=${unix}&format=r)` : `<tg-time unix="${unix}" format="r">${clock}</tg-time>`;
}

// The highlighted last block of a settled message, as classic HTML or (with `rich`) as rich Markdown.
// A message from an older state carries a plain `resolution` line instead of an outcome; it is shown as it is, with no time.
// Empty when the message is not settled.
export function outcomeBlock(item, rich = false) {
  const esc = rich ? escapeRich : escapeHtml;
  const wrap = (body) => (rich ? `==${body}==` : `<blockquote>${body}</blockquote>`);
  const { outcome } = item;
  if (!outcome) return typeof item.resolution === 'string' && item.resolution ? wrap(esc(item.resolution)) : '';
  const detail = [outcome.ref ? link(outcome.ref.url, outcome.ref.label, esc) : '', outcome.detail ? esc(outcome.detail) : ''].filter(Boolean).join(' ');
  const parts = [`<b>${esc(outcome.kind)}</b>`, detail, timePart(outcome.at, rich)].filter(Boolean);
  return wrap(parts.join(SEPARATOR));
}

// Like fitMessage for `build(item, level)`, but a settled item that is too long at a level first loses the detail of
// its outcome, so the text it had before settling stays whole.
export function fitSettled(build, levels, limit, item) {
  return fitMessage((level) => {
    const full = build(item, level);
    if (full.length <= limit || !item.outcome?.detail) return full;
    return build({ ...item, outcome: { kind: item.outcome.kind, detail: null, at: item.outcome.at } }, level);
  }, levels, limit);
}
