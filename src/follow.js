import { authorName, isBoardComment } from './comments.js';
import { escapeHtml, headline, issueUrl, link, taskButton, truncate, truncateLines } from './format.js';
import { isTelegramOutage, isUnauthorized } from './guard.js';
import { gate } from './settings.js';
import { PaperclipError } from './paperclip.js';

const READ_PAGE = 50;
const MAX_READ_PAGES = 5;
const MAX_SEPARATE_MESSAGES = 5;
const FALLBACK_READ = 20;
const MAX_FOLLOW_TRIES = 3;
const CLOSED = new Set(['done', 'cancelled']);

// Starts following a task from its newest comment on, so nothing old is replayed.
export async function followIssue(bot, issue) {
  const newest = await bot.pc.listComments(issue.id, { limit: 1, order: 'desc' });
  const dropped = bot.state.follow(issue.id, {
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    lastSeenCommentId: newest[0]?.id ?? null,
    lastSeenAt: newest[0]?.createdAt ?? null,
    retry: 0,
  });
  bot.state.save();
  return dropped;
}

export function unfollowIssue(bot, issueId) {
  const removed = bot.state.unfollow(issueId);
  if (removed) bot.state.save();
  return removed;
}

async function sendFollowComment(bot, issue, comment) {
  const author = await authorName(bot, comment);
  const excerpt = truncateLines(comment.body, 5, 400);
  await bot.sendAbout(issue, ({ own }) => {
    const lines = [headline('Comment', issue, { own }), `From ${escapeHtml(truncate(author, 80))}`];
    if (excerpt) lines.push(`<blockquote>${escapeHtml(excerpt)}</blockquote>`);
    lines.push(link(issueUrl(bot.config.uiBaseUrl, issue.identifier), 'Open in Paperclip'));
    return { text: lines.join('\n'), keyboard: [[taskButton(issue.id)]] };
  });
}

async function sendFollowBurst(bot, issue, count) {
  await bot.sendAbout(issue, ({ own }) => {
    const lines = [headline('Comment', issue, { own }), `${count} new comments`, link(issueUrl(bot.config.uiBaseUrl, issue.identifier), 'Open in Paperclip')];
    return { text: lines.join('\n'), keyboard: [[taskButton(issue.id)]] };
  });
}

const moveCursor = (entry, comment) => {
  entry.lastSeenCommentId = comment.id;
  entry.lastSeenAt = comment.createdAt ?? entry.lastSeenAt;
};

// The comments after the saved cursor. When the cursor comment is gone the server answers an empty page forever,
// so a task updated since the cursor falls back to its latest comments and keeps those newer than the cursor.
async function readFresh(bot, issue, entry) {
  const fresh = [];
  let cursor = entry.lastSeenCommentId;
  for (let page = 0; page < MAX_READ_PAGES; page += 1) {
    const batch = await bot.pc.listComments(issue.id, { order: 'asc', limit: READ_PAGE, ...(cursor ? { after: cursor } : {}) });
    fresh.push(...batch);
    if (batch.length < READ_PAGE) break;
    cursor = batch.at(-1).id;
  }
  const seenAt = Date.parse(entry.lastSeenAt);
  if (fresh.length > 0 || !entry.lastSeenCommentId || Number.isNaN(seenAt) || !(Date.parse(issue.updatedAt) > seenAt)) return fresh;
  const latest = await bot.pc.listComments(issue.id, { order: 'desc', limit: FALLBACK_READ });
  return latest.filter((comment) => Date.parse(comment.createdAt) > seenAt).reverse();
}

// Sends the new comments that are not the owner's, and moves the cursor.
async function followOne(bot, issue, entry, quoted) {
  const { state } = bot;
  entry.title = issue.title;
  entry.status = issue.status;

  const fresh = await readFresh(bot, issue, entry);
  const eligible = fresh.filter((comment) => !comment.deletedAt && !isBoardComment(comment));
  const mode = eligible.length > 0 ? gate(bot, 'followedComments') : 'off';
  const toSend = eligible.filter((comment) => !quoted.has(comment.id));

  if (mode === 'muted') {
    for (let i = 0; i < toSend.length; i += 1) state.countMuted('comments');
  } else if (mode === 'send' && toSend.length > MAX_SEPARATE_MESSAGES) {
    await sendFollowBurst(bot, issue, toSend.length);
  } else if (mode === 'send') {
    const sendable = new Set(toSend.map((comment) => comment.id));
    for (const comment of fresh) {
      if (sendable.has(comment.id)) await sendFollowComment(bot, issue, comment);
      moveCursor(entry, comment);
      state.save();
    }
  }
  if (fresh.length > 0) moveCursor(entry, fresh.at(-1));
  if (CLOSED.has(issue.status)) state.unfollow(issue.id);
  state.save();
}

// Followed tasks whose last read failed are read again even when they did not change.
async function retriedFollowed(bot, updatedIssues) {
  const { state } = bot;
  const inWindow = new Set(updatedIssues.map((issue) => issue.id));
  const issues = [];
  for (const [issueId, entry] of state.following) {
    if (!(entry.retry > 0) || inWindow.has(issueId)) continue;
    try {
      issues.push(await bot.pc.getIssue(issueId));
    } catch (err) {
      if (isUnauthorized(err)) throw err;
      if (err instanceof PaperclipError && err.status === 404) state.unfollow(issueId);
    }
  }
  return issues;
}

// Sends the new non-owner comments of followed tasks that changed; `quoted` holds comment ids already sent as quotes.
// One task failing does not stop the others; it is read again on the next poll, up to MAX_FOLLOW_TRIES times.
export async function pollFollowing(bot, updatedIssues, quoted) {
  const { state } = bot;
  for (const issue of [...updatedIssues, ...(await retriedFollowed(bot, updatedIssues))]) {
    const entry = state.following.get(issue.id);
    if (!entry) continue;
    try {
      await followOne(bot, issue, entry, quoted);
      entry.retry = 0;
    } catch (err) {
      // A rejected token or an unreachable Telegram fails the poll, so the window is read again.
      if (isUnauthorized(err) || isTelegramOutage(err)) throw err;
      if (err instanceof PaperclipError && err.status === 404) {
        state.unfollow(issue.id);
      } else {
        entry.retry = entry.retry + 1 >= MAX_FOLLOW_TRIES ? 0 : entry.retry + 1;
      }
      bot.log.warn(`could not follow the comments of ${issue.identifier}`, { error: err.message });
    }
    state.save();
  }
}
