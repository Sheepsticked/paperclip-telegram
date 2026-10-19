import { button } from './format.js';
import { where } from './thread.js';

export const OPEN_STATUSES = 'todo,in_progress,in_review,blocked';
const STATS_CACHE_MS = 60 * 1000;
const STATS_LIMIT = 1000;
const PAGE_SIZE = 10;

// Open task counts per project, and the project ids ordered by their newest open task (one issues call).
export async function projectStats(bot, { fresh = false } = {}) {
  const cache = bot.projectStatsCache;
  if (!fresh && cache && bot.now() - cache.at < STATS_CACHE_MS) return cache;
  const rows = await bot.pc.listIssues(bot.config.companyId, { status: OPEN_STATUSES, sortField: 'updated', sortDir: 'desc', limit: STATS_LIMIT });
  const counts = new Map();
  const order = [];
  for (const issue of rows) {
    if (!issue.projectId) continue;
    if (!counts.has(issue.projectId)) order.push(issue.projectId);
    counts.set(issue.projectId, (counts.get(issue.projectId) ?? 0) + 1);
  }
  bot.projectStatsCache = { at: bot.now(), counts, order };
  return bot.projectStatsCache;
}

// Projects with an open task first, the most recently active first; the rest by name.
export async function orderedProjects(bot, options) {
  const [projects, stats] = await Promise.all([bot.projectList(options), projectStats(bot, options)]);
  return projects
    .map((project) => ({ ...project, open: stats.counts.get(project.id) ?? 0, rank: stats.order.indexOf(project.id) }))
    .sort((a, b) => Number(a.rank < 0) - Number(b.rank < 0) || a.rank - b.rank || a.name.localeCompare(b.name));
}

export async function projectsView(bot, page, options) {
  const projects = await orderedProjects(bot, options);
  const pages = Math.max(1, Math.ceil(projects.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const rows = projects.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map((project) => [button(`${project.name} · ${project.open} open`, `L:p:${project.id}`)]);
  if (pages > 1) {
    rows.push([
      ...(current > 0 ? [button('◀', `L:j:${current - 1}`)] : []),
      button(`${current + 1}/${pages}`, `L:j:${current}`),
      ...(current < pages - 1 ? [button('▶', `L:j:${current + 1}`)] : []),
    ]);
  }
  const head = `<b>Projects</b> (${projects.length})`;
  return { text: projects.length > 0 ? head : `${head}\nNo projects.`, keyboard: rows };
}

export async function commandProjects(bot, msg) {
  const { text, keyboard } = await projectsView(bot, 0, { fresh: true });
  await bot.send(text, { keyboard, ...where(bot, msg) });
}
