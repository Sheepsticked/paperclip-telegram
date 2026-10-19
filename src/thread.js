import { TelegramError } from './telegram.js';

// Fields that only service messages (not something the owner wrote) carry.
const SERVICE_FIELDS = [
  'forum_topic_created',
  'forum_topic_edited',
  'forum_topic_closed',
  'forum_topic_reopened',
  'general_forum_topic_hidden',
  'general_forum_topic_unhidden',
  'pinned_message',
  'new_chat_members',
  'left_chat_member',
  'new_chat_title',
  'new_chat_photo',
  'delete_chat_photo',
  'group_chat_created',
  'supergroup_chat_created',
  'channel_chat_created',
  'message_auto_delete_timer_changed',
  'migrate_to_chat_id',
  'migrate_from_chat_id',
  'video_chat_scheduled',
  'video_chat_started',
  'video_chat_ended',
  'video_chat_participants_invited',
  'boost_added',
  'chat_background_set',
  'write_access_allowed',
];

// The reaction that confirms a comment was posted.
export const COMMENT_REACTION = '\u{1F44D}';

export function isServiceMessage(msg) {
  return SERVICE_FIELDS.some((field) => msg[field] !== undefined);
}

// The topic a message was written in, or null for the General topic (and whenever topics are off).
export function threadOf(bot, msg) {
  if (!bot.topics.on || !msg) return null;
  return msg.is_topic_message === true && Number.isInteger(msg.message_thread_id) ? msg.message_thread_id : null;
}

// True when `thread` is the topic of that very task.
export function ownTopic(bot, issueId, thread) {
  return thread !== null && thread !== undefined && bot.state.topics.get(issueId)?.thread === thread;
}

// Where a reply to `msg` goes: quoting it, in the same topic.
export function where(bot, msg) {
  return { replyTo: msg.message_id, thread: threadOf(bot, msg) };
}

// The message the owner replied to; null when the "reply" is only the topic's first message.
export function replyTarget(msg) {
  const target = msg.reply_to_message;
  if (!target) return null;
  if (target.forum_topic_created) return null;
  if (msg.is_topic_message === true && target.message_id === msg.message_thread_id) return null;
  return target.message_id;
}

// True when Telegram says the topic does not exist (any more).
export function threadGone(err) {
  return err instanceof TelegramError && /message thread not found|TOPIC_ID_INVALID/i.test(err.description ?? '');
}

export function topicUnchanged(err) {
  return err instanceof TelegramError && /TOPIC_NOT_MODIFIED/i.test(err.description ?? '');
}
