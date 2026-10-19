import http from 'node:http';
import { findEmoji } from '../style.js';

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'blockquote', 'tg-spoiler']);
const ENTITY = /^&(amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/;
const ICON_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];
const REACTIONS = ['\u{1F44D}', '\u{1F44E}', '\u2764', '\u{1F525}', '\u{1F389}'];
const FULL_RIGHTS = { can_manage_topics: true, can_pin_messages: true };
const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const BUTTON_STYLES = ['danger', 'success', 'primary'];

// Mirrors Telegram's HTML parse mode: known tags only, balanced, with every & < > escaped.
// Stricter than Telegram on one point: the only attribute a blockquote may carry is "expandable".
export function validateTelegramHtml(text) {
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '&') {
      if (!ENTITY.test(text.slice(i))) return `Unsupported entity at byte offset ${i}`;
    } else if (ch === '>') {
      return `Unescaped ">" at byte offset ${i}`;
    } else if (ch === '<') {
      const match = /^<(\/?)([A-Za-z][\w-]*)((?:\s+[^<>]*)?)>/.exec(text.slice(i));
      if (!match) return `Unsupported start tag at byte offset ${i}`;
      const [whole, closing, name, attrs] = match;
      if (!ALLOWED_TAGS.has(name)) return `Unsupported start tag "${name}" at byte offset ${i}`;
      if (closing) {
        if (stack.pop() !== name) return `Unmatched end tag at byte offset ${i}`;
      } else {
        if (name === 'a' && !/\shref="[^"]*"/.test(attrs)) return 'Link without href';
        if (name === 'blockquote' && attrs.trim() !== '' && attrs.trim() !== 'expandable') return `Unsupported attribute "${attrs.trim()}" in the tag "blockquote" at byte offset ${i}`;
        stack.push(name);
      }
      i += whole.length - 1;
    }
  }
  return stack.length ? `Can't find end tag for "${stack.at(-1)}"` : null;
}

// A stand-in for the Telegram Bot API that records every call and checks what the real API checks.
// With `forum: true` the chat is a supergroup with topics and the bot an admin holding `botRights`.
export async function startFakeTelegram({
  token = 'fake-telegram-token',
  userId = 1001,
  chatId = 1001,
  holdMs = 80,
  forum = false,
  botRights = FULL_RIGHTS,
  botId = 4242,
  firstMessageId = 100,
} = {}) {
  const chat = { type: forum ? 'supergroup' : 'private', isForum: forum, botRights: forum ? botRights : null };
  const calls = [];
  const topics = new Map();
  const userMessages = new Map();
  const reactions = [];
  const written = [];
  const messages = new Map();
  const callbackAnswers = [];
  const updates = [];
  const waiters = new Set();
  const failures = new Map();
  const files = new Map();
  const downloads = [];
  const downloadFailure = { status: null, drop: false };
  let nextFileNumber = 1;
  let nextMessageId = firstMessageId;
  let nextUpdateId = 1;
  let commands = null;
  let shortDescription = null;
  let description = null;

  function respond(res, status, body) {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  const error = (res, code, description, parameters) =>
    respond(res, code, { ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) });

  function flush() {
    for (const waiter of [...waiters]) {
      const ready = updates.filter((u) => u.update_id >= waiter.offset);
      if (ready.length > 0) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        respond(waiter.res, 200, { ok: true, result: ready.slice(0, 100) });
      }
    }
  }

  const note = (kind, text) => {
    if (typeof text === 'string' && text.length > 0) written.push({ kind, text });
  };

  // Telegram refuses callback data of 0 or more than 64 bytes, more than 100 buttons and a style other than the three colours.
  function checkMarkup(res, markup) {
    const buttons = (markup?.inline_keyboard ?? []).flat();
    for (const b of buttons) note('button', b.text);
    note('placeholder', markup?.input_field_placeholder);
    if (buttons.length > 100) return error(res, 400, 'Bad Request: reply markup is too long'), false;
    for (const b of buttons) {
      if (b.style !== undefined && !BUTTON_STYLES.includes(b.style)) return error(res, 400, "Bad Request: Can't parse InlineKeyboardButton: Invalid button style specified"), false;
      const size = Buffer.byteLength(b.callback_data ?? '');
      if (b.callback_data !== undefined && (size === 0 || size > 64)) return error(res, 400, 'Bad Request: BUTTON_DATA_INVALID'), false;
      if (typeof b.text !== 'string' || b.text.length === 0) return error(res, 400, 'Bad Request: text buttons are unallowed in the inline keyboard'), false;
    }
    return true;
  }

  const isAdmin = () => chat.botRights !== null;
  const mayManage = () => isAdmin() && chat.botRights.can_manage_topics === true;

  // The topic a send or an edit refers to; false after answering with an error.
  function checkThread(res, threadId) {
    if (threadId === undefined || threadId === null) return true;
    const topic = topics.get(threadId);
    if (!topic || topic.deleted) return error(res, 400, 'Bad Request: message thread not found'), false;
    if (topic.closed && !mayManage()) return error(res, 400, 'Bad Request: TOPIC_CLOSED'), false;
    return true;
  }

  function checkMessage(res, params) {
    if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found'), false;
    note('text', params.text);
    if (typeof params.text !== 'string' || params.text.length === 0) return error(res, 400, 'Bad Request: message text is empty'), false;
    if (params.text.length > 4096) return error(res, 400, 'Bad Request: message is too long'), false;
    if (params.parse_mode === 'HTML') {
      const problem = validateTelegramHtml(params.text);
      if (problem) return error(res, 400, `Bad Request: can't parse entities: ${problem}`), false;
    }
    return checkMarkup(res, params.reply_markup);
  }

  const handlers = {
    getUpdates(res, params) {
      const offset = params.offset ?? 0;
      for (let i = updates.length - 1; i >= 0; i -= 1) if (updates[i].update_id < offset) updates.splice(i, 1);
      const ready = updates.filter((u) => u.update_id >= offset);
      if (ready.length > 0) return respond(res, 200, { ok: true, result: ready.slice(0, 100) });
      const waiter = { res, offset, timer: setTimeout(() => {
        waiters.delete(waiter);
        respond(res, 200, { ok: true, result: [] });
      }, holdMs) };
      waiters.add(waiter);
      // The response closes when it was sent or when the client hung up.
      res.on('close', () => {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
      });
      return undefined;
    },
    sendMessage(res, params) {
      if (!checkMessage(res, params)) return;
      if (!checkThread(res, params.message_thread_id)) return;
      const thread = params.message_thread_id ?? null;
      const message = {
        message_id: nextMessageId++,
        chat: { id: chatId, type: chat.type },
        date: 0,
        text: params.text,
        markup: params.reply_markup ?? null,
        replyTo: params.reply_parameters?.message_id ?? null,
        thread,
        pinned: null,
        edits: 0,
      };
      messages.set(message.message_id, message);
      respond(res, 200, { ok: true, result: { message_id: message.message_id, chat: message.chat, date: 0, text: message.text, ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}) } });
    },
    editMessageText(res, params) {
      if (!checkMessage(res, params)) return;
      const message = messages.get(params.message_id);
      if (!message) return error(res, 400, 'Bad Request: message to edit not found');
      const markup = params.reply_markup ?? null;
      if (message.text === params.text && JSON.stringify(message.markup) === JSON.stringify(markup)) {
        return error(res, 400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same');
      }
      message.text = params.text;
      message.markup = markup;
      message.edits += 1;
      respond(res, 200, { ok: true, result: { message_id: message.message_id, chat: message.chat, date: 0, text: message.text } });
    },
    editMessageReplyMarkup(res, params) {
      if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found');
      const message = messages.get(params.message_id);
      if (!message) return error(res, 400, 'Bad Request: message to edit not found');
      if (!checkMarkup(res, params.reply_markup)) return undefined;
      const markup = params.reply_markup ?? null;
      if (JSON.stringify(message.markup) === JSON.stringify(markup)) {
        return error(res, 400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same');
      }
      message.markup = markup;
      message.edits += 1;
      return respond(res, 200, { ok: true, result: { message_id: message.message_id, chat: message.chat, date: 0, text: message.text } });
    },
    answerCallbackQuery(res, params) {
      note('answer', params.text);
      callbackAnswers.push({ id: params.callback_query_id, text: params.text ?? '', alert: params.show_alert === true });
      respond(res, 200, { ok: true, result: true });
    },
    setMyCommands(res, params) {
      const list = params.commands;
      const valid = Array.isArray(list) && list.length <= 100 && list.every((c) => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description?.length >= 1 && c.description.length <= 256);
      if (!valid) return error(res, 400, 'Bad Request: invalid commands');
      for (const c of list) note('command', c.description);
      commands = list;
      return respond(res, 200, { ok: true, result: true });
    },
    setMyShortDescription(res, params) {
      if ((params.short_description ?? '').length > 120) return error(res, 400, 'Bad Request: short description is too long');
      note('short description', params.short_description);
      shortDescription = params.short_description ?? '';
      return respond(res, 200, { ok: true, result: true });
    },
    setMyDescription(res, params) {
      if ((params.description ?? '').length > 512) return error(res, 400, 'Bad Request: description is too long');
      note('description', params.description);
      description = params.description ?? '';
      return respond(res, 200, { ok: true, result: true });
    },
    // A file the owner sent: unknown ids and files over the bot limit are refused like the real API does.
    getFile(res, params) {
      const file = files.get(params.file_id);
      if (!file) return error(res, 400, 'Bad Request: invalid file_id');
      if (file.size > BOT_DOWNLOAD_LIMIT) return error(res, 400, 'Bad Request: file is too big');
      return respond(res, 200, { ok: true, result: { file_id: file.id, file_unique_id: `unique-${file.id}`, file_size: file.size, file_path: file.path } });
    },
    getMe(res) {
      respond(res, 200, { ok: true, result: { id: botId, is_bot: true, first_name: 'Fake bot', username: 'fake_bot' } });
    },
    getChat(res, params) {
      if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found');
      const result = { id: chatId, type: chat.type, ...(chat.isForum ? { is_forum: true } : {}) };
      return respond(res, 200, { ok: true, result });
    },
    getChatMember(res, params) {
      if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found');
      if (params.user_id === userId) return respond(res, 200, { ok: true, result: { status: 'creator', user: { id: userId, is_bot: false } } });
      if (params.user_id !== botId) return error(res, 400, 'Bad Request: user not found');
      const user = { id: botId, is_bot: true };
      const result = isAdmin()
        ? { status: 'administrator', user, can_be_edited: false, ...chat.botRights }
        : { status: 'member', user };
      return respond(res, 200, { ok: true, result });
    },
    createForumTopic(res, params) {
      if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found');
      note('topic name', params.name);
      if (!chat.isForum) return error(res, 400, 'Bad Request: the chat is not a forum');
      if (!mayManage()) return error(res, 400, 'Bad Request: not enough rights to create a topic');
      if (typeof params.name !== 'string' || params.name.length < 1 || params.name.length > 128) return error(res, 400, 'Bad Request: invalid topic name length');
      if (params.icon_color !== undefined && !ICON_COLORS.includes(params.icon_color)) return error(res, 400, 'Bad Request: invalid topic icon color');
      const id = nextMessageId++;
      topics.set(id, { id, name: params.name, icon_color: params.icon_color ?? ICON_COLORS[0], closed: false, deleted: false, by: 'bot' });
      return respond(res, 200, { ok: true, result: { message_thread_id: id, name: params.name, icon_color: params.icon_color ?? ICON_COLORS[0] } });
    },
    editForumTopic(res, params) {
      if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found');
      note('topic name', params.name);
      const topic = topics.get(params.message_thread_id);
      if (!topic || topic.deleted) return error(res, 400, 'Bad Request: TOPIC_ID_INVALID');
      if (!mayManage() && topic.by !== 'bot') return error(res, 400, 'Bad Request: not enough rights to manage topics');
      if (params.name !== undefined && (params.name.length < 1 || params.name.length > 128)) return error(res, 400, 'Bad Request: invalid topic name length');
      if (params.name === undefined || params.name === topic.name) return error(res, 400, 'Bad Request: TOPIC_NOT_MODIFIED');
      topic.name = params.name;
      return respond(res, 200, { ok: true, result: true });
    },
    closeForumTopic(res, params) {
      if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found');
      const topic = topics.get(params.message_thread_id);
      if (!topic || topic.deleted) return error(res, 400, 'Bad Request: TOPIC_ID_INVALID');
      if (!mayManage() && topic.by !== 'bot') return error(res, 400, 'Bad Request: not enough rights to manage topics');
      if (topic.closed) return error(res, 400, 'Bad Request: TOPIC_NOT_MODIFIED');
      topic.closed = true;
      return respond(res, 200, { ok: true, result: true });
    },
    reopenForumTopic(res, params) {
      if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found');
      const topic = topics.get(params.message_thread_id);
      if (!topic || topic.deleted) return error(res, 400, 'Bad Request: TOPIC_ID_INVALID');
      if (!mayManage() && topic.by !== 'bot') return error(res, 400, 'Bad Request: not enough rights to manage topics');
      if (!topic.closed) return error(res, 400, 'Bad Request: TOPIC_NOT_MODIFIED');
      topic.closed = false;
      return respond(res, 200, { ok: true, result: true });
    },
    pinChatMessage(res, params) {
      if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found');
      if (!isAdmin() || chat.botRights.can_pin_messages !== true) return error(res, 400, 'Bad Request: not enough rights to pin a message');
      const message = messages.get(params.message_id);
      if (!message) return error(res, 400, 'Bad Request: message to pin not found');
      message.pinned = { silent: params.disable_notification === true };
      return respond(res, 200, { ok: true, result: true });
    },
    setMessageReaction(res, params) {
      if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found');
      if (!userMessages.has(params.message_id) && !messages.has(params.message_id)) return error(res, 400, 'Bad Request: message to react not found');
      const list = params.reaction ?? [];
      if (list.some((r) => r.type !== 'emoji' || !REACTIONS.includes(r.emoji))) return error(res, 400, 'Bad Request: REACTION_INVALID');
      reactions.push({ messageId: params.message_id, emoji: list.map((r) => r.emoji) });
      return respond(res, 200, { ok: true, result: true });
    },
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const download = /^\/file\/bot([^/]+)\/(.+)$/.exec(req.url);
      if (download) {
        downloads.push({ path: download[2], tokenOk: download[1] === token });
        if (download[1] !== token) return error(res, 401, 'Unauthorized');
        if (downloadFailure.drop) return req.socket.destroy();
        if (downloadFailure.status) return respond(res, downloadFailure.status, { ok: false, error_code: downloadFailure.status, description: 'Injected download failure' });
        const file = [...files.values()].find((entry) => entry.path === download[2]);
        if (!file) return error(res, 404, 'Not Found');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.data.length });
        return res.end(file.data);
      }
      const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url);
      if (!match || match[1] !== token) return error(res, 401, 'Unauthorized');
      const method = match[2];
      let params = {};
      try {
        params = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        return error(res, 400, 'Bad Request: invalid JSON');
      }
      calls.push({ method, params, at: Date.now() });
      const failure = failures.get(method);
      if (failure && (!failure.when || failure.when(params))) {
        if (failure.times !== Infinity) {
          failure.times -= 1;
          if (failure.times <= 0) failures.delete(method);
        }
        return respond(res, failure.status, failure.body);
      }
      const handler = handlers[method];
      if (!handler) return error(res, 404, 'Not Found');
      return handler(res, params);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const api = {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    userId,
    get chatId() {
      return chatId;
    },
    calls,
    messages,
    callbackAnswers,
    get commands() {
      return commands;
    },
    get shortDescription() {
      return shortDescription;
    },
    get description() {
      return description;
    },
    botId,
    topics,
    reactions,
    callsTo: (method) => calls.filter((c) => c.method === method),
    // Every visible string the bot sent (messages, buttons, answers, topic names, profile text) that holds an emoji.
    emojiFindings: () => written.map((entry) => ({ ...entry, emoji: findEmoji(entry.text) })).filter((entry) => entry.emoji.length > 0),
    written: () => [...written],
    topicNamed: (part) => [...topics.values()].find((topic) => topic.name.includes(part)),
    // Messages the bot sent into one topic, in order.
    inTopic: (threadId) => [...messages.values()].filter((m) => m.thread === threadId),
    // Moves the bot to another chat: the old chat's messages and topics are gone and message ids start again.
    switchChat({ chatId: next, forum = false, botRights = FULL_RIGHTS } = {}) {
      chatId = next;
      chat.type = forum ? 'supergroup' : 'private';
      chat.isForum = forum;
      chat.botRights = forum ? botRights : null;
      messages.clear();
      topics.clear();
      nextMessageId = 100;
    },
    setForum(value) {
      chat.isForum = value;
      chat.type = value ? 'supergroup' : 'private';
    },
    setBotRights(rights) {
      chat.botRights = rights;
    },
    // The owner starts a topic in the group.
    ownerTopic(name = 'Side topic') {
      const id = nextMessageId++;
      topics.set(id, { id, name, icon_color: ICON_COLORS[0], closed: false, deleted: false, by: 'owner' });
      return id;
    },
    // The owner deletes a topic together with its messages.
    deleteTopic(threadId) {
      const topic = topics.get(threadId);
      topic.deleted = true;
      for (const [id, message] of messages) if (message.thread === threadId) messages.delete(id);
    },
    // Bot messages in send order, with their current text after any edits.
    sent: () => [...messages.values()],
    lastMessage: () => [...messages.values()].at(-1),
    findMessage: (needle) => [...messages.values()].find((m) => m.text.includes(needle)),
    buttons: (messageId) => (messages.get(messageId)?.markup?.inline_keyboard ?? []).flat(),
    // `when(params)` limits the failure to some calls of the method.
    failNext(method, status, body, times = 1, when = null) {
      failures.set(method, { status, body, times, when });
    },
    clearFailures: () => failures.clear(),
    // Builds an update from the configured owner; pass `from` / `chat` to impersonate someone else.
    // With `thread` the message is written in that topic; like Telegram, it then replies to the topic's first message.
    message(text, { replyTo, from = userId, chat: chatOf = chatId, thread, chatType, bot = false, extra = {} } = {}) {
      const type = chatType ?? (chatOf === chatId ? chat.type : 'private');
      const messageId = 5000 + nextUpdateId;
      const inTopic = thread === undefined || thread === null ? {} : { message_thread_id: thread, is_topic_message: true };
      const implicit = inTopic.message_thread_id && !replyTo ? { reply_to_message: { message_id: thread, forum_topic_created: { name: topics.get(thread)?.name ?? 'Topic', icon_color: ICON_COLORS[0] } } } : {};
      const update = {
        update_id: nextUpdateId++,
        message: {
          message_id: messageId,
          from: { id: from, is_bot: bot },
          chat: { id: chatOf, type },
          date: 0,
          ...inTopic,
          ...(text === undefined ? {} : { text }),
          ...implicit,
          ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
          ...extra,
        },
      };
      userMessages.set(messageId, update.message);
      return update;
    },
    // The service message Telegram sends to the bot when the bot creates a topic.
    topicCreated(threadId, { from = botId } = {}) {
      const name = topics.get(threadId)?.name ?? 'Topic';
      return api.message(undefined, { from, bot: true, chat: chatId, extra: { message_thread_id: threadId, is_topic_message: true, forum_topic_created: { name, icon_color: ICON_COLORS[0] } } });
    },
    // A file the owner can send. `size` overrides the size Telegram reports (to test the bot limit without a huge body).
    addFile({ name = 'notes.txt', data = 'file content', size, kind = 'document' } = {}) {
      const bytes = Buffer.from(data);
      const id = `file-${nextFileNumber}`;
      const entry = { id, name, data: bytes, size: size ?? bytes.length, path: `${kind === 'photo' ? 'photos' : 'documents'}/file_${nextFileNumber}${name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''}` };
      nextFileNumber += 1;
      files.set(id, entry);
      return entry;
    },
    // A photo is sent in several sizes; the bot should take the largest.
    photoUpdate(file, { caption, ...options } = {}) {
      const thumb = api.addFile({ name: 'thumb.jpg', data: file.data.subarray(0, 4), kind: 'photo' });
      const extra = {
        photo: [
          { file_id: thumb.id, file_unique_id: `unique-${thumb.id}`, file_size: thumb.size, width: 90, height: 90 },
          { file_id: file.id, file_unique_id: `unique-${file.id}`, file_size: file.size, width: 1280, height: 960 },
        ],
        ...(caption ? { caption } : {}),
      };
      return api.message(undefined, { ...options, extra });
    },
    documentUpdate(file, { caption, mime = 'text/plain', ...options } = {}) {
      const extra = { document: { file_id: file.id, file_unique_id: `unique-${file.id}`, file_name: file.name, mime_type: mime, file_size: file.size }, ...(caption ? { caption } : {}) };
      return api.message(undefined, { ...options, extra });
    },
    downloads,
    files,
    failDownloads(status) {
      downloadFailure.status = status;
    },
    dropDownloads(value = true) {
      downloadFailure.drop = value;
    },
    tap(messageId, data, { from = userId, chat: chatOf = chatId } = {}) {
      const sent = messages.get(messageId);
      const inTopic = sent?.thread ? { message_thread_id: sent.thread, is_topic_message: true } : {};
      const type = chatOf === chatId ? chat.type : 'private';
      return {
        update_id: nextUpdateId++,
        callback_query: { id: `cb-${nextUpdateId}`, from: { id: from, is_bot: false }, message: { message_id: messageId, chat: { id: chatOf, type }, ...inTopic }, data },
      };
    },
    tapButton(messageId, labelPart, options) {
      const button = api.buttons(messageId).find((b) => b.text.includes(labelPart));
      if (!button) throw new Error(`no button containing "${labelPart}" on message ${messageId}`);
      return api.tap(messageId, button.callback_data, options);
    },
    push(update) {
      updates.push(update);
      flush();
      return update;
    },
    async close() {
      for (const waiter of waiters) clearTimeout(waiter.timer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return api;
}
