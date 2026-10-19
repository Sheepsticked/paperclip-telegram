import { refreshCard, sendCard } from './actions.js';
import { pollFollowing } from './follow.js';
import { escapeHtml, firstLine, headline, issueUrl, link, prefixOf, runUrl, taskButton, truncate, truncateLines } from './format.js';
import { guarded, isUnauthorized } from './guard.js';
import { PaperclipError } from './paperclip.js';
import { allow, announceMuteEnd } from './settings.js';
import { syncTopics } from './topics.js';

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
    for (const issue of page) {
      statuses.set(issue.id, issue.status);
      bot.state.notePrefix(issue.identifier);
    }
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

// Sends the cards that are new (at most `limit`) and returns the interaction ids left over.
async function sendNewCards(bot, feedCards, cache, sentIssueIds, limit = Infinity) {
  const { state } = bot;
  const fresh = feedCards.filter((item) => !state.cardByInteraction(item.subject.id) && !state.skippedCards.includes(item.subject.id));
  for (const item of fresh.slice(0, limit)) {
    await guarded(bot, `card ${item.relatedIssue?.identifier ?? item.subject.id}`, () => sendFeedCard(bot, item, cache, sentIssueIds));
  }
  return fresh.slice(limit).map((item) => item.subject.id);
}

async function syncPendingCards(bot, feedCards, cache) {
  const inFeed = new Set(feedCards.map((item) => item.subject.id));
  for (const card of bot.state.pendingCards()) {
    if (inFeed.has(card.interactionId)) continue;
    await guarded(bot, `card ${card.identifier}`, () => refreshCard(bot, card, cache));
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
  const detail = [meta.errorCode, reason].filter(Boolean).join(' — ');
  const url = runUrl(bot.config.uiBaseUrl, runPrefix(item), meta.agentId, item.subject.id);
  const compose = (head, body) => [head, ...body.filter(Boolean).map(escapeHtml), link(url, 'Open in Paperclip')].join('\n');
  if (!issue) {
    await bot.send(compose(`<b>Run failed</b> · ${escapeHtml(truncate(agent, 80))}`, [detail]));
    return;
  }
  const who = [truncate(agent, 80), detail].filter(Boolean).join(': ');
  await bot.sendAbout(issue, ({ own }) => ({ text: compose(headline('Run failed', issue, { own }), [who]), keyboard: [[taskButton(issue.id)]] }));
}

async function alertFailedRuns(bot, failedRuns) {
  const skip = new Set(bot.config.routineRunErrorCodes);
  for (const item of failedRuns) {
    const runId = item.subject.id;
    if (bot.state.alertedRuns.includes(runId)) continue;
    if (skip.has(item.subject.metadata?.errorCode)) continue;
    await guarded(bot, `run ${runId}`, async () => {
      if (allow(bot, 'runFailed')) await sendRunAlert(bot, item);
      bot.state.markRunAlerted(runId);
      bot.state.save();
    });
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
    // Without the comment the message still goes out, just without a quote.
    if (isUnauthorized(err)) throw err;
    bot.log.warn(`could not read the comments of ${issueId}`, { error: err.message });
    return null;
  }
}

// Sends the done / in-review message and returns the id of the comment it quotes, if any.
async function sendStatusUpdate(bot, issue) {
  const done = issue.status === 'done';
  const comment = await lastAgentComment(bot, issue.id);
  const excerpt = comment ? truncateLines(comment.body, 5, 400) : '';
  await bot.sendAbout(issue, ({ own }) => {
    const lines = [headline(done ? 'Done' : 'In review', issue, { own })];
    if (excerpt) lines.push(`<blockquote>${escapeHtml(excerpt)}</blockquote>`);
    lines.push(link(issueUrl(bot.config.uiBaseUrl, issue.identifier), 'Open in Paperclip'));
    return { text: lines.join('\n'), keyboard: [[taskButton(issue.id)]] };
  });
  return excerpt ? comment.id : null;
}

async function reportStatusChanges(bot, sentIssueIds) {
  const { state } = bot;
  const since = iso(Date.parse(state.lastPollAt) - LOOKBACK_MS);
  const baseline = Date.parse(state.baselineAt);
  const pendingIssueIds = new Set(state.pendingCards().map((card) => card.issueId));
  const changes = [];
  const updated = await listUpdatedIssues(bot, since);

  for (const issue of updated) {
    const previous = state.statuses.get(issue.id);
    const changed = previous === undefined ? Date.parse(issue.createdAt) > baseline : previous !== issue.status;
    const covered = issue.status === 'in_review' && (sentIssueIds.has(issue.id) || pendingIssueIds.has(issue.id));
    if (changed && NOTIFIED_STATUSES.has(issue.status) && !covered) changes.push(issue);
    else state.statuses.set(issue.id, issue.status);
  }

  // Turned-off and muted kinds are dropped here (muted ones are counted for the catch-up line).
  const outgoing = changes.filter((issue) => {
    const send = allow(bot, issue.status === 'done' ? 'done' : 'inReview');
    if (!send) state.statuses.set(issue.id, issue.status);
    return send;
  });

  const quoted = new Set();
  if (outgoing.length > CHANGE_SUMMARY_THRESHOLD) {
    const done = outgoing.filter((issue) => issue.status === 'done').length;
    await bot.send(`${done} done, ${outgoing.length - done} in review since the last check, see /status`);
    for (const issue of outgoing) state.statuses.set(issue.id, issue.status);
  } else {
    for (const issue of outgoing.reverse()) {
      const quote = await sendStatusUpdate(bot, issue);
      if (quote) quoted.add(quote);
      state.statuses.set(issue.id, issue.status);
      state.save();
    }
  }
  await syncTopics(bot, updated);
  await pollFollowing(bot, updated, quoted);
}

// One pass over Paperclip: new cards, closed cards, failed runs and done / in-review changes.
export async function pollPaperclip(bot) {
  const { state } = bot;
  const startedAt = bot.now();
  state.pruneCards(startedAt);
  state.pruneOffers(startedAt);
  await announceMuteEnd(bot);

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
    for (const interactionId of rest) state.skipCard(interactionId);
    for (const item of failedRuns) state.markRunAlerted(item.subject.id);
    state.initialSyncDone = true;
    state.save();
    if (rest.length > 0) await guarded(bot, 'the first-start summary', () => bot.send(`+${rest.length} more, see /status`));
  } else {
    await sendNewCards(bot, feedCards, cache, sentIssueIds);
    await alertFailedRuns(bot, failedRuns);
  }

  await syncPendingCards(bot, feedCards, cache);
  if (!firstRun) await reportStatusChanges(bot, sentIssueIds);
  state.lastPollAt = iso(startedAt);
  state.save();
}
