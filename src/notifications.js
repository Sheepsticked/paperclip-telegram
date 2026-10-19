import { refreshCard, sendCard } from './actions.js';
import { escapeHtml, firstLine, issueUrl, link, prefixOf, runUrl, truncate, truncateLines } from './format.js';
import { PaperclipError } from './paperclip.js';

const INITIAL_CARD_LIMIT = 10;
const CHANGE_SUMMARY_THRESHOLD = 10;
const ISSUE_PAGE = 200;
const SEED_PAGE = 500;
const MAX_ISSUE_PAGES = 10;
const LOOKBACK_MS = 5000;
const NOTIFIED_STATUSES = new Set(['done', 'in_review']);

const iso = (ms) => new Date(ms).toISOString();

async function seedStatuses(bot) {
  const statuses = new Map();
  for (let offset = 0; ; offset += SEED_PAGE) {
    const page = await bot.pc.listIssues(bot.config.companyId, { limit: SEED_PAGE, offset });
    for (const issue of page) statuses.set(issue.id, issue.status);
    if (page.length < SEED_PAGE) break;
  }
  bot.state.statuses = statuses;
}

// Sends one feed card after reading its full record; returns false when there was nothing to send.
async function sendFeedCard(bot, item, cache, sentIssueIds) {
  const issue = item.relatedIssue;
  if (!issue) {
    bot.log.warn('attention card has no related issue; skipped');
    return false;
  }
  let list = cache.get(issue.id);
  if (!list) {
    try {
      list = await bot.pc.listInteractions(issue.id);
    } catch (err) {
      if (err instanceof PaperclipError && err.status === 404) return false;
      throw err;
    }
    cache.set(issue.id, list);
  }
  const interaction = list.find((entry) => entry.id === item.subject.id);
  if (!interaction || interaction.status !== 'pending') return false;
  await sendCard(bot, interaction, { id: issue.id, identifier: issue.identifier, title: issue.title });
  sentIssueIds.add(issue.id);
  return true;
}

async function sendNewCards(bot, feedCards, cache, sentIssueIds, limit = Infinity) {
  const fresh = feedCards.filter((item) => !bot.state.cardByInteraction(item.subject.id));
  for (const item of fresh.slice(0, limit)) await sendFeedCard(bot, item, cache, sentIssueIds);
  return fresh.length - Math.min(fresh.length, limit);
}

async function syncPendingCards(bot, feedCards, cache) {
  const inFeed = new Set(feedCards.map((item) => item.subject.id));
  for (const card of bot.state.pendingCards()) {
    if (!inFeed.has(card.interactionId)) await refreshCard(bot, card, cache);
  }
}

function runPrefix(item) {
  const fromHref = String(item.subject.href ?? '').split('/')[1];
  return fromHref || prefixOf(item.relatedIssue?.identifier);
}

async function sendRunAlert(bot, item) {
  const meta = item.subject.metadata ?? {};
  const issue = item.relatedIssue;
  const agent = meta.agentName ?? (await bot.agentName(meta.agentId)) ?? 'An agent';
  const reason = truncate(firstLine(meta.error ?? meta.retryExhaustedReason ?? item.detail?.failureReasonExcerpt ?? ''), 200);
  const lines = [`⚠️ <b>Run failed</b> · ${escapeHtml(truncate(agent, 80))}`];
  if (issue) lines.push(`<b>${escapeHtml(issue.identifier)}</b> ${escapeHtml(truncate(issue.title, 100))}`);
  const detail = [meta.errorCode, reason].filter(Boolean).join(' — ');
  if (detail) lines.push(escapeHtml(detail));
  lines.push('', link(runUrl(bot.config.uiBaseUrl, runPrefix(item), meta.agentId, item.subject.id), 'Open run'));
  await bot.send(lines.join('\n'), { issue: issue ? { id: issue.id, identifier: issue.identifier } : undefined });
}

async function alertFailedRuns(bot, failedRuns) {
  const skip = new Set(bot.config.routineRunErrorCodes);
  for (const item of failedRuns) {
    const runId = item.subject.id;
    if (bot.state.alertedRuns.includes(runId)) continue;
    if (skip.has(item.subject.metadata?.errorCode)) continue;
    await sendRunAlert(bot, item);
    bot.state.markRunAlerted(runId);
    bot.state.save();
  }
}

async function listUpdatedIssues(bot, since) {
  const issues = [];
  for (let page = 0; page < MAX_ISSUE_PAGES; page += 1) {
    const batch = await bot.pc.listIssues(bot.config.companyId, {
      updatedSince: since,
      sortField: 'updated',
      sortDir: 'desc',
      limit: ISSUE_PAGE,
      offset: page * ISSUE_PAGE,
    });
    issues.push(...batch);
    if (batch.length < ISSUE_PAGE) break;
  }
  return issues;
}

async function lastAgentComment(bot, issueId) {
  try {
    const comments = await bot.pc.listComments(issueId, { limit: 10, order: 'desc' });
    return comments.find((comment) => comment.authorType === 'agent' || (!comment.authorType && comment.authorAgentId)) ?? null;
  } catch (err) {
    // A rejected request means there is nothing to quote; a network or server fault is retried next poll.
    if (err instanceof PaperclipError && err.status >= 400 && err.status < 500 && err.status !== 401) return null;
    throw err;
  }
}

async function sendStatusUpdate(bot, issue) {
  const done = issue.status === 'done';
  const comment = await lastAgentComment(bot, issue.id);
  const lines = [`${done ? '✅ <b>Done</b>' : '👀 <b>In review</b>'} · <b>${escapeHtml(issue.identifier)}</b> ${escapeHtml(truncate(issue.title, 100))}`];
  const excerpt = comment ? truncateLines(comment.body, 5, 400) : '';
  if (excerpt) lines.push(`<blockquote>${escapeHtml(excerpt)}</blockquote>`);
  lines.push(link(issueUrl(bot.config.uiBaseUrl, issue.identifier), 'Open in Paperclip'));
  await bot.send(lines.join('\n'), { issue: { id: issue.id, identifier: issue.identifier } });
}

async function reportStatusChanges(bot, sentIssueIds) {
  const { state } = bot;
  const since = iso(Date.parse(state.lastPollAt) - LOOKBACK_MS);
  const baseline = Date.parse(state.baselineAt);
  const pendingIssueIds = new Set(state.pendingCards().map((card) => card.issueId));
  const changes = [];

  for (const issue of await listUpdatedIssues(bot, since)) {
    const previous = state.statuses.get(issue.id);
    const changed = previous === undefined ? Date.parse(issue.createdAt) > baseline : previous !== issue.status;
    const covered = issue.status === 'in_review' && (sentIssueIds.has(issue.id) || pendingIssueIds.has(issue.id));
    if (changed && NOTIFIED_STATUSES.has(issue.status) && !covered) changes.push(issue);
    else state.statuses.set(issue.id, issue.status);
  }

  if (changes.length > CHANGE_SUMMARY_THRESHOLD) {
    const done = changes.filter((issue) => issue.status === 'done').length;
    await bot.send(`${done} done, ${changes.length - done} in review while the bot was offline, see /status`);
    for (const issue of changes) state.statuses.set(issue.id, issue.status);
    return;
  }
  for (const issue of changes.reverse()) {
    await sendStatusUpdate(bot, issue);
    state.statuses.set(issue.id, issue.status);
    state.save();
  }
}

// One pass over Paperclip: new cards, closed cards, failed runs and done / in-review changes.
export async function pollPaperclip(bot) {
  const { state } = bot;
  const startedAt = bot.now();
  state.pruneCards(startedAt);

  const firstRun = !state.baselineAt;
  if (firstRun) {
    await seedStatuses(bot);
    state.baselineAt = iso(startedAt);
    state.lastPollAt = iso(startedAt);
    state.save();
  }

  const items = await bot.pc.listAttention(bot.config.companyId);
  const feedCards = items.filter((item) => item.sourceKind === 'issue_thread_interaction');
  const failedRuns = items.filter((item) => item.sourceKind === 'failed_run');
  const cache = new Map();
  const sentIssueIds = new Set();

  if (!state.initialSyncDone) {
    const rest = await sendNewCards(bot, feedCards, cache, sentIssueIds, INITIAL_CARD_LIMIT);
    if (rest > 0) await bot.send(`+${rest} more, see /status`);
    for (const item of failedRuns) state.markRunAlerted(item.subject.id);
    state.initialSyncDone = true;
    state.save();
  } else {
    await sendNewCards(bot, feedCards, cache, sentIssueIds);
    await alertFailedRuns(bot, failedRuns);
  }

  await syncPendingCards(bot, feedCards, cache);
  if (!firstRun) await reportStatusChanges(bot, sentIssueIds);
  state.lastPollAt = iso(startedAt);
  state.save();
}
