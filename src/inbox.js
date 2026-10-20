import { reportFailure } from './actions.js';
import { ALERT_LIMIT, MESSAGE_LIMIT, button, escapeHtml, flat, headline, issueUrl, kindWord, link, openRows, truncate, truncateLines } from './format.js';
import { guarded } from './guard.js';
import { fitSettled, makeOutcome, outcomeBlock } from './outcome.js';
import { PaperclipError } from './paperclip.js';
import { RICH_ALERT_LIMIT, RICH_LIMIT, escapeRich, richBody, richJoin } from './rich.js';
import { reportActionFailure } from './tasks.js';
import { threadOf } from './thread.js';

// First word of line 1 for each attention kind the bot shows.
const HEAD = {
  approval: 'Approval',
  decision: 'Decision',
  review: 'Review',
  blocker_attention: 'Blocked',
  recovery_action: 'Recovery',
  join_request: 'Join request',
};
export const INBOX_KINDS = new Set(Object.keys(HEAD));

const OPEN_APPROVAL = new Set(['pending', 'revision_requested']);
const APPROVAL_TYPES = {
  hire_agent: 'Hire agent',
  approve_ceo_strategy: 'CEO strategy',
  budget_override_required: 'Budget override',
  request_board_approval: 'Board approval',
};
const BODY_MAX = 800;
// How much of a decision's text is kept; the message shows the part that fits.
const BODY_KEEP = 4000;
const VALUE_MAX = 200;
const CONFIRM_LABEL = 'Tap again to confirm';
const RECENT_MS = 2 * 60 * 1000;
// The outcome of an item that was settled somewhere else or left the feed.
const RESOLVED_ELSEWHERE = 'Resolved in Paperclip';

// Progressively smaller text budgets used until the message fits the Telegram limit.
const LEVELS = [
  { title: 100, why: 400, body: BODY_MAX, options: 100 },
  { title: 80, why: 300, body: 400, options: 0 },
  { title: 60, why: 200, body: 0, options: 0 },
  { title: 50, why: 0, body: 0, options: 0 },
];

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const issueRef = (issue) => ({ id: issue.id, identifier: issue.identifier ?? null, title: issue.title ?? '' });

// The feed items the bot shows: the known kinds without an active dismissal.
export const inboxItems = (items) => items.filter((item) => INBOX_KINDS.has(item.sourceKind) && !item.dismissal?.isActive);

// The task an item is about: the item itself when it is an issue, else its related issue.
export function itemIssue(item) {
  const subject = item.subject ?? {};
  if (subject.kind === 'issue' && subject.id) return issueRef(subject);
  if (item.relatedIssue?.id) return issueRef(item.relatedIssue);
  return null;
}

// Id of the task behind an item; an approval only names its task in the metadata.
export const itemIssueId = (item) => itemIssue(item)?.id ?? text(item.subject?.metadata?.issueId);

function skeleton(bot, item) {
  const subject = item.subject ?? {};
  const issue = itemIssue(item);
  return {
    key: bot.state.nextInboxKey(),
    kind: item.sourceKind,
    dedupKey: item.dedupKey,
    refId: subject.id ?? null,
    issue,
    issueId: issue?.id ?? text(subject.metadata?.issueId),
    title: text(subject.title) ?? '',
    whyNow: text(item.whyNow),
    href: text(subject.href),
    stalled: subject.metadata?.reviewAttentionState === 'stalled',
    inlineResolvable: item.inlineResolvable === true,
    hydrated: false,
    facts: [],
    body: '',
    options: [],
    needsInput: false,
    status: 'open',
    outcome: null,
    resolvedAt: null,
    messageIds: [],
    own: false,
    notePromptMessageId: null,
  };
}

async function readOrGone(read) {
  try {
    return await read();
  } catch (err) {
    if (err instanceof PaperclipError && err.status === 404) return null;
    throw err;
  }
}

function valueText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return flat(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(', ');
  return flat(JSON.stringify(value));
}

// "key: value" lines of a free-form payload.
function payloadText(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const lines = Object.entries(payload)
    .map(([name, value]) => [name, valueText(value)])
    .filter(([, shown]) => shown)
    .map(([name, shown]) => `${name}: ${truncate(shown, VALUE_MAX)}`);
  return truncateLines(lines.join('\n'), 20, BODY_MAX);
}

const approvalType = (type) => APPROVAL_TYPES[type] ?? flat(String(type ?? 'Request').replace(/_/g, ' '));

// Reads what the feed item does not carry (approval payload, decision options); false when it is no longer open.
async function hydrate(bot, record) {
  if (record.hydrated) return true;
  if (record.kind === 'approval') {
    const approval = await readOrGone(() => bot.pc.getApproval(record.refId));
    if (!approval || !OPEN_APPROVAL.has(approval.status)) return false;
    record.facts.push(`Type: ${approvalType(approval.type)}`);
    if (approval.requestedByAgentId) record.facts.push(`Requested by: ${(await bot.agentName(approval.requestedByAgentId)) ?? 'An agent'}`);
    else if (approval.requestedByUserId) record.facts.push('Requested by: A user');
    record.body = payloadText(approval.payload);
    if (!record.issue && record.issueId) {
      const issue = await readOrGone(() => bot.pc.getIssue(record.issueId));
      if (issue) record.issue = issueRef(issue);
    }
  } else if (record.kind === 'decision') {
    const decision = await readOrGone(() => bot.pc.getDecision(record.refId));
    if (!decision || decision.status !== 'open') return false;
    record.body = truncate(String(decision.body ?? '').trim(), BODY_KEEP);
    // Inputs belong to the whole decision, so a required one leaves no option that can be a button.
    record.needsInput = (decision.inputs ?? []).some((input) => input.required === true);
    record.options = (decision.options ?? []).map((option) => ({
      id: option.id,
      label: text(option.label) ?? option.id,
      description: text(option.description),
      destructive: option.style === 'destructive',
    }));
  }
  record.hydrated = true;
  return true;
}

function recordUrl(record, uiBaseUrl) {
  if (record.href?.startsWith('/')) return `${uiBaseUrl}${record.href}`;
  return record.issue?.identifier ? issueUrl(uiBaseUrl, record.issue.identifier) : null;
}

// The item as classic HTML, or as rich Markdown with `rich` set.
function compose(record, ctx, level, rich = false) {
  const { issue } = record;
  const esc = rich ? escapeRich : escapeHtml;
  const url = recordUrl(record, ctx.uiBaseUrl);
  const lines = [];
  let openLine = null;
  if (issue) {
    lines.push(headline(HEAD[record.kind], issue, { own: ctx.own, titleMax: level.title, url, esc }));
    if (record.title && record.title !== issue.title) lines.push(`<b>${esc(truncate(record.title, 200))}</b>`);
  } else {
    const title = record.title ? truncate(record.title, level.title) : '';
    lines.push(`${kindWord(HEAD[record.kind], null, esc)}${title ? ` · ${url ? link(url, title, esc) : esc(title)}` : ''}`);
    // The kind word stays free for the owner mention; without a title the link goes on a last line.
    if (!title && url) openLine = link(url, 'Open in Paperclip', esc);
  }
  if (record.whyNow && level.why > 0) lines.push(esc(truncate(record.whyNow, level.why)));
  if (level.body > 0) {
    for (const fact of record.facts) lines.push(esc(truncate(fact, 120)));
    if (record.body) lines.push('', rich ? richBody(record.body, level.body, { uiBaseUrl: ctx.uiBaseUrl, fullUrl: url, hardBreaks: true }) : escapeHtml(truncate(record.body, level.body)));
    const described = record.options.some((option) => option.description);
    if (level.options > 0 && (described || record.needsInput)) {
      const options = record.options.map((option) => `- ${esc(truncate(option.label, 60))}${option.description ? `: ${esc(truncate(option.description, level.options))}` : ''}`);
      lines.push('', options.join('\n'));
    }
  }
  if (record.status === 'open') {
    if (record.kind === 'decision' && record.needsInput) lines.push('', 'More options in Paperclip');
    if (record.kind === 'approval' && !record.inlineResolvable) lines.push('', 'Answer this one in Paperclip');
    if (record.notePromptMessageId) lines.push('', 'Waiting for the note (reply to the prompt below).');
  }
  if (openLine) lines.push(...(lines.length > 1 ? ['', openLine] : [openLine]));
  const outcome = outcomeBlock(record, rich);
  if (outcome) lines.push('', outcome);
  return rich ? richJoin(lines) : lines.join('\n');
}

function keyboardFor(record, armed) {
  if (record.status !== 'open') return [];
  const k = record.key;
  const label = (op, name) => (armed.has(op) ? CONFIRM_LABEL : name);
  const rows = [];
  if (record.kind === 'approval' && record.inlineResolvable) {
    rows.push([button(label('a', 'Approve'), `I:a:${k}`, 'success'), button(label('r', 'Reject'), `I:r:${k}`, 'danger')]);
  }
  // Dismissing decides an option too, which the server refuses while a required input is empty.
  if (record.kind === 'decision' && !record.needsInput) {
    record.options.forEach((option, index) => rows.push([button(label(`o${index}`, option.label), `I:o:${k}:${index}`)]));
    rows.push([button('Dismiss', `I:x:${k}`)]);
  }
  if (record.kind === 'review' && record.stalled && record.issue) {
    rows.push([button(label('sa', 'Approve'), `I:s:${k}:a`, 'success'), button('Request changes', `I:s:${k}:c`), button(label('sb', 'Send back'), `I:s:${k}:b`)]);
  }
  const taskId = record.issue?.id ?? record.issueId;
  if (taskId) rows.push(...openRows(taskId, record.own));
  return rows;
}

// `messageId` picks the armed buttons of that message. `rich` is the same item as Markdown; only a decision
// has Paperclip Markdown (its text), so the other kinds have none.
function renderInbox(bot, record, messageId = null) {
  const armed = messageId ? bot.armedOps(messageId) : new Set();
  const context = { own: record.own, uiBaseUrl: bot.config.uiBaseUrl };
  const alert = needsOwner(record);
  const text = fitSettled((item, level) => compose(item, context, level), LEVELS, alert ? ALERT_LIMIT : MESSAGE_LIMIT, record);
  const rich = record.kind === 'decision' && record.body ? fitSettled((item, level) => compose(item, context, level, true), LEVELS, alert ? RICH_ALERT_LIMIT : RICH_LIMIT, record) : null;
  return { text, rich, keyboard: keyboardFor(record, armed) };
}

async function editOne(bot, record, messageId) {
  const { text: html, rich, keyboard } = renderInbox(bot, record, messageId);
  try {
    await bot.edit(messageId, html, keyboard, rich);
  } catch (err) {
    bot.log.warn('could not update an inbox message', { error: err.message });
  }
}

async function editAll(bot, record) {
  for (const messageId of record.messageIds) await editOne(bot, record, messageId);
}

// An item the owner has to act on; a review that is not stalled only informs.
const needsOwner = (record) => record.kind !== 'review' || record.stalled;

// Sends the item's message (into its task's topic when it has a task) and remembers the message id.
// A message the owner asked for by tapping a button is silent; a new item makes a sound when it needs the owner.
async function sendRecord(bot, record, { thread, alert = false } = {}) {
  const build = ({ own }) => {
    record.own = own;
    return renderInbox(bot, record);
  };
  if (record.issue) {
    const sent = await bot.sendAbout(record.issue, build, { alert });
    record.messageIds.push(sent.messageId);
    return;
  }
  const { text: html, rich, keyboard } = build({ own: false });
  record.messageIds.push(await bot.send(html, { keyboard, thread, alert, rich }));
}

// Settles the item with an outcome of this kind (and detail) at the current time.
export async function resolveRecord(bot, record, kind, detail = null) {
  record.status = 'resolved';
  record.outcome = makeOutcome(kind, detail, bot.now());
  record.resolvedAt = record.outcome.at;
  record.notePromptMessageId = null;
  for (const messageId of record.messageIds) bot.disarm(messageId);
  bot.state.save();
  await editAll(bot, record);
}

// True when the item has no message yet and was not skipped or answered a moment ago.
export function isFreshInbox(bot, item) {
  const { state } = bot;
  if (state.skippedInbox.includes(item.dedupKey) || state.inboxByDedupKey(item.dedupKey)) return false;
  return ![...state.inbox.values()].some(
    (record) => record.dedupKey === item.dedupKey && record.status === 'resolved' && bot.now() - Date.parse(record.resolvedAt) < RECENT_MS,
  );
}

// Reads the item in full and sends its message; false when there was nothing to send.
export async function sendInboxItem(bot, item) {
  const record = skeleton(bot, item);
  if (!(await hydrate(bot, record))) return false;
  await sendRecord(bot, record, { alert: needsOwner(record) });
  bot.state.inbox.set(record.key, record);
  bot.state.save();
  return true;
}

// Resolves the messages of items that left the feed. A walk that stopped early proves nothing, so it changes nothing.
export async function syncInbox(bot, items, complete) {
  if (!complete) return;
  const { state } = bot;
  const present = new Set(inboxItems(items).map((item) => item.dedupKey));
  for (const record of state.openInbox()) {
    if (present.has(record.dedupKey)) continue;
    await guarded(bot, `inbox item ${record.key}`, () => resolveRecord(bot, record, RESOLVED_ELSEWHERE));
  }
  state.skippedInbox = state.skippedInbox.filter((dedupKey) => present.has(dedupKey));
  state.save();
}

// An item listed in /status: the button label and what it opens (the task, else the item's message).
export function statusEntry(bot, item) {
  const issue = itemIssue(item);
  const issueId = issue?.id ?? text(item.subject?.metadata?.issueId);
  const title = text(item.subject?.title) ?? issue?.title ?? 'Untitled';
  const label = issue?.identifier ? `${issue.identifier} · ${title}` : `${HEAD[item.sourceKind]} · ${title}`;
  return { label, issueId, data: issueId ? `T:v:${issueId}` : `I:m:${adopt(bot, item).key}` };
}

// What an item is about, as plain facts for a one-line summary; nothing is created or read.
export function itemSummary(item) {
  const issue = itemIssue(item);
  return {
    issueId: itemIssueId(item),
    identifier: issue?.identifier ?? null,
    title: issue?.title || text(item.subject?.title) || 'Untitled',
    kind: HEAD[item.sourceKind],
    href: text(item.subject?.href),
  };
}

// A record without a message, so a button can send the message later.
function adopt(bot, item) {
  const existing = bot.state.inboxByDedupKey(item.dedupKey);
  if (existing) return existing;
  const record = skeleton(bot, item);
  bot.state.inbox.set(record.key, record);
  bot.state.save();
  return record;
}

// The first tap arms the button; true when this tap is the confirming one.
async function confirmTap(bot, cq, record, op) {
  const messageId = cq.message.message_id;
  if (bot.isArmed(messageId, op)) {
    bot.disarm(messageId);
    return true;
  }
  bot.disarm(messageId);
  bot.arm(messageId, op, () => editOne(bot, record, messageId));
  await editOne(bot, record, messageId);
  await bot.answer(cq.id, CONFIRM_LABEL);
  return false;
}

// The item is gone or was answered elsewhere.
function alreadyResolved(record, err) {
  if (err.status === 404 || err.status === 409) return true;
  return record.kind === 'approval' && err.status === 422 && /pending/i.test(err.detail ?? '');
}

// Runs the Paperclip call and settles the item; the tap is answered with the kind and detail.
async function act(bot, cq, record, call, kind, detail = null) {
  try {
    await call();
  } catch (err) {
    if (err instanceof PaperclipError && alreadyResolved(record, err)) {
      await resolveRecord(bot, record, RESOLVED_ELSEWHERE);
      return bot.answer(cq.id, 'Already resolved');
    }
    return reportActionFailure(bot, cq, err);
  }
  await resolveRecord(bot, record, kind, detail);
  return bot.answer(cq.id, detail ? `${kind}: ${detail}` : kind);
}

const REVIEW_ACTIONS = {
  a: { action: 'approve', kind: 'Approved' },
  b: { action: 'send_back', kind: 'Sent back' },
};

async function askForNote(bot, cq, record) {
  if (record.notePromptMessageId) return bot.answer(cq.id, 'Reply to the note prompt first');
  record.notePromptMessageId = await bot.send('What should change?\nReply to this message with your note.', {
    replyTo: cq.message.message_id,
    thread: threadOf(bot, cq.message),
    forceReply: 'Note',
  });
  bot.state.save();
  await editAll(bot, record);
  return bot.answer(cq.id, 'Reply with the note');
}

async function resend(bot, cq, record) {
  if (!(await hydrate(bot, record))) {
    await resolveRecord(bot, record, RESOLVED_ELSEWHERE);
    return bot.answer(cq.id, 'Already resolved');
  }
  await sendRecord(bot, record, { thread: threadOf(bot, cq.message) });
  bot.state.save();
  return bot.answer(cq.id);
}

export async function handleInboxCallback(bot, cq) {
  const [, op, key, arg] = String(cq.data).split(':');
  const record = bot.state.inbox.get(key);
  if (!record || !cq.message?.message_id) return bot.answer(cq.id, 'This item is no longer available');
  if (record.status !== 'open') {
    await bot.answer(cq.id, 'Already resolved');
    return editAll(bot, record);
  }
  try {
    if (op === 'm') return await resend(bot, cq, record);
    if ((op === 'a' || op === 'r') && record.kind === 'approval' && record.inlineResolvable) {
      if (!(await confirmTap(bot, cq, record, op))) return undefined;
      const call = op === 'a' ? () => bot.pc.approve(record.refId) : () => bot.pc.rejectApproval(record.refId);
      return await act(bot, cq, record, call, op === 'a' ? 'Approved' : 'Rejected');
    }
    if (op === 'o' && record.kind === 'decision' && !record.needsInput && record.options[Number(arg)]) {
      const option = record.options[Number(arg)];
      if (option.destructive && !(await confirmTap(bot, cq, record, `o${arg}`))) return undefined;
      const body = { optionId: option.id, idempotencyKey: `telegram-decision-${record.refId}` };
      return await act(bot, cq, record, () => bot.pc.decide(record.refId, body), 'Decided', truncate(option.label, 80));
    }
    if (op === 'x' && record.kind === 'decision' && !record.needsInput) return await act(bot, cq, record, () => bot.pc.dismissDecision(record.refId), 'Dismissed');
    if (op === 's' && record.kind === 'review' && record.stalled && record.issue) {
      if (arg === 'c') return await askForNote(bot, cq, record);
      const choice = REVIEW_ACTIONS[arg];
      // Approve and Send back move the task, so they need a second tap like Done.
      if (choice && !(await confirmTap(bot, cq, record, `s${arg}`))) return undefined;
      if (choice) return await act(bot, cq, record, () => bot.pc.stalledReviewDecision(record.issue.id, { action: choice.action }), choice.kind);
    }
  } catch (err) {
    return reportActionFailure(bot, cq, err);
  }
  return bot.answer(cq.id, 'Unknown action');
}

// The owner's reply to a "Request changes" prompt becomes the note of the decision.
// True when the note was sent.
export async function handleNoteReply(bot, record, msg) {
  try {
    await bot.pc.stalledReviewDecision(record.issue.id, { action: 'request_changes', note: msg.text.trim() });
  } catch (err) {
    await reportFailure(bot, err, msg);
    if (err instanceof PaperclipError && alreadyResolved(record, err)) await resolveRecord(bot, record, RESOLVED_ELSEWHERE);
    return false;
  }
  await resolveRecord(bot, record, 'Changes requested');
  return true;
}
