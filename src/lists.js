import { PaperclipError } from './paperclip.js';
import { button, escapeHtml, truncate } from './format.js';
import { pickedIcon, showIconPicker } from './icons.js';
import { inboxItems, itemIssueId, statusEntry } from './inbox.js';
import { OPEN_STATUSES, projectsView } from './projects.js';
import { threadOf, where } from './thread.js';
import { syncTopicIcons } from './topics.js';

const PAGE_SIZE = 10;
const FIND_LIMIT = 10;
const STATUS_SECTION_LIMIT = 15;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FILTERS = {
  a: { label: 'All open', status: OPEN_STATUSES },
  r: { label: 'Running', status: 'in_progress' },
  v: { label: 'Review', status: 'in_review' },
  b: { label: 'Blocked', status: 'blocked' },
  d: { label: 'Done', status: 'done' },
};
// The filter buttons are split over two rows so that a phone does not cut their labels.
const FILTER_ROW = 3;

// One button per task: identifier and as much of the title as fits.
export function taskRow(issue, { prefix = '' } = {}) {
  return [button(`${prefix}${issue.identifier} · ${issue.title}`, `T:v:${issue.id}`)];
}

// `project` is { id, name } while the list is limited to one project; every button keeps the limit.
function openTasksView(issues, filter, page, hasNext, project, { icons = false } = {}) {
  const { label } = FILTERS[filter];
  const suffix = project ? `:${project.id}` : '';
  const rows = issues.map((issue) => taskRow(issue));
  const nav = [];
  if (page > 0) nav.push(button('◀', `L:t:${filter}:${page - 1}${suffix}`));
  if (hasNext) nav.push(button('▶', `L:t:${filter}:${page + 1}${suffix}`));
  if (nav.length > 0) rows.push(nav);
  const filters = Object.entries(FILTERS).map(([key, entry]) => button(entry.label, `L:t:${key}:0${suffix}`, key === filter ? 'primary' : undefined));
  for (let first = 0; first < filters.length; first += FILTER_ROW) rows.push(filters.slice(first, first + FILTER_ROW));
  if (project) rows.push([button('All projects', `L:t:${filter}:0`), ...(icons ? [button('Icon', `L:i:${filter}:0:${project.id}`)] : [])]);
  const head = `<b>${filter === 'd' ? 'Tasks' : 'Open tasks'}</b> · ${escapeHtml(label)}${project ? ` · ${escapeHtml(truncate(project.name, 60))}` : ''} · page ${page + 1}`;
  return { text: issues.length > 0 ? head : `${head}\nNothing here.`, keyboard: rows };
}

export async function loadOpenTasks(bot, filter, page, projectId = null) {
  const rows = await bot.pc.listIssues(bot.config.companyId, {
    status: FILTERS[filter].status,
    ...(projectId ? { projectId } : {}),
    sortField: 'updated',
    sortDir: 'desc',
    limit: PAGE_SIZE + 1,
    offset: page * PAGE_SIZE,
  });
  const project = projectId ? await projectOf(bot, projectId) : null;
  // Topic icons only matter when topics are on.
  return openTasksView(rows.slice(0, PAGE_SIZE), filter, page, rows.length > PAGE_SIZE, project, { icons: bot.topics.on });
}

async function projectOf(bot, projectId) {
  return { id: projectId, name: (await bot.projectList()).find((entry) => entry.id === projectId)?.name ?? 'Project' };
}

// The Icon button and the buttons of the picker: open a page of icons, or pick one (an index in the list, or "n" for none).
async function handleIconCallback(bot, cq, { op, filter, arg, projectId }) {
  const messageId = cq.message.message_id;
  if (op === 'i') {
    const page = Number(arg);
    const shown = Number.isInteger(page) && (await showIconPicker(bot, messageId, await projectOf(bot, projectId), filter, page));
    return shown ? bot.answer(cq.id) : bot.answer(cq.id, 'Icons are not available, try again later');
  }
  const iconId = await pickedIcon(bot, arg);
  if (iconId === null) return bot.answer(cq.id, 'Unknown action');
  bot.state.projectIcons.set(projectId, iconId);
  bot.state.save();
  await syncTopicIcons(bot, { projectId });
  const { text, keyboard } = await loadOpenTasks(bot, filter, 0, projectId);
  await bot.edit(messageId, text, keyboard);
  return bot.answer(cq.id, 'Icon set');
}

export async function commandTasks(bot, msg) {
  const { text, keyboard } = await loadOpenTasks(bot, 'a', 0);
  await bot.send(text, { keyboard, ...where(bot, msg) });
}

export async function handleListCallback(bot, cq) {
  const [, op, first, pageText, projectId] = String(cq.data).split(':');
  try {
    if (op === 'p' && UUID.test(first ?? '')) {
      const { text, keyboard } = await loadOpenTasks(bot, 'a', 0, first);
      await bot.send(text, { keyboard, thread: threadOf(bot, cq.message) });
      return await bot.answer(cq.id);
    }
    if (op === 'j' && Number.isInteger(Number(first)) && Number(first) >= 0) {
      const { text, keyboard } = await projectsView(bot, Number(first));
      await bot.edit(cq.message.message_id, text, keyboard);
      return await bot.answer(cq.id);
    }
    if ((op === 'i' || op === 's') && FILTERS[first] && UUID.test(projectId ?? '')) {
      return await handleIconCallback(bot, cq, { op, filter: first, arg: pageText, projectId });
    }
    const page = Number(pageText);
    const validProject = projectId === undefined || UUID.test(projectId);
    if (op !== 't' || !FILTERS[first] || !Number.isInteger(page) || page < 0 || !validProject) return await bot.answer(cq.id, 'Unknown action');
    const { text, keyboard } = await loadOpenTasks(bot, first, page, projectId ?? null);
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

// Sorts what /status and the board show: the cards and inbox items that wait for the owner, the tasks in progress, and the
// tasks in review that no card or inbox item already covers.
export function groupWork({ items, running, review }) {
  const cards = items.filter((item) => item.sourceKind === 'issue_thread_interaction' && item.relatedIssue);
  const inbox = inboxItems(items);
  const covered = new Set([...cards.map((item) => item.relatedIssue.id), ...inbox.map((item) => itemIssueId(item)).filter(Boolean)]);
  return { cards, inbox, running, review: review.filter((issue) => !covered.has(issue.id)) };
}

export async function commandStatus(bot, msg) {
  const { config } = bot;
  const [running, review, items] = await Promise.all([
    bot.pc.listIssues(config.companyId, { status: 'in_progress', limit: 200 }),
    bot.pc.listIssues(config.companyId, { status: 'in_review', limit: 200 }),
    bot.pc.listAttention(config.companyId),
  ]);
  const group = groupWork({ items, running, review });

  const names = new Map();
  for (const issue of group.running.slice(0, STATUS_SECTION_LIMIT)) names.set(issue.id, (await bot.agentName(issue.assigneeAgentId)) ?? 'unassigned');

  const waiting = [
    ...group.cards.map((item) => ({ label: `${item.relatedIssue.identifier} · ${item.subject.title ?? item.relatedIssue.title}`, data: `T:v:${item.relatedIssue.id}` })),
    ...group.inbox.map((item) => statusEntry(bot, item)),
    ...group.review.map((issue) => ({ label: `${issue.identifier} · ${issue.title}`, data: `T:v:${issue.id}` })),
  ];
  await sendSection(bot, msg, 'Running', group.running, (issue) => [
    button(`${issue.identifier} · ${truncate(issue.title, 40)} — ${names.get(issue.id)}`, `T:v:${issue.id}`),
  ]);
  await sendSection(bot, msg, 'Waiting for you', waiting, (entry) => [button(entry.label, entry.data)]);
}

export async function commandFollowing(bot, msg) {
  const entries = [...bot.state.following].reverse();
  const text = entries.length > 0 ? `<b>Following</b> (${entries.length})` : 'You are not following any task. Open a task and tap Follow.';
  const rows = entries.map(([id, entry]) => taskRow({ id, status: entry.status, identifier: entry.identifier, title: entry.title }));
  await bot.send(text, { keyboard: rows, ...where(bot, msg) });
}
