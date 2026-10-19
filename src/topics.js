import { followIssue } from './follow.js';
import { truncate } from './format.js';
import { guarded, isUnauthorized } from './guard.js';
import { PaperclipError } from './paperclip.js';
import { loadTask, sendLoadedView } from './tasks.js';
import { TelegramError } from './telegram.js';
import { threadGone, topicUnchanged } from './thread.js';

// The six colours Telegram allows for a topic icon.
export const ICON_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];
const NAME_MAX = 128;
const MAX_ROOT_DEPTH = 10;
const WARN_INTERVAL_MS = 60 * 60 * 1000;
const CLOSED_STATUSES = new Set(['done', 'cancelled']);
const NO_TOPIC = { thread: null, own: false, rootId: null };

// A stable colour per project (FNV-1a hash); tasks without a project get the first one.
export function iconColor(projectId) {
  if (!projectId) return ICON_COLORS[0];
  let hash = 2166136261;
  for (const ch of String(projectId)) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619) >>> 0;
  return ICON_COLORS[hash % ICON_COLORS.length];
}

// "ID Title", cut so the name plus `suffix` stays within Telegram's limit.
export function topicName(identifier, title, suffix = '') {
  const flat = String(title ?? '').replace(/\s+/g, ' ').trim();
  return truncate(flat ? `${identifier} ${flat}` : identifier, NAME_MAX - suffix.length) + suffix;
}

function warnTopics(bot, message, detail) {
  if (bot.topicWarnedAt != null && bot.now() - bot.topicWarnedAt < WARN_INTERVAL_MS) return;
  bot.topicWarnedAt = bot.now();
  bot.log.warn(message, detail);
}

// Finds the top-level task of an issue by walking parentId (at most MAX_ROOT_DEPTH reads) and remembers the answer.
export async function rootOf(bot, issue) {
  const { state } = bot;
  const chain = [];
  let current = { id: issue.id, parentId: issue.parentId };
  let root = null;
  for (let depth = 0; depth < MAX_ROOT_DEPTH; depth += 1) {
    const cached = state.roots.get(current.id);
    if (cached) {
      root = cached;
      break;
    }
    if (current.parentId === undefined) current = await bot.pc.getIssue(current.id);
    chain.push(current.id);
    if (!current.parentId) {
      root = current.id;
      break;
    }
    current = { id: current.parentId, parentId: undefined };
  }
  root ??= chain.at(-1);
  for (const id of chain) state.noteRoot(id, root);
  return root;
}

export function dropTopic(bot, rootId) {
  if (bot.state.topics.delete(rootId)) bot.state.save();
}

async function quiet(call) {
  try {
    await call();
  } catch (err) {
    if (!topicUnchanged(err)) throw err;
  }
}

// Closes and renames the topic of a finished task, or reopens it when the task is open again.
export async function applyStatus(bot, rootId, status) {
  const topic = bot.state.topics.get(rootId);
  if (!topic) return;
  const want = CLOSED_STATUSES.has(status) ? status : null;
  if (want === topic.closed) return;
  const ids = { chat_id: bot.config.telegramChatId, message_thread_id: topic.thread };
  try {
    if (want) {
      await quiet(() => bot.tg.editForumTopic({ ...ids, name: topicName(topic.identifier, topic.title, ` (${want})`) }));
      await quiet(() => bot.tg.closeForumTopic(ids));
    } else {
      await quiet(() => bot.tg.reopenForumTopic(ids));
      await quiet(() => bot.tg.editForumTopic({ ...ids, name: topicName(topic.identifier, topic.title) }));
    }
  } catch (err) {
    if (!threadGone(err)) throw err;
    dropTopic(bot, rootId);
    return;
  }
  topic.closed = want;
  bot.state.save();
  if (!want && !bot.state.isFollowing(rootId)) await autoFollow(bot, { id: rootId, identifier: topic.identifier, title: topic.title, status });
}

// A task with a topic is followed, so its new agent comments show up there.
async function autoFollow(bot, issue) {
  if (bot.state.isFollowing(issue.id)) return;
  try {
    const dropped = await followIssue(bot, issue);
    if (dropped) bot.log.warn(`stopped following ${dropped} to make room`);
  } catch (err) {
    if (err instanceof PaperclipError && err.status === 401) throw err;
    bot.log.warn('could not follow a task with a topic', { error: err.message });
  }
}

// Posts the task view as the first message of a new topic and pins it.
async function fillTopic(bot, view, thread, kind) {
  const { issue } = view;
  await autoFollow(bot, issue);
  const { messageId } = await sendLoadedView(bot, view, { kind, thread });
  if (bot.topics.canPin) {
    try {
      await bot.tg.pinChatMessage({ chat_id: bot.config.telegramChatId, message_id: messageId, disable_notification: true });
    } catch {
      // A failed pin does not matter.
    }
  }
  await applyStatus(bot, issue.id, issue.status);
}

async function createTopic(bot, rootId, kind) {
  const view = await loadTask(bot, rootId);
  const { issue } = view;
  let created;
  try {
    created = await bot.tg.createForumTopic({
      chat_id: bot.config.telegramChatId,
      name: topicName(issue.identifier, issue.title),
      icon_color: iconColor(issue.projectId),
    });
  } catch (err) {
    if (!(err instanceof TelegramError) || err.aborted) throw err;
    warnTopics(bot, 'could not create a topic, using the main chat', { error: err.message });
    return null;
  }
  const thread = created.message_thread_id;
  bot.state.topics.set(rootId, { thread, identifier: issue.identifier, title: issue.title, closed: null });
  bot.state.noteRoot(rootId, rootId);
  bot.state.save();
  await guarded(bot, `the topic of ${issue.identifier}`, () => fillTopic(bot, view, thread, kind));
  return thread;
}

// Where a message about `issue` goes: its top-level task's topic (made on first use), or the main chat.
// A failure to find or make the topic (anything but a rejected token) sends this message to the main chat.
export async function topicTarget(bot, issue, { kind = 'Task' } = {}) {
  await bot.topicsReady();
  if (!bot.topics.on) return NO_TOPIC;
  let rootId;
  try {
    rootId = await rootOf(bot, issue);
  } catch (err) {
    if (isUnauthorized(err)) throw err;
    if (err instanceof PaperclipError && err.status === 404) return NO_TOPIC;
    warnTopics(bot, 'could not find the topic of a task, using the main chat', { error: err.message });
    return NO_TOPIC;
  }
  const topic = bot.state.topics.get(rootId);
  let thread = topic?.thread ?? null;
  if (!topic) {
    try {
      thread = await createTopic(bot, rootId, kind);
    } catch (err) {
      if (isUnauthorized(err) || err.aborted) throw err;
      warnTopics(bot, 'could not make the topic of a task, using the main chat', { error: err.message });
    }
  }
  return { thread, own: thread !== null && rootId === issue.id, rootId };
}

// Makes a topic the owner started the topic of a new task: renames it and posts the pinned view.
export async function linkTopic(bot, thread, issue) {
  const entry = { thread, identifier: issue.identifier, title: issue.title, closed: null };
  bot.state.topics.set(issue.id, entry);
  bot.state.noteRoot(issue.id, issue.id);
  bot.state.save();
  try {
    await quiet(() =>
      bot.tg.editForumTopic({ chat_id: bot.config.telegramChatId, message_thread_id: thread, name: topicName(issue.identifier, issue.title) }),
    );
  } catch (err) {
    if (threadGone(err)) {
      dropTopic(bot, issue.id);
      return false;
    }
    if (!(err instanceof TelegramError)) throw err;
    bot.log.warn('could not rename a topic', { error: err.message });
  }
  await guarded(bot, `the topic of ${issue.identifier}`, async () => fillTopic(bot, await loadTask(bot, issue.id), thread, 'Created'));
  return true;
}

// Brings every topic in line with its task's status; titles of changed tasks are refreshed first.
export async function syncTopics(bot, updated = []) {
  await bot.topicsReady();
  if (!bot.topics.on) return;
  const { state } = bot;
  for (const issue of updated) {
    const topic = state.topics.get(issue.id);
    if (topic) topic.title = issue.title;
  }
  for (const [rootId, topic] of [...state.topics]) {
    const status = state.statuses.get(rootId);
    if (status === undefined || (CLOSED_STATUSES.has(status) ? status : null) === topic.closed) continue;
    await guarded(bot, `the topic of ${topic.identifier}`, () => applyStatus(bot, rootId, status));
  }
}
