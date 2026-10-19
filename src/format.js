export const MESSAGE_LIMIT = 4096;

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
