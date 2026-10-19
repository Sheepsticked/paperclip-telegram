import { followIssue } from './follow.js';
import { truncate } from './format.js';
import { guarded, isRefused, isTelegramOutage, isUnauthorized, warnHourly } from './guard.js';
import { PaperclipError } from './paperclip.js';
import { loadTask, sendLoadedView } from './tasks.js';
import { TelegramError } from './telegram.js';
import { threadGone, topicUnchanged } from './thread.js';

// The six colours Telegram allows for a topic's bubble.
export const ICON_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];
const NAME_MAX = 128;
const MAX_ROOT_DEPTH = 10;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// The General topic is never deleted.
const GENERAL_THREAD = 1;
export const DELETE_RIGHT_WARNING = 'the bot lacks the Delete messages right, so finished topics are kept';
const CLOSED_STATUSES = new Set(['done', 'cancelled']);
const NO_TOPIC = { thread: null, own: false, rootId: null };

// A stable colour per project (FNV-1a hash); tasks without a project get the first one.
export function iconColor(projectId) {
  if (!projectId) return ICON_COLORS[0];
  let hash = 2166136261;
  for (const ch of String(projectId)) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619) >>> 0;
  return ICON_COLORS[hash % ICON_COLORS.length];
}

// "ID Title", cut to Telegram's limit.
export function topicName(identifier, title) {
  const flat = String(title ?? '').replace(/\s+/g, ' ').trim();
  return truncate(flat ? `${identifier} ${flat}` : identifier, NAME_MAX);
}

const warnTopics = (bot, message, detail) => warnHourly(bot, 'topics', message, detail);

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

// Closes the topic of a finished task, or reopens it when the task is open again.
// A name that still carries an old status suffix is restored on reopening.
export async function applyStatus(bot, rootId, status) {
  const topic = bot.state.topics.get(rootId);
  if (!topic) return;
  const want = CLOSED_STATUSES.has(status) ? status : null;
  if (want === topic.closed) return;
  const ids = { chat_id: bot.config.telegramChatId, message_thread_id: topic.thread };
  try {
    if (want) {
      await quiet(() => bot.tg.closeForumTopic(ids));
    } else {
      await quiet(() => bot.tg.reopenForumTopic(ids));
      if (topic.suffixed) await quiet(() => bot.tg.editForumTopic({ ...ids, name: topicName(topic.identifier, topic.title) }));
      topic.suffixed = false;
    }
  } catch (err) {
    if (!threadGone(err)) throw err;
    dropTopic(bot, rootId);
    return;
  }
  topic.closed = want;
  topic.closedAt = want ? (topic.closedAt ?? bot.now()) : null;
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
async function fillTopic(bot, view, thread) {
  const { issue } = view;
  await autoFollow(bot, issue);
  const { messageId } = await sendLoadedView(bot, view, { thread });
  if (bot.topics.canPin) {
    try {
      await bot.tg.pinChatMessage({ chat_id: bot.config.telegramChatId, message_id: messageId, disable_notification: true });
    } catch {
      // A failed pin does not matter.
    }
  }
  await applyStatus(bot, issue.id, issue.status);
}

async function createTopic(bot, rootId) {
  const view = await loadTask(bot, rootId);
  const { issue } = view;
  let created;
  try {
    created = await bot.tg.createForumTopic({
      chat_id: bot.config.telegramChatId,
      name: topicName(issue.identifier, issue.title),
      icon_color: iconColor(issue.projectId ?? null),
    });
  } catch (err) {
    if (!(err instanceof TelegramError) || err.aborted) throw err;
    warnTopics(bot, 'could not create a topic, using the main chat', { error: err.message });
    return null;
  }
  const thread = created.message_thread_id;
  bot.state.topics.set(rootId, { thread, identifier: issue.identifier, title: issue.title, closed: null, suffixed: false, closedAt: null });
  bot.state.noteRoot(rootId, rootId);
  bot.state.save();
  await guarded(bot, `the topic of ${issue.identifier}`, () => fillTopic(bot, view, thread));
  return thread;
}

// Where a message about `issue` goes: its top-level task's topic (made on first use), or the main chat.
// A failure to find or make the topic (anything but a rejected token) sends this message to the main chat.
export async function topicTarget(bot, issue) {
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
      thread = await createTopic(bot, rootId);
    } catch (err) {
      if (isUnauthorized(err) || err.aborted) throw err;
      warnTopics(bot, 'could not make the topic of a task, using the main chat', { error: err.message });
    }
  }
  return { thread, own: thread !== null && rootId === issue.id, rootId };
}

// Makes a topic the owner started the topic of a new task: renames it and posts the pinned view.
export async function linkTopic(bot, thread, issue) {
  bot.state.topics.set(issue.id, { thread, identifier: issue.identifier, title: issue.title, closed: null, suffixed: false, closedAt: null });
  bot.state.noteRoot(issue.id, issue.id);
  bot.state.save();
  try {
    await quiet(() => bot.tg.editForumTopic({ chat_id: bot.config.telegramChatId, message_thread_id: thread, name: topicName(issue.identifier, issue.title) }));
  } catch (err) {
    if (threadGone(err)) {
      dropTopic(bot, issue.id);
      return false;
    }
    if (!(err instanceof TelegramError)) throw err;
    bot.log.warn('could not rename a topic', { error: err.message });
  }
  await guarded(bot, `the topic of ${issue.identifier}`, async () => fillTopic(bot, await loadTask(bot, issue.id), thread));
  return true;
}

// Takes the icon off each open topic whose saved entry still has one (an older version gave topics icons). Each topic is
// edited once: a refused edit is logged and given up on, a lost connection leaves the entry for the next poll.
// A closed topic is left as it is.
export async function removeTopicIcons(bot) {
  for (const [rootId, topic] of [...bot.state.topics]) {
    if (topic.iconId === undefined) continue;
    await guarded(bot, `the icon of ${topic.identifier}`, async () => {
      if (!topic.closed) {
        try {
          await quiet(() => bot.tg.editForumTopic({ chat_id: bot.config.telegramChatId, message_thread_id: topic.thread, icon_custom_emoji_id: '' }));
        } catch (err) {
          if (threadGone(err)) {
            dropTopic(bot, rootId);
            return;
          }
          if (!isRefused(err)) throw err;
          bot.log.warn('could not remove the icon of a topic', { error: err.message });
        }
      }
      delete topic.iconId;
      bot.state.save();
    });
  }
}

// The Telegram text for a refused delete is not documented, so any refusal that talks about rights counts.
const lacksDeleteRight = (err) => err instanceof TelegramError && (err.code === 403 || (isRefused(err) && /rights|administrator|CHAT_ADMIN_REQUIRED/i.test(err.description ?? '')));

// Deletes one topic: 'deleted' when it is gone (also when it was gone before), 'stop' when the rest of the sweep would
// fail the same way, 'keep' for any other error.
async function deleteTopic(bot, topic) {
  try {
    await bot.tg.deleteForumTopic({ chat_id: bot.config.telegramChatId, message_thread_id: topic.thread });
    return 'deleted';
  } catch (err) {
    if (threadGone(err)) return 'deleted';
    if (lacksDeleteRight(err)) {
      warnHourly(bot, 'delete-right', DELETE_RIGHT_WARNING);
      return 'stop';
    }
    warnHourly(bot, 'topic-delete', 'could not delete a finished topic; trying again at the next sweep', { error: err.message });
    return isTelegramOutage(err) ? 'stop' : 'keep';
  }
}

// Once an hour, deletes the topics that have been closed for longer than `closedTopicDays` and forgets them.
// A topic that could not be deleted is kept and tried again at the next sweep.
export async function sweepClosedTopics(bot) {
  const days = bot.config.closedTopicDays;
  if (!(days > 0) || (bot.sweptAt !== null && bot.now() - bot.sweptAt < SWEEP_INTERVAL_MS)) return;
  bot.sweptAt = bot.now();
  for (const [rootId, topic] of [...bot.state.topics]) {
    const due = topic.closed && topic.thread > GENERAL_THREAD && Number.isFinite(topic.closedAt) && bot.now() - topic.closedAt > days * DAY_MS;
    if (!due) continue;
    const result = await deleteTopic(bot, topic);
    if (result === 'stop') return;
    if (result === 'deleted') {
      bot.state.forgetTopic(rootId);
      bot.state.save();
    }
  }
}

// Brings every topic in line with its task: the status (closed or open) and the age of the closed ones. Titles of
// changed tasks are refreshed first.
export async function syncTopics(bot, updated = []) {
  await bot.topicsReady();
  if (!bot.topics.on) return;
  const { state } = bot;
  for (const issue of updated) {
    const topic = state.topics.get(issue.id);
    if (!topic) continue;
    topic.title = issue.title;
  }
  for (const [rootId, topic] of [...state.topics]) {
    const status = state.statuses.get(rootId);
    if (status === undefined || (CLOSED_STATUSES.has(status) ? status : null) === topic.closed) continue;
    await guarded(bot, `the topic of ${topic.identifier}`, () => applyStatus(bot, rootId, status));
  }
  await removeTopicIcons(bot);
  await guarded(bot, 'the sweep of finished topics', () => sweepClosedTopics(bot));
}
