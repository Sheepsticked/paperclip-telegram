import { authorName } from './comments.js';
import { followIssue, unfollowIssue } from './follow.js';
import { ago, button, escapeHtml, fitMessage, issueUrl, link, statusIcon, statusName, truncate } from './format.js';
import { PaperclipError } from './paperclip.js';

const COMMENT_COUNT = 3;
const PICKER_PAGE = 8;
const PICKER_AGENT_LIMIT = 40;
export const ID_PREFIX = 8;
const UNASSIGNABLE = new Set(['terminated', 'pending_approval']);

// Progressively smaller text budgets used until the task view fits the Telegram limit.
const LEVELS = [
  { title: 100, description: 300, comment: 200 },
  { title: 80, description: 150, comment: 100 },
  { title: 60, description: 0, comment: 50 },
  { title: 50, description: 0, comment: 0 },
];

// Status moves: callback op, target status and whether a second tap is needed.
const MOVES = {
  d: { status: 'done', confirm: true, done: '✅ Done' },
  t: { status: 'todo', confirm: false, done: '⏳ To do' },
  x: { status: 'cancelled', confirm: true, done: '🚫 Cancelled' },
};

const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

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
  const recent = await bot.pc.listComments(issue.id, { limit: COMMENT_COUNT + 2, order: 'desc' });
  const comments = recent.filter((comment) => !comment.deletedAt).slice(0, COMMENT_COUNT).reverse();
  const authors = await Promise.all(comments.map((comment) => authorName(bot, comment)));
  let assignee = 'Unassigned';
  if (issue.assigneeAgentId) assignee = (await bot.agentName(issue.assigneeAgentId)) ?? 'An agent';
  else if (issue.assigneeUserId) assignee = 'You';
  return { issue, comments, authors, assignee, project: issue.project?.name ?? null };
}

function composeTask(view, { headline, now, uiBaseUrl }, level) {
  const { issue } = view;
  const lines = [`${headline ? `${headline} ` : ''}<b>${escapeHtml(issue.identifier)}</b> ${escapeHtml(truncate(issue.title, level.title))}`];
  lines.push(`Status: ${statusIcon(issue.status)} ${escapeHtml(statusName(issue.status))}`);
  lines.push(`Assignee: ${escapeHtml(truncate(view.assignee, 60))}`);
  lines.push(`Project: ${escapeHtml(truncate(view.project ?? 'None', 60))}`);
  lines.push(`Priority: ${escapeHtml(issue.priority ?? 'medium')}`);
  lines.push(`Updated ${ago(issue.updatedAt, now)}`);
  const description = String(issue.description ?? '').trim();
  if (description && level.description > 0) lines.push('', escapeHtml(truncate(description, level.description)));
  if (view.comments.length > 0 && level.comment > 0) {
    lines.push('', '<b>Last comments</b>');
    view.comments.forEach((comment, index) => {
      lines.push(`• <b>${escapeHtml(truncate(view.authors[index], 60))}</b>: ${escapeHtml(truncate(flat(comment.body), level.comment))}`);
    });
  }
  lines.push('', link(issueUrl(uiBaseUrl, issue.identifier), 'Open in Paperclip'));
  return lines.join('\n');
}

export function taskKeyboard(issue, { following, armed }) {
  const id = issue.id;
  const confirm = (op, label) => button(armed.has(op) ? `${label.split(' ')[0]} Tap again to confirm` : label, `T:${op}:${id}`);
  const moves = [];
  if (issue.status !== 'done') moves.push(confirm('d', MOVES.d.done));
  if (issue.status !== 'todo') moves.push(button('▶ To do', `T:t:${id}`));
  if (issue.status !== 'cancelled') moves.push(confirm('x', '⛔ Cancel'));
  return [
    [button('💬 Comment', `T:c:${id}`), button('🔄 Refresh', `T:r:${id}`)],
    moves,
    [button('👤 Assign', `T:a:${id}`), button('📁 Project', `T:p:${id}:0`)],
    [following ? button('🔕 Unfollow', `T:f:${id}`) : button('🔔 Follow', `T:f:${id}`)],
  ];
}

export function renderTask(bot, view, { headline = null, armed = new Set() } = {}) {
  const context = { headline, now: bot.now(), uiBaseUrl: bot.config.uiBaseUrl };
  return {
    text: fitMessage((level) => composeTask(view, context, level), LEVELS),
    keyboard: taskKeyboard(view.issue, { following: bot.state.isFollowing(view.issue.id), armed }),
  };
}

// Sends the task view as a new message; replies to it become comments on the task.
export async function sendTaskView(bot, ref, { headline = null, replyTo } = {}) {
  const view = await loadTask(bot, ref);
  const { text, keyboard } = renderTask(bot, view, { headline });
  await bot.send(text, { keyboard, replyTo, issue: { id: view.issue.id, identifier: view.issue.identifier } });
  return view.issue;
}

// Re-reads the task and edits the view message in place.
async function showTask(bot, messageId, ref, view) {
  const current = view ?? (await loadTask(bot, ref));
  const { text, keyboard } = renderTask(bot, current, { armed: bot.armedOps(messageId) });
  await bot.edit(messageId, text, keyboard);
}

// What the owner is told when Paperclip refuses or fails a button action.
export async function reportActionFailure(bot, cq, err) {
  if (!(err instanceof PaperclipError)) throw err;
  if (err.network) return bot.answer(cq.id, 'Paperclip unreachable, try again');
  if (err.status === 401) {
    await bot.paperclipFailed(err);
    return bot.answer(cq.id, 'Paperclip token rejected');
  }
  if (err.status === 404) return bot.answer(cq.id, 'Task not found', true);
  const text = err.status >= 500 ? `Paperclip error: ${err.status}` : err.detail || `Paperclip error: ${err.status}`;
  return bot.answer(cq.id, text, true);
}

async function moveStatus(bot, cq, issueId, op) {
  const move = MOVES[op];
  const messageId = cq.message.message_id;
  if (move.confirm && !bot.isArmed(messageId, op)) {
    bot.arm(messageId, op, () => showTask(bot, messageId, issueId));
    await showTask(bot, messageId, issueId);
    return bot.answer(cq.id, 'Tap again to confirm');
  }
  await bot.pc.updateIssue(issueId, { status: move.status });
  bot.disarm(messageId);
  await showTask(bot, messageId, issueId);
  return bot.answer(cq.id, move.done);
}

export function assignableAgents(agents) {
  return agents.filter((agent) => !UNASSIGNABLE.has(agent.status)).sort((a, b) => a.name.localeCompare(b.name));
}

export const byPrefix = (items, prefix) => {
  const found = items.filter((item) => item.id.startsWith(prefix));
  return found.length === 1 ? found[0] : null;
};

async function openAgentPicker(bot, cq, issueId) {
  const agents = assignableAgents(await bot.agentRecords({ fresh: true })).slice(0, PICKER_AGENT_LIMIT);
  const rows = agents.map((agent) => [button(agent.name, `T:A:${issueId}:${agent.id.slice(0, ID_PREFIX)}`)]);
  rows.push([button('◀ Back', `T:b:${issueId}`)]);
  await bot.editKeyboard(cq.message.message_id, rows);
  return bot.answer(cq.id);
}

async function assign(bot, cq, issueId, prefix) {
  const agent = byPrefix(assignableAgents(await bot.agentRecords({ fresh: true })), prefix);
  if (!agent) return bot.answer(cq.id, 'Agent not found', true);
  // The server allows one assignee, so a user assignee is cleared together with the new agent.
  await bot.pc.updateIssue(issueId, { assigneeAgentId: agent.id, assigneeUserId: null });
  bot.disarm(cq.message.message_id);
  await showTask(bot, cq.message.message_id, issueId);
  return bot.answer(cq.id, `👤 ${agent.name}`);
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
  rows.push([button('🚫 No project', `T:P:${issueId}:-`), button('◀ Back', `T:b:${issueId}`)]);
  return rows;
}

async function openProjectPicker(bot, cq, issueId, page) {
  const projects = await bot.projectList();
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
  await showTask(bot, cq.message.message_id, issueId);
  return bot.answer(cq.id, project ? `📁 ${project.name}` : '📁 No project');
}

async function toggleFollow(bot, cq, issueId) {
  const view = await loadTask(bot, issueId);
  let answer;
  if (bot.state.isFollowing(issueId)) {
    unfollowIssue(bot, issueId);
    answer = '🔕 Unfollowed';
  } else {
    const dropped = await followIssue(bot, view.issue);
    answer = dropped ? `🔔 Following (dropped ${dropped})` : '🔔 Following';
  }
  await showTask(bot, cq.message.message_id, issueId, view);
  return bot.answer(cq.id, answer);
}

async function askForComment(bot, cq, issueId) {
  const identifier = bot.state.identifiers.get(issueId);
  const label = identifier ? `<b>${escapeHtml(identifier)}</b>` : 'the task';
  await bot.send(`↩ Reply to this message with your comment on ${label}.`, {
    replyTo: cq.message.message_id,
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
      await sendTaskView(bot, issueId);
      return await bot.answer(cq.id);
    }
    if (op === 'r') {
      await showTask(bot, cq.message.message_id, issueId);
      return await bot.answer(cq.id, 'Refreshed');
    }
    if (op === 'c') return await askForComment(bot, cq, issueId);
    if (MOVES[op]) return await moveStatus(bot, cq, issueId, op);
    if (op === 'a') return await openAgentPicker(bot, cq, issueId);
    if (op === 'A') return await assign(bot, cq, issueId, arg ?? '');
    if (op === 'p') return await openProjectPicker(bot, cq, issueId, Number(arg) || 0);
    if (op === 'P') return await setProject(bot, cq, issueId, arg ?? '');
    if (op === 'f') return await toggleFollow(bot, cq, issueId);
    if (op === 'b') {
      bot.disarm(cq.message.message_id);
      await showTask(bot, cq.message.message_id, issueId);
      return await bot.answer(cq.id);
    }
  } catch (err) {
    return reportActionFailure(bot, cq, err);
  }
  return bot.answer(cq.id, 'Unknown action');
}
