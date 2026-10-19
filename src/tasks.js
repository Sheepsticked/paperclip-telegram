import { authorName } from './comments.js';
import { docsKeyboard, sendDocument } from './docs.js';
import { followIssue, unfollowIssue } from './follow.js';
import { ago, button, escapeHtml, fitMessage, headline, issueUrl, link, quote, statusName, truncate } from './format.js';
import { PaperclipError } from './paperclip.js';
import { ID_PREFIX, byPrefix } from './pick.js';
import { RICH_LIMIT, RICH_QUOTE_MAX, escapeRich, richBody, richJoin } from './rich.js';
import { ownTopic, threadOf } from './thread.js';

export { ID_PREFIX, byPrefix };

const COMMENT_SCAN = 3;
const CONFIRM_LABEL = 'Tap again to confirm';
const HIGH_PRIORITIES = new Set(['high', 'critical']);
const PICKER_PAGE = 8;
const PICKER_AGENT_LIMIT = 40;
const UNASSIGNABLE = new Set(['terminated', 'pending_approval']);

// Progressively smaller text budgets used until the task view fits the Telegram limit.
const LEVELS = [
  { title: 100, description: 300, comment: 200 },
  { title: 80, description: 150, comment: 100 },
  { title: 60, description: 0, comment: 50 },
  { title: 50, description: 0, comment: 0 },
];

// The same for a rich task view, which can hold the description and the comment in full, folded.
const RICH_LEVELS = [{ title: 100, description: RICH_QUOTE_MAX, comment: RICH_QUOTE_MAX }, ...LEVELS];

// Status moves: callback op, target status, button label, answer and whether a second tap is needed.
const MOVES = {
  d: { status: 'done', confirm: true, label: 'Done', done: 'Done' },
  t: { status: 'todo', confirm: false, label: 'To do', done: 'To do' },
  x: { status: 'cancelled', confirm: true, label: 'Cancel task', done: 'Cancelled' },
};

// Parses "ABC-12", "abc-12" or "12" (the most common company prefix is used for a bare number).
export function parseTaskRef(text, defaultPrefix) {
  const match = /^#?(?:([A-Za-z][A-Za-z0-9]*)-)?(\d+)$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const prefix = match[1] ?? defaultPrefix;
  return prefix ? `${prefix.toUpperCase()}-${Number(match[2])}` : null;
}

// The company prefix seen most often; read from a recent issue list when none was seen yet.
export async function guessPrefix(bot) {
  const known = bot.state.topPrefix();
  if (known) return known;
  const recent = await bot.pc.listIssues(bot.config.companyId, { sortField: 'updated', sortDir: 'desc', limit: 100 });
  for (const issue of recent) bot.state.notePrefix(issue.identifier);
  bot.state.save();
  return bot.state.topPrefix();
}

export async function loadTask(bot, ref) {
  const issue = await bot.pc.getIssue(ref);
  bot.state.notePrefix(issue.identifier);
  const recent = await bot.pc.listComments(issue.id, { limit: COMMENT_SCAN, order: 'desc' });
  const comment = recent.find((entry) => !entry.deletedAt) ?? null;
  const author = comment ? await authorName(bot, comment) : null;
  let assignee = 'Unassigned';
  if (issue.assigneeAgentId) assignee = (await bot.agentName(issue.assigneeAgentId)) ?? 'An agent';
  else if (issue.assigneeUserId) assignee = 'You';
  const running = issue.executionRunId ? await runningAgentName(bot, issue.executionAgentNameKey) : null;
  return { issue, comment, author, assignee, running, project: issue.project?.name ?? null };
}

// The agent holding the run: the server reports its lower-cased name, matched here to an agent's name or URL key.
async function runningAgentName(bot, nameKey) {
  const key = String(nameKey ?? '').trim().toLowerCase();
  if (!key) return 'An agent';
  const agents = await bot.agentRecords();
  const found = agents.find((agent) => agent.urlKey === key || String(agent.name ?? '').trim().toLowerCase() === key);
  return found?.name ?? 'An agent';
}

// The status line: "In progress · Dev · Project · updated 5 min ago", with the priority only when it is high.
function statusLine(view, now, esc) {
  const { issue } = view;
  const name = (value) => esc(truncate(value, 60));
  const parts = [esc(statusName(issue.status)), view.running && view.running === view.assignee ? `${name(view.assignee)} running` : name(view.assignee)];
  if (view.running && view.running !== view.assignee) parts.push(`${name(view.running)} running`);
  if (view.project) parts.push(name(view.project));
  parts.push(`updated ${ago(issue.updatedAt, now)}`);
  if (HIGH_PRIORITIES.has(issue.priority)) parts.push(`${issue.priority} priority`);
  return parts.join(' · ');
}

// The task view as classic HTML, or as rich Markdown with `rich` set.
function composeTask(view, { note, own, now, uiBaseUrl }, level, rich = false) {
  const { issue } = view;
  const esc = rich ? escapeRich : escapeHtml;
  const url = issueUrl(uiBaseUrl, issue.identifier);
  const title = issue.title ? ` ${esc(truncate(issue.title, level.title))}` : '';
  const lines = [`<b>${link(url, issue.identifier, esc)}</b>${title}`];
  if (note) lines.push(esc(note));
  lines.push(statusLine(view, now, esc));
  const description = String(issue.description ?? '').trim();
  if (description && level.description > 0) {
    lines.push(rich ? richBody(description, level.description, { uiBaseUrl, fullUrl: url }) : `<blockquote>${escapeHtml(truncate(description, level.description))}</blockquote>`);
  }
  const comment = view.comment;
  const showComment = !own && level.comment > 0 && comment;
  const last = showComment ? (rich ? richBody(comment.body, level.comment, { uiBaseUrl, fullUrl: `${url}#comment-${comment.id}`, hardBreaks: true }) : quote(comment.body, level.comment)) : '';
  if (last) lines.push(`<b>${esc(truncate(view.author, 60))}</b>`, last);
  return rich ? richJoin(lines) : lines.join('\n');
}

// True when the view shows Paperclip Markdown: a description or, outside the task's own topic, a comment.
const hasMarkdown = (view, own) => Boolean(String(view.issue.description ?? '').trim() || (!own && view.comment?.body?.trim()));

// First keyboard: one row. `more` shows the second one with the rarer actions.
export function taskKeyboard(issue, { following, armed, own = false, more = false }) {
  const id = issue.id;
  const confirmable = (op, label, style) => button(armed.has(op) ? CONFIRM_LABEL : label, `T:${op}:${id}`, style);
  const finished = issue.status === 'done' || issue.status === 'cancelled';
  if (!more) {
    const row = [finished ? button('Reopen', `T:t:${id}`, 'primary') : confirmable('d', MOVES.d.label, 'success')];
    if (issue.executionRunId) row.push(button(armed.has('s') ? CONFIRM_LABEL : 'Stop run', `T:s:${id}:${issue.executionRunId.slice(0, ID_PREFIX)}`, 'danger'));
    row.push(button('More', `T:m:${id}`));
    return [row];
  }
  const moves = [];
  if (issue.status !== 'todo') moves.push(button(MOVES.t.label, `T:t:${id}`));
  if (issue.status !== 'cancelled') moves.push(confirmable('x', MOVES.x.label, 'danger'));
  const others = [];
  if (issue.documentSummaries?.length > 0) others.push(button('Docs', `T:l:${id}`));
  if (!own) others.push(button(following ? 'Unfollow' : 'Follow', `T:f:${id}`));
  const rows = [
    [button('Assign', `T:a:${id}`), button('Project', `T:p:${id}:0`)],
    moves,
    others,
    own ? [] : [button('Comment', `T:c:${id}`)],
    [button('Refresh', `T:r:${id}`), button('◀ Back', `T:b:${id}`)],
  ];
  return rows.filter((row) => row.length > 0);
}

// `rich` is the same view as Markdown, and `hasMarkdown` says whether it has Paperclip Markdown to show.
export function renderTask(bot, view, { note = null, own = false, armed = new Set(), more = false } = {}) {
  const context = { note, own, now: bot.now(), uiBaseUrl: bot.config.uiBaseUrl };
  const text = fitMessage((level) => composeTask(view, context, level), LEVELS);
  const rich = fitMessage((level) => composeTask(view, context, level, true), RICH_LEVELS, RICH_LIMIT);
  const keyboard = taskKeyboard(view.issue, { following: bot.state.isFollowing(view.issue.id), armed, own, more });
  return { text, rich, hasMarkdown: hasMarkdown(view, own), keyboard };
}

// Sends an already loaded task view as a new message; replies to it become comments on the task.
export async function sendLoadedView(bot, view, { note = null, replyTo, thread = null } = {}) {
  const { issue } = view;
  const { text, rich, hasMarkdown: markdown, keyboard } = renderTask(bot, view, { note, own: ownTopic(bot, issue.id, thread) });
  const messageId = await bot.send(text, { keyboard, replyTo, thread, rich: markdown ? rich : null, issue: { id: issue.id, identifier: issue.identifier } });
  return { issue, messageId };
}

export async function sendTaskView(bot, ref, options = {}) {
  return sendLoadedView(bot, await loadTask(bot, ref), options);
}

// Re-reads the task and edits the view message in place.
async function showTask(bot, message, ref, view, { more = false } = {}) {
  const current = view ?? (await loadTask(bot, ref));
  const own = ownTopic(bot, current.issue.id, threadOf(bot, message));
  const { text, rich, keyboard } = renderTask(bot, current, { own, armed: bot.armedOps(message.message_id), more });
  await bot.edit(message.message_id, text, keyboard, rich);
}

// What the owner is told when Paperclip refuses or fails a button action.
export async function reportActionFailure(bot, cq, err, notFound = 'Task not found') {
  if (!(err instanceof PaperclipError)) throw err;
  if (err.network) return bot.answer(cq.id, 'Paperclip unreachable, try again');
  if (err.status === 401) {
    await bot.paperclipFailed(err);
    return bot.answer(cq.id, 'Paperclip token rejected');
  }
  if (err.status === 404) return bot.answer(cq.id, notFound, true);
  const text = err.status >= 500 ? `Paperclip error: ${err.status}` : err.detail || `Paperclip error: ${err.status}`;
  return bot.answer(cq.id, text, true);
}

async function moveStatus(bot, cq, issueId, op) {
  const move = MOVES[op];
  const messageId = cq.message.message_id;
  if (move.confirm && !bot.isArmed(messageId, op)) {
    // Cancel task sits on the second keyboard, so that is the one redrawn.
    const more = op === 'x';
    bot.arm(messageId, op, () => showTask(bot, cq.message, issueId, null, { more }));
    await showTask(bot, cq.message, issueId, null, { more });
    return bot.answer(cq.id, CONFIRM_LABEL);
  }
  await bot.pc.updateIssue(issueId, { status: move.status });
  bot.disarm(messageId);
  await showTask(bot, cq.message, issueId);
  return bot.answer(cq.id, move.done);
}

// Stopping a run needs two taps; the second one checks that the run is still the one that was shown.
async function stopRun(bot, cq, issueId, prefix) {
  const messageId = cq.message.message_id;
  if (!bot.isArmed(messageId, 's')) {
    bot.arm(messageId, 's', () => showTask(bot, cq.message, issueId));
    await showTask(bot, cq.message, issueId);
    return bot.answer(cq.id, CONFIRM_LABEL);
  }
  bot.disarm(messageId);
  const { executionRunId: runId } = await bot.pc.getIssue(issueId);
  if (!runId || !runId.startsWith(prefix)) {
    await showTask(bot, cq.message, issueId);
    return bot.answer(cq.id, 'The run already ended');
  }
  await bot.pc.cancelRun(runId);
  await showTask(bot, cq.message, issueId);
  return bot.answer(cq.id, 'Run stopped');
}

// Turns the first keyboard of the task view into the second one.
// Opening it, a picker or Docs cancels a pending two-tap, so its timer cannot redraw over them.
async function openMore(bot, cq, issueId) {
  const issue = await bot.pc.getIssue(issueId);
  const own = ownTopic(bot, issue.id, threadOf(bot, cq.message));
  bot.disarm(cq.message.message_id);
  const keyboard = taskKeyboard(issue, { following: bot.state.isFollowing(issue.id), armed: new Set(), own, more: true });
  await bot.editKeyboard(cq.message.message_id, keyboard);
  return bot.answer(cq.id);
}

// Turns the buttons of the task view into one button per document.
async function openDocs(bot, cq, issueId) {
  const { documentSummaries } = await bot.pc.getIssue(issueId);
  if (!documentSummaries?.length) {
    await showTask(bot, cq.message, issueId);
    return bot.answer(cq.id, 'No documents');
  }
  bot.disarm(cq.message.message_id);
  await bot.editKeyboard(cq.message.message_id, docsKeyboard(issueId, documentSummaries));
  return bot.answer(cq.id);
}

export function assignableAgents(agents) {
  return agents.filter((agent) => !UNASSIGNABLE.has(agent.status)).sort((a, b) => a.name.localeCompare(b.name));
}

async function openAgentPicker(bot, cq, issueId) {
  const agents = assignableAgents(await bot.agentRecords({ fresh: true })).slice(0, PICKER_AGENT_LIMIT);
  const rows = agents.map((agent) => [button(agent.name, `T:A:${issueId}:${agent.id.slice(0, ID_PREFIX)}`)]);
  rows.push([button('◀ Back', `T:b:${issueId}`)]);
  bot.disarm(cq.message.message_id);
  await bot.editKeyboard(cq.message.message_id, rows);
  return bot.answer(cq.id);
}

async function assign(bot, cq, issueId, prefix) {
  const agent = byPrefix(assignableAgents(await bot.agentRecords({ fresh: true })), prefix);
  if (!agent) return bot.answer(cq.id, 'Agent not found', true);
  // The server allows one assignee, so a user assignee is cleared together with the new agent.
  await bot.pc.updateIssue(issueId, { assigneeAgentId: agent.id, assigneeUserId: null });
  bot.disarm(cq.message.message_id);
  await showTask(bot, cq.message, issueId);
  return bot.answer(cq.id, `Assigned to ${agent.name}`);
}

export function projectPickerKeyboard(issueId, projects, page) {
  const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name));
  const pages = Math.max(1, Math.ceil(sorted.length / PICKER_PAGE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const rows = sorted
    .slice(current * PICKER_PAGE, (current + 1) * PICKER_PAGE)
    .map((project) => [button(project.name, `T:P:${issueId}:${project.id.slice(0, ID_PREFIX)}`)]);
  if (pages > 1) {
    rows.push([
      ...(current > 0 ? [button('◀', `T:p:${issueId}:${current - 1}`)] : []),
      button(`${current + 1}/${pages}`, `T:p:${issueId}:${current}`),
      ...(current < pages - 1 ? [button('▶', `T:p:${issueId}:${current + 1}`)] : []),
    ]);
  }
  rows.push([button('No project', `T:P:${issueId}:-`), button('◀ Back', `T:b:${issueId}`)]);
  return rows;
}

async function openProjectPicker(bot, cq, issueId, page) {
  const projects = await bot.projectList();
  bot.disarm(cq.message.message_id);
  await bot.editKeyboard(cq.message.message_id, projectPickerKeyboard(issueId, projects, page));
  return bot.answer(cq.id);
}

async function setProject(bot, cq, issueId, prefix) {
  let project = null;
  if (prefix !== '-') {
    project = byPrefix(await bot.projectList(), prefix);
    if (!project) return bot.answer(cq.id, 'Project not found', true);
  }
  await bot.pc.updateIssue(issueId, { projectId: project?.id ?? null });
  bot.disarm(cq.message.message_id);
  await showTask(bot, cq.message, issueId);
  return bot.answer(cq.id, project ? `Project: ${project.name}` : 'No project');
}

async function toggleFollow(bot, cq, issueId) {
  const view = await loadTask(bot, issueId);
  let answer;
  if (bot.state.isFollowing(issueId)) {
    unfollowIssue(bot, issueId);
    answer = 'Unfollowed';
  } else {
    const dropped = await followIssue(bot, view.issue);
    answer = dropped ? `Following (dropped ${dropped})` : 'Following';
  }
  await showTask(bot, cq.message, issueId, view);
  return bot.answer(cq.id, answer);
}

async function askForComment(bot, cq, issueId) {
  const identifier = bot.state.identifiers.get(issueId);
  const lead = identifier ? `${headline('Comment', { identifier }, { url: issueUrl(bot.config.uiBaseUrl, identifier) })}\n` : '';
  await bot.send(`${lead}Reply to this message with your comment.`, {
    replyTo: cq.message.message_id,
    thread: threadOf(bot, cq.message),
    forceReply: 'Comment',
    issue: { id: issueId, identifier: identifier ?? null },
  });
  return bot.answer(cq.id, 'Reply with your comment');
}

export async function handleTaskCallback(bot, cq) {
  const [, op, issueId, arg] = String(cq.data).split(':');
  if (!issueId || !cq.message?.message_id) return bot.answer(cq.id, 'Unknown action');
  try {
    if (op === 'v') {
      await sendTaskView(bot, issueId, { thread: threadOf(bot, cq.message) });
      return await bot.answer(cq.id);
    }
    if (op === 'r') {
      await showTask(bot, cq.message, issueId);
      return await bot.answer(cq.id, 'Refreshed');
    }
    if (op === 'c') return await askForComment(bot, cq, issueId);
    if (op === 'm') return await openMore(bot, cq, issueId);
    if (MOVES[op]) return await moveStatus(bot, cq, issueId, op);
    if (op === 'a') return await openAgentPicker(bot, cq, issueId);
    if (op === 'A') return await assign(bot, cq, issueId, arg ?? '');
    if (op === 'p') return await openProjectPicker(bot, cq, issueId, Number(arg) || 0);
    if (op === 'P') return await setProject(bot, cq, issueId, arg ?? '');
    if (op === 'f') return await toggleFollow(bot, cq, issueId);
    if (op === 's') return await stopRun(bot, cq, issueId, arg ?? '');
    if (op === 'l') return await openDocs(bot, cq, issueId);
    if (op === 'D') {
      await sendDocument(bot, cq, issueId, arg ?? '');
      return undefined;
    }
    if (op === 'b') {
      bot.disarm(cq.message.message_id);
      await showTask(bot, cq.message, issueId);
      return await bot.answer(cq.id);
    }
  } catch (err) {
    return reportActionFailure(bot, cq, err);
  }
  return bot.answer(cq.id, 'Unknown action');
}
