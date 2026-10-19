import { refreshCard, sendCard } from './actions.js';
import { updateBoard } from './board.js';
import { pollFollowing } from './follow.js';
import { ALERT_LIMIT, MESSAGE_LIMIT, QUOTE_LEVELS, escapeHtml, firstLine, fitMessage, headline, issueUrl, kindWord, link, openRows, prefixOf, quote, runUrl, truncate } from './format.js';
import { guarded, isTelegramOutage, isUnauthorized } from './guard.js';
import { INBOX_KINDS, isFreshInbox, itemIssueId, sendInboxItem, syncInbox } from './inbox.js';
import { PaperclipError } from './paperclip.js';
import { RICH_ALERT_LIMIT, RICH_LIMIT, RICH_QUOTE_LEVELS, escapeRich, richBody, richJoin } from './rich.js';
import { allow, announceMuteEnd } from './settings.js';
import { syncTopics } from './topics.js';

const INITIAL_LIMIT = 10;
const CHANGE_SUMMARY_THRESHOLD = 10;
const ISSUE_PAGE = 200;
const SEED_PAGE = 500;
const MAX_ISSUE_PAGES = 10;
const LOOKBACK_MS = 5000;
const NOTIFIED_STATUSES = new Set(['done', 'in_review']);
const MAX_STATUS_TRIES = 3;

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

// Feed items that have no message yet and are not skipped, in feed order: cards and inbox items.
function freshEntries(bot, items) {
  const { state } = bot;
  const entries = [];
  for (const item of items) {
    if (item.sourceKind === 'issue_thread_interaction') {
      if (!state.cardByInteraction(item.subject.id) && !state.skippedCards.includes(item.subject.id)) entries.push({ type: 'card', item });
    } else if (INBOX_KINDS.has(item.sourceKind) && !item.dismissal?.isActive && isFreshInbox(bot, item)) {
      entries.push({ type: 'inbox', item });
    }
  }
  return entries;
}

// A review that is not stalled has no buttons; it waits for the status messages so it can be left out when they cover it.
const isPlainReview = (item) => item.sourceKind === 'review' && item.subject?.metadata?.reviewAttentionState !== 'stalled';

// Sends the entries; plain reviews are returned for later.
async function sendEntries(bot, entries, cache, sentIssueIds) {
  const later = [];
  for (const { type, item } of entries) {
    if (type === 'card') {
      await guarded(bot, `card ${item.relatedIssue?.identifier ?? item.subject.id}`, () => sendFeedCard(bot, item, cache, sentIssueIds));
    } else if (isPlainReview(item)) {
      later.push(item);
    } else {
      await guarded(bot, `${item.sourceKind} ${item.subject?.id}`, () => sendInboxItem(bot, item));
    }
  }
  return later;
}

// Which entries go first when only some of them are sent: questions and approvals, decisions, stalled reviews, the rest.
function rank({ type, item }) {
  if (type === 'card' || item.sourceKind === 'approval') return 0;
  if (item.sourceKind === 'decision') return 1;
  return item.sourceKind === 'review' && !isPlainReview(item) ? 2 : 3;
}

// Sends what is new. Entries that were never offered in this chat (everything on the first start, the inbox kinds after
// an upgrade, cards and inbox items after a chat change) are held to INITIAL_LIMIT; the rest are skipped.
async function sendFresh(bot, items, cache, sentIssueIds) {
  const { state } = bot;
  const firstStart = !state.initialSyncDone;
  const limitCards = firstStart || state.cardResync;
  const limitInbox = firstStart || !state.inboxSyncDone;
  const limited = [];
  const free = [];
  for (const entry of freshEntries(bot, items)) {
    if (!(entry.type === 'card' ? limitCards : limitInbox)) free.push(entry);
    // A review of a task that is already in review is not news.
    else if (entry.type === 'inbox' && isPlainReview(entry.item) && state.statuses.get(itemIssueId(entry.item)) === 'in_review') state.skipInbox(entry.item.dedupKey);
    else limited.push(entry);
  }
  limited.sort((a, b) => rank(a) - rank(b));
  const rest = limited.slice(INITIAL_LIMIT);
  const reviews = await sendEntries(bot, [...limited.slice(0, INITIAL_LIMIT), ...free], cache, sentIssueIds);
  for (const { type, item } of rest) {
    if (type === 'card') state.skipCard(item.subject.id);
    else state.skipInbox(item.dedupKey);
  }
  state.initialSyncDone = true;
  state.inboxSyncDone = true;
  state.cardResync = false;
  state.save();
  if (rest.length > 0) await guarded(bot, 'the first-start summary', () => bot.send(`+${rest.length} more, see /status`));
  return reviews;
}

// Issues that already have a card, an approval message or an in-review message.
function coveredIssueIds(bot, items, sentIssueIds, reviewedIssueIds) {
  const { state } = bot;
  const covered = new Set([...sentIssueIds, ...reviewedIssueIds, ...state.pendingCards().map((card) => card.issueId)]);
  for (const record of state.openInbox()) if (record.kind === 'approval') [record.issue?.id, record.issueId].forEach((id) => id && covered.add(id));
  for (const item of items) if (item.sourceKind === 'approval' && item.subject?.metadata?.issueId) covered.add(item.subject.metadata.issueId);
  return covered;
}

async function sendReviews(bot, reviews, covered) {
  const { state } = bot;
  for (const item of reviews) {
    const id = item.subject?.id;
    // An in-review message already went out for the task, in this poll or an earlier one.
    const announced = state.reviewSent.has(id) && state.statuses.get(id) === 'in_review';
    if (covered.has(id) || announced) state.skipInbox(item.dedupKey);
    else await guarded(bot, `review ${item.subject?.identifier ?? item.subject?.id}`, () => sendInboxItem(bot, item));
  }
  bot.state.save();
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
  const agentLink = link(runUrl(bot.config.uiBaseUrl, runPrefix(item), meta.agentId, item.subject.id), truncate(agent, 80));
  if (!issue) {
    await bot.send([`${kindWord('Run failed')} · ${agentLink}`, escapeHtml(detail)].filter(Boolean).join('\n'), { alert: true });
    return;
  }
  const who = `${agentLink}${detail ? `: ${escapeHtml(detail)}` : ''}`;
  await bot.sendAbout(
    issue,
    ({ own }) => ({
      text: `${headline('Run failed', issue, { own, url: issueUrl(bot.config.uiBaseUrl, issue.identifier) })}\n${who}`,
      keyboard: openRows(issue.id, own),
    }),
    { alert: true },
  );
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

// A finished task with no parent: the one status change that makes a sound.
const isTopLevelDone = (issue) => issue.status === 'done' && !issue.parentId;

// Sends the done / in-review message. It quotes the last agent comment unless the chat already showed that comment.
async function sendStatusUpdate(bot, issue) {
  const kind = issue.status === 'done' ? 'Done' : 'In review';
  const found = await lastAgentComment(bot, issue.id);
  const comment = found && !bot.state.hasShown(found.id) ? found : null;
  const alert = isTopLevelDone(issue);
  let quoted = false;
  const { uiBaseUrl } = bot.config;
  const url = issueUrl(uiBaseUrl, issue.identifier);
  const build = ({ own }) => {
    const head = headline(kind, issue, { own, url });
    const text = (max) => {
      const body = comment ? quote(comment.body, max) : '';
      quoted = body !== '';
      return [head, body].filter(Boolean).join('\n');
    };
    // The last build is the one that fits, so `quoted` describes the sent text.
    const fitted = { text: fitMessage(text, QUOTE_LEVELS, alert ? ALERT_LIMIT : MESSAGE_LIMIT), keyboard: openRows(issue.id, own) };
    if (!comment) return fitted;
    const richHead = headline(kind, issue, { own, url, esc: escapeRich });
    const context = { uiBaseUrl, fullUrl: `${url}#comment-${comment.id}` };
    let richQuoted = false;
    const rich = fitMessage(
      (max) => {
        const body = richBody(comment.body, max, context);
        richQuoted = body !== '';
        return richJoin([richHead, body]);
      },
      RICH_QUOTE_LEVELS,
      alert ? RICH_ALERT_LIMIT : RICH_LIMIT,
    );
    quoted ||= richQuoted;
    return richQuoted ? { ...fitted, rich } : fitted;
  };
  await bot.sendAbout(issue, build, { alert });
  if (quoted) bot.state.noteShown(comment.id);
}

// Issues whose status message failed earlier may have left the update window, so they are read again.
async function retriedIssues(bot, updated) {
  const { state } = bot;
  const inWindow = new Set(updated.map((issue) => issue.id));
  const issues = [];
  for (const issueId of [...state.statusRetries.keys()]) {
    if (inWindow.has(issueId)) continue;
    const issue = await guarded(bot, `the retry of ${issueId}`, async () => {
      try {
        return await bot.pc.getIssue(issueId);
      } catch (err) {
        if (err instanceof PaperclipError && err.status === 404) return null;
        throw err;
      }
    });
    if (issue) {
      issues.push(issue);
    } else if (issue === null) {
      state.statusRetries.delete(issueId);
    } else {
      // A task that cannot be read counts as a failed try, so the retry ends.
      const { status } = state.statusRetries.get(issueId);
      if (state.noteStatusFailure(issueId, status) >= MAX_STATUS_TRIES) {
        bot.log.warn(`gave up sending the ${status} message of ${issueId}`);
        state.statuses.set(issueId, status);
        state.statusRetries.delete(issueId);
      }
    }
    state.save();
  }
  return issues;
}

// Sends one done / in-review message. A failed one is tried again on the next poll and given up after MAX_STATUS_TRIES.
async function deliverStatus(bot, issue, reviewed) {
  const { state } = bot;
  try {
    await sendStatusUpdate(bot, issue);
    if (issue.status === 'in_review') {
      reviewed.add(issue.id);
      state.noteReviewSent(issue.id);
    }
  } catch (err) {
    if (isUnauthorized(err) || isTelegramOutage(err)) throw err;
    const tries = state.noteStatusFailure(issue.id, issue.status);
    if (tries < MAX_STATUS_TRIES) {
      bot.log.warn(`could not send the ${issue.status} message of ${issue.identifier}; trying again`, { error: err.message });
      state.save();
      return;
    }
    bot.log.warn(`gave up sending the ${issue.status} message of ${issue.identifier}`, { error: err.message });
  }
  state.statuses.set(issue.id, issue.status);
  state.statusRetries.delete(issue.id);
  state.save();
}

async function reportStatusChanges(bot, sentIssueIds) {
  const { state } = bot;
  const since = iso(Date.parse(state.lastPollAt) - LOOKBACK_MS);
  const baseline = Date.parse(state.baselineAt);
  const pendingIssueIds = new Set(state.pendingCards().map((card) => card.issueId));
  const changes = [];
  const windowIssues = await listUpdatedIssues(bot, since);
  const updated = [...windowIssues, ...(await retriedIssues(bot, windowIssues))];

  for (const issue of updated) {
    const previous = state.statuses.get(issue.id);
    const changed = previous === undefined ? Date.parse(issue.createdAt) > baseline : previous !== issue.status;
    const covered = issue.status === 'in_review' && (sentIssueIds.has(issue.id) || pendingIssueIds.has(issue.id));
    if (previous === 'in_review' && issue.status !== 'in_review') state.reviewSent.delete(issue.id);
    if (changed && NOTIFIED_STATUSES.has(issue.status) && !covered) {
      changes.push(issue);
    } else {
      state.statuses.set(issue.id, issue.status);
      state.statusRetries.delete(issue.id);
    }
  }

  // Turned-off and muted kinds are dropped here (muted ones are counted for the catch-up line).
  const outgoing = changes.filter((issue) => {
    const send = allow(bot, issue.status === 'done' ? 'done' : 'inReview');
    if (!send) {
      state.statuses.set(issue.id, issue.status);
      state.statusRetries.delete(issue.id);
    }
    return send;
  });

  const reviewed = new Set();
  if (outgoing.length > CHANGE_SUMMARY_THRESHOLD) {
    const done = outgoing.filter((issue) => issue.status === 'done').length;
    await bot.send(`<b>${done} done</b>, ${outgoing.length - done} in review since the last check, see /status`, { alert: outgoing.some(isTopLevelDone) });
    for (const issue of outgoing) {
      state.statuses.set(issue.id, issue.status);
      state.statusRetries.delete(issue.id);
      if (issue.status === 'in_review') {
        reviewed.add(issue.id);
        state.noteReviewSent(issue.id);
      }
    }
  } else {
    for (const issue of outgoing.reverse()) await deliverStatus(bot, issue, reviewed);
  }
  await guarded(bot, 'the topic sync', () => syncTopics(bot, updated));
  await pollFollowing(bot, updated);
  return reviewed;
}

// One pass over Paperclip: new and closed cards and inbox items, failed runs and done / in-review changes.
export async function pollPaperclip(bot) {
  const { state } = bot;
  const startedAt = bot.now();
  state.pruneCards(startedAt);
  state.pruneOffers(startedAt);
  state.pruneInbox(startedAt);
  await announceMuteEnd(bot);

  const firstRun = !state.baselineAt;
  if (firstRun) {
    await seedStatuses(bot);
    state.baselineAt = iso(startedAt);
    state.lastPollAt = iso(startedAt);
    state.save();
  }

  const { items, complete } = await bot.pc.attentionFeed(bot.config.companyId);
  const feedCards = items.filter((item) => item.sourceKind === 'issue_thread_interaction');
  const failedRuns = items.filter((item) => item.sourceKind === 'failed_run');
  const cache = new Map();
  const sentIssueIds = new Set();
  const firstStart = !state.initialSyncDone;
  if (firstStart) for (const item of failedRuns) state.markRunAlerted(item.subject.id);
  const reviews = await sendFresh(bot, items, cache, sentIssueIds);
  if (!firstStart) await alertFailedRuns(bot, failedRuns);

  await syncPendingCards(bot, feedCards, cache);
  await syncInbox(bot, items, complete);
  const reviewed = firstRun ? new Set() : await reportStatusChanges(bot, sentIssueIds);
  await sendReviews(bot, reviews, coveredIssueIds(bot, items, sentIssueIds, reviewed));
  state.lastPollAt = iso(startedAt);
  state.save();
  await updateBoard(bot, items);
}
