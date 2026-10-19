import { PaperclipError } from './paperclip.js';
import { button, escapeHtml, truncate } from './format.js';
import { where } from './thread.js';

const PAGE_SIZE = 10;
const FIND_LIMIT = 10;
const STATUS_SECTION_LIMIT = 15;
const AGENTS_BUTTON_LIMIT = 40;

const FILTERS = {
  a: { label: 'All open', status: 'todo,in_progress,in_review,blocked' },
  r: { label: 'Running', status: 'in_progress' },
  v: { label: 'Review', status: 'in_review' },
  b: { label: 'Blocked', status: 'blocked' },
};

// One button per task: identifier and as much of the title as fits.
export function taskRow(issue, { prefix = '' } = {}) {
  return [button(`${prefix}${issue.identifier} · ${issue.title}`, `T:v:${issue.id}`)];
}

function openTasksView(issues, filter, page, hasNext) {
  const { label } = FILTERS[filter];
  const rows = issues.map((issue) => taskRow(issue));
  const nav = [];
  if (page > 0) nav.push(button('◀', `L:t:${filter}:${page - 1}`));
  if (hasNext) nav.push(button('▶', `L:t:${filter}:${page + 1}`));
  if (nav.length > 0) rows.push(nav);
  rows.push(Object.entries(FILTERS).map(([key, entry]) => button(`${key === filter ? '☑' : '☐'} ${entry.label}`, `L:t:${key}:0`)));
  const head = `<b>Open tasks</b> · ${escapeHtml(label)} · page ${page + 1}`;
  return { text: issues.length > 0 ? head : `${head}\nNothing here.`, keyboard: rows };
}

async function loadOpenTasks(bot, filter, page) {
  const rows = await bot.pc.listIssues(bot.config.companyId, {
    status: FILTERS[filter].status,
    sortField: 'updated',
    sortDir: 'desc',
    limit: PAGE_SIZE + 1,
    offset: page * PAGE_SIZE,
  });
  return openTasksView(rows.slice(0, PAGE_SIZE), filter, page, rows.length > PAGE_SIZE);
}

export async function commandTasks(bot, msg) {
  const { text, keyboard } = await loadOpenTasks(bot, 'a', 0);
  await bot.send(text, { keyboard, ...where(bot, msg) });
}

export async function handleListCallback(bot, cq) {
  const [, op, filter, pageText] = String(cq.data).split(':');
  const page = Number(pageText);
  if (op !== 't' || !FILTERS[filter] || !Number.isInteger(page) || page < 0) return bot.answer(cq.id, 'Unknown action');
  try {
    const { text, keyboard } = await loadOpenTasks(bot, filter, page);
    await bot.edit(cq.message.message_id, text, keyboard);
  } catch (err) {
    if (!(err instanceof PaperclipError)) throw err;
    return bot.answer(cq.id, err.network ? 'Paperclip unreachable, try again' : `Paperclip error: ${err.status}`);
  }
  return bot.answer(cq.id);
}

export async function commandFind(bot, msg, query) {
  if (!query) return bot.send('Usage: /find &lt;text&gt;', where(bot, msg));
  const found = await bot.pc.listIssues(bot.config.companyId, { q: query, limit: FIND_LIMIT });
  const quoted = `“${escapeHtml(truncate(query, 60))}”`;
  const text = found.length > 0 ? `<b>Found ${found.length}</b> for ${quoted}` : `Nothing found for ${quoted}`;
  return bot.send(text, { keyboard: found.map((issue) => taskRow(issue)), ...where(bot, msg) });
}

// Task buttons with a "+N more" note in the text when the list is cut.
async function sendSection(bot, msg, title, items, rowFor) {
  const shown = items.slice(0, STATUS_SECTION_LIMIT);
  const lines = [`<b>${title}</b> (${items.length})`];
  if (items.length === 0) lines.push('Nothing here.');
  if (items.length > shown.length) lines.push(`+${items.length - shown.length} more`);
  await bot.send(lines.join('\n'), { keyboard: shown.map(rowFor), ...where(bot, msg) });
}

export async function commandStatus(bot, msg) {
  const { config } = bot;
  const [running, review, items] = await Promise.all([
    bot.pc.listIssues(config.companyId, { status: 'in_progress', limit: 200 }),
    bot.pc.listIssues(config.companyId, { status: 'in_review', limit: 200 }),
    bot.pc.listAttention(config.companyId),
  ]);
  const cards = items.filter((item) => item.sourceKind === 'issue_thread_interaction' && item.relatedIssue);
  const cardIssueIds = new Set(cards.map((item) => item.relatedIssue.id));

  const names = new Map();
  for (const issue of running.slice(0, STATUS_SECTION_LIMIT)) names.set(issue.id, (await bot.agentName(issue.assigneeAgentId)) ?? 'unassigned');

  const waiting = [
    ...cards.map((item) => ({ ...item.relatedIssue, title: item.subject.title ?? item.relatedIssue.title })),
    ...review.filter((issue) => !cardIssueIds.has(issue.id)),
  ];
  await sendSection(bot, msg, 'Running', running, (issue) => [
    button(`${issue.identifier} · ${truncate(issue.title, 40)} — ${names.get(issue.id)}`, `T:v:${issue.id}`),
  ]);
  await sendSection(bot, msg, 'Waiting for you', waiting, (issue) => [button(`${issue.identifier} · ${issue.title}`, `T:v:${issue.id}`)]);
}

export async function commandFollowing(bot, msg) {
  const entries = [...bot.state.following].reverse();
  const text = entries.length > 0 ? `<b>Following</b> (${entries.length})` : 'You are not following any task. Open a task and tap Follow.';
  const rows = entries.map(([id, entry]) => taskRow({ id, status: entry.status, identifier: entry.identifier, title: entry.title }));
  await bot.send(text, { keyboard: rows, ...where(bot, msg) });
}

export async function commandAgents(bot, msg) {
  const [agents, working] = await Promise.all([
    bot.agentRecords({ fresh: true }),
    bot.pc.listIssues(bot.config.companyId, { status: 'in_progress', limit: 200 }),
  ]);
  const lines = ['<b>Agents</b>'];
  const rows = [];
  for (const agent of [...agents].sort((a, b) => a.name.localeCompare(b.name))) {
    const tasks = working.filter((issue) => issue.assigneeAgentId === agent.id);
    lines.push(`- <b>${escapeHtml(agent.name)}</b> — ${escapeHtml(agent.status)}${tasks.length > 0 ? `, ${tasks.length} in progress` : ''}`);
    for (const issue of tasks) rows.push(taskRow(issue, { prefix: `${agent.name}: ` }));
  }
  if (agents.length === 0) lines.push('No agents.');
  if (rows.length > AGENTS_BUTTON_LIMIT) lines.push(`+${rows.length - AGENTS_BUTTON_LIMIT} more tasks, see /status`);
  await bot.send(lines.join('\n'), { keyboard: rows.slice(0, AGENTS_BUTTON_LIMIT), ...where(bot, msg) });
}
