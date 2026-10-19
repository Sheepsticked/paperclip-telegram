import { createHash } from 'node:crypto';
import { escapeHtml, fitMessage, flat, issueUrl, link, truncate } from './format.js';
import { isUnauthorized, warnHourly } from './guard.js';
import { itemSummary } from './inbox.js';
import { groupWork } from './lists.js';
import { TelegramError } from './telegram.js';

const SECTION_LINES = [10, 6, 3, 1, 0];
const ISSUE_LIMIT = 200;
// The text of a line is cut to what fits one line on a phone.
const LINE_MAX = 40;
const EMPTY = 'Nothing waiting or running.';

// The topic link of a task's top-level task when that topic is known, else null.
function topicUrl(bot, issueId, parentId) {
  const { state, config } = bot;
  const chat = String(config.telegramChatId);
  const topic = state.topics.get(state.knownRoot(issueId, parentId));
  return topic && chat.startsWith('-100') ? `https://t.me/c/${chat.slice(4)}/${topic.thread}` : null;
}

// One line, the whole of it a link: to the task's topic, else to the task or item in Paperclip.
function boardLine(bot, { issueId, parentId, identifier, title, kind, href }, suffix = '') {
  const flatTitle = flat(title);
  const label = truncate(identifier ? `${identifier} ${flatTitle}` : [kind, flatTitle].filter(Boolean).join(' '), LINE_MAX);
  const { uiBaseUrl } = bot.config;
  const own = identifier ? issueUrl(uiBaseUrl, identifier) : href?.startsWith('/') ? `${uiBaseUrl}${href}` : null;
  const url = (issueId ? topicUrl(bot, issueId, parentId) : null) ?? own;
  return `${url ? link(url, label) : escapeHtml(label)}${suffix}`;
}

// What the poll knows about a task, to name the one an item only points at (an approval has just the id).
function knownTasks(bot, rows) {
  const known = new Map();
  for (const [rootId, topic] of bot.state.topics) known.set(rootId, { identifier: topic.identifier, title: topic.title });
  for (const record of bot.state.inbox.values()) if (record.issue?.identifier) known.set(record.issue.id, record.issue);
  for (const issue of rows) known.set(issue.id, issue);
  return known;
}

// The tasks and items of the three sections, as lines. Two items about one task make one line.
async function sectionLines(bot, items, running, review) {
  const group = groupWork({ items, running, review });
  const known = knownTasks(bot, [...group.running, ...group.review]);
  const seen = new Set();
  const needs = [];
  const add = (summary) => {
    if (summary.issueId && seen.has(summary.issueId)) return;
    if (summary.issueId) seen.add(summary.issueId);
    needs.push(boardLine(bot, summary));
  };
  for (const item of group.cards) {
    const { id, identifier, title } = item.relatedIssue;
    add({ issueId: id, identifier, title });
  }
  for (const item of group.inbox) {
    const summary = itemSummary(item);
    const task = summary.identifier ? null : known.get(summary.issueId);
    add(task ? { ...summary, identifier: task.identifier, title: task.title } : summary);
  }
  const taskLine = (issue, suffix) => boardLine(bot, { issueId: issue.id, parentId: issue.parentId, identifier: issue.identifier, title: issue.title }, suffix);
  const working = [];
  for (const issue of group.running) {
    const agent = (await bot.agentName(issue.assigneeAgentId)) ?? 'unassigned';
    working.push(taskLine(issue, ` — ${escapeHtml(truncate(agent, 60))}`));
  }
  return [
    ['Needs you', needs],
    ['Working', working],
    ['In review', group.review.map((issue) => taskLine(issue))],
  ];
}

// `perSection` lines at most are shown in each section, then "+N more".
function compose(sections, perSection) {
  const parts = sections
    .filter(([, lines]) => lines.length > 0)
    .map(([name, lines]) => {
      const more = lines.length - Math.min(lines.length, perSection);
      return [`<b>${name}</b> (${lines.length})`, ...lines.slice(0, perSection), ...(more > 0 ? [`+${more} more`] : [])].join('\n');
    });
  return parts.length > 0 ? parts.join('\n\n') : EMPTY;
}

export async function boardText(bot, items) {
  const { config } = bot;
  const [running, review] = await Promise.all([
    bot.pc.listIssues(config.companyId, { status: 'in_progress', sortField: 'updated', sortDir: 'desc', limit: ISSUE_LIMIT }),
    bot.pc.listIssues(config.companyId, { status: 'in_review', sortField: 'updated', sortDir: 'desc', limit: ISSUE_LIMIT }),
  ]);
  const sections = await sectionLines(bot, items, running, review);
  return fitMessage((perSection) => compose(sections, perSection), SECTION_LINES);
}

const digest = (text) => createHash('sha256').update(text).digest('hex');
const isNotModified = (err) => err instanceof TelegramError && err.code === 400 && /not modified/i.test(err.description);
const isGone = (err) => err instanceof TelegramError && err.code === 400 && /message to edit not found|MESSAGE_ID_INVALID/i.test(err.description);

// Sends the board and pins it (silently) when the bot may pin.
async function sendBoard(bot, text) {
  const { state } = bot;
  state.boardMessageId = await bot.send(text);
  state.boardHash = digest(text);
  state.save();
  if (!bot.topics.canPin) return;
  try {
    await bot.tg.pinChatMessage({ chat_id: bot.config.telegramChatId, message_id: state.boardMessageId, disable_notification: true });
  } catch (err) {
    warnHourly(bot, 'board', 'could not pin the board', { error: err.message });
  }
}

// Edits the board when its text changed; sends a new one when there is none yet or the owner deleted it.
async function publish(bot, text) {
  const { state } = bot;
  if (state.boardMessageId !== null && state.boardHash === digest(text)) return;
  if (state.boardMessageId !== null) {
    try {
      await bot.tg.editMessageText({
        chat_id: bot.config.telegramChatId,
        message_id: state.boardMessageId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      state.boardHash = digest(text);
      state.save();
      return;
    } catch (err) {
      if (isNotModified(err)) {
        state.boardHash = digest(text);
        state.save();
        return;
      }
      if (!isGone(err)) throw err;
    }
  }
  await sendBoard(bot, text);
}

// The pinned board in the main chat: what needs the owner, what is running and what waits for review. Only with topics on.
// A failure is logged (once an hour) and never stops the poll, except a rejected Paperclip token.
export async function updateBoard(bot, items) {
  try {
    await bot.topicsReady();
    if (!bot.topics.on) return;
    await publish(bot, await boardText(bot, items));
  } catch (err) {
    if (isUnauthorized(err)) throw err;
    warnHourly(bot, 'board', 'could not update the board', { error: err.message });
  }
}
