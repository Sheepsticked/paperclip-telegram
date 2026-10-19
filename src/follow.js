import { authorName, isBoardComment } from './comments.js';
import { escapeHtml, issueUrl, link, taskButton, truncate, truncateLines } from './format.js';
import { gate } from './settings.js';
import { PaperclipError } from './paperclip.js';

const READ_PAGE = 50;
const MAX_READ_PAGES = 5;
const MAX_SEPARATE_MESSAGES = 5;
const CLOSED = new Set(['done', 'cancelled']);

// Starts following a task from its newest comment on, so nothing old is replayed.
export async function followIssue(bot, issue) {
  const newest = await bot.pc.listComments(issue.id, { limit: 1, order: 'desc' });
  const dropped = bot.state.follow(issue.id, {
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    lastSeenCommentId: newest[0]?.id ?? null,
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
  const lines = [`💬 <b>${escapeHtml(truncate(author, 80))}</b> · <b>${escapeHtml(issue.identifier)}</b> ${escapeHtml(truncate(issue.title, 100))}`];
  const excerpt = truncateLines(comment.body, 5, 400);
  if (excerpt) lines.push(`<blockquote>${escapeHtml(excerpt)}</blockquote>`);
  lines.push(link(issueUrl(bot.config.uiBaseUrl, issue.identifier), 'Open in Paperclip'));
  await bot.send(lines.join('\n'), { keyboard: [[taskButton(issue.id)]], issue: { id: issue.id, identifier: issue.identifier } });
}

async function sendFollowBurst(bot, issue, count) {
  const head = `💬 <b>${count} new comments</b> · <b>${escapeHtml(issue.identifier)}</b> ${escapeHtml(truncate(issue.title, 100))}`;
  const open = link(issueUrl(bot.config.uiBaseUrl, issue.identifier), 'Open in Paperclip');
  await bot.send(`${head}\n${open}`, { keyboard: [[taskButton(issue.id)]], issue: { id: issue.id, identifier: issue.identifier } });
}

// Reads the comments after the saved cursor, sends the ones that are not the owner's, and moves the cursor.
async function followOne(bot, issue, entry, quoted) {
  const { state } = bot;
  entry.title = issue.title;
  entry.status = issue.status;

  const fresh = [];
  let cursor = entry.lastSeenCommentId;
  for (let page = 0; page < MAX_READ_PAGES; page += 1) {
    const batch = await bot.pc.listComments(issue.id, { order: 'asc', limit: READ_PAGE, ...(cursor ? { after: cursor } : {}) });
    fresh.push(...batch);
    if (batch.length < READ_PAGE) break;
    cursor = batch.at(-1).id;
  }

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
      entry.lastSeenCommentId = comment.id;
      state.save();
    }
  }
  if (fresh.length > 0) entry.lastSeenCommentId = fresh.at(-1).id;
  if (CLOSED.has(issue.status)) state.unfollow(issue.id);
  state.save();
}

// Sends the new non-owner comments of followed tasks that changed; `quoted` holds comment ids already sent as quotes.
export async function pollFollowing(bot, updatedIssues, quoted) {
  const { state } = bot;
  for (const issue of updatedIssues) {
    const entry = state.following.get(issue.id);
    if (!entry) continue;
    try {
      await followOne(bot, issue, entry, quoted);
    } catch (err) {
      // A task-level failure is skipped; token and Telegram failures fail the poll so the window is read again.
      if (!(err instanceof PaperclipError) || err.status === 401) throw err;
      if (err.status === 404) state.unfollow(issue.id);
      bot.log.warn(`could not read the comments of ${issue.identifier}`, { error: err.message });
    }
  }
}
