export const MESSAGE_LIMIT = 4096;
export const CALLBACK_DATA_LIMIT = 64;
const BUTTON_LABEL_MAX = 60;

// First words of line 1 of every task message.
export const KINDS = [
  'Question',
  'Done',
  'In review',
  'Run failed',
  'Comment',
  'Task',
  'Created',
  'Approval',
  'Decision',
  'Review',
  'Blocked',
  'Recovery',
  'Join request',
];

export const STATUS_NAMES = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function statusName(status) {
  return STATUS_NAMES[status] ?? String(status ?? 'Unknown');
}

// An inline keyboard button; callback data over Telegram's byte limit would be rejected, so it fails early.
export function button(label, data) {
  if (Buffer.byteLength(data) > CALLBACK_DATA_LIMIT) throw new Error(`callback data over ${CALLBACK_DATA_LIMIT} bytes: ${data}`);
  return { text: truncate(label, BUTTON_LABEL_MAX), callback_data: data };
}

// The extra button on messages about one task; it sends the task view.
export function taskButton(issueId) {
  return button('Open task', `T:v:${issueId}`);
}

// "5 min ago", "3 h ago", "2 d ago".
export function ago(iso, nowMs) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'unknown time ago';
  const minutes = Math.max(0, Math.floor((nowMs - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

// Cuts raw text to at most `max` characters (counting code points), ending with an ellipsis.
export function truncate(text, max) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= max) return chars.join('');
  if (max <= 1) return max === 1 ? '…' : '';
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

// One line: whitespace runs collapse to a single space.
export const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export function firstLine(text) {
  return (
    String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

// Keeps the first `maxLines` non-empty lines, then caps the total length.
export function truncateLines(text, maxLines, maxChars) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const cut = lines.length > maxLines;
  const joined = lines.slice(0, maxLines).join('\n');
  const limited = truncate(joined, maxChars);
  return cut && limited === joined ? `${limited}…` : limited;
}

export function link(url, label) {
  return `<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`;
}

// Line 1 of a task message; the title is left out inside the task's own topic.
export function headline(kind, issue, { own = false, titleMax = 100 } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown message kind: ${kind}`);
  const title = !own && issue.title ? ` ${escapeHtml(truncate(issue.title, titleMax))}` : '';
  return `<b>${kind}</b> · ${escapeHtml(issue.identifier)}${title}`;
}

export function prefixOf(identifier) {
  const text = String(identifier ?? '');
  const dash = text.indexOf('-');
  return dash > 0 ? text.slice(0, dash) : text;
}

export function issueUrl(uiBaseUrl, identifier) {
  return `${uiBaseUrl}/${prefixOf(identifier)}/issues/${identifier}`;
}

export function cardUrl(uiBaseUrl, identifier, interactionId) {
  return `${issueUrl(uiBaseUrl, identifier)}#interaction-${interactionId}`;
}

export function runUrl(uiBaseUrl, prefix, agentId, runId) {
  return `${uiBaseUrl}/${prefix}/agents/${agentId}/runs/${runId}`;
}

// Tries build(level) from the roomiest level down and returns the first result that fits.
export function fitMessage(build, levels) {
  for (const level of levels) {
    const html = build(level);
    if (html.length <= MESSAGE_LIMIT) return html;
  }
  throw new Error('message does not fit the Telegram limit at any level');
}

// Splits lines into messages that each stay within the limit; a line is never cut.
export function chunkLines(lines, limit = MESSAGE_LIMIT) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= limit) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    current = line.length <= limit ? line : '';
  }
  if (current) chunks.push(current);
  return chunks;
}
