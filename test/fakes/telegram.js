import http from 'node:http';
import { findEmoji } from '../style.js';

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'blockquote', 'tg-spoiler', 'tg-time']);
const ENTITY = /^&(amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/;
const ICON_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];
const REACTIONS = ['\u{1F44D}', '\u{1F44E}', '\u2764', '\u{1F525}', '\u{1F389}'];
const FULL_RIGHTS = { can_manage_topics: true, can_pin_messages: true, can_delete_messages: true };
const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const BUTTON_STYLES = ['danger', 'success', 'primary'];

// A date-time entity needs a `unix` time (whole seconds); its optional format is `r` or `w?[dD]?[tT]?`.
const TIME_FORMAT = /^(?:r|w?[dD]?[tT]?)$/;

// The problem with the `unix` and `format` of a date-time entity, or null when both are fine.
function timeProblem(unix, format) {
  if (unix === undefined || !/^\d{1,15}$/.test(unix)) return 'Date-time entity needs a valid "unix" time';
  if (format !== undefined && !TIME_FORMAT.test(format)) return `Date-time entity has an invalid "format" ${format}`;
  return null;
}

// The attributes of a `tg-time` tag checked as above; any attribute but unix and format is refused.
function timeTagProblem(attrs) {
  const found = {};
  for (const [, name, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) found[name] = value;
  const unknown = Object.keys(found).find((name) => name !== 'unix' && name !== 'format');
  return unknown ? `Unsupported attribute "${unknown}" in the tag "tg-time"` : timeProblem(found.unix, found.format);
}

// The problem with the query of a `tg://time` link, or null.
function timeLinkProblem(query) {
  const params = new URLSearchParams(query);
  return timeProblem(params.get('unix') ?? undefined, params.get('format') ?? undefined);
}

// The date-time entities of a classic HTML text or a rich Markdown text, as { unix, format, text } in order.
export function timeEntities(source) {
  const found = [];
  for (const match of source.matchAll(/<tg-time([^<>]*)>([^<]*)<\/tg-time>|(?<!\\)!\[([^\]]*)\]\(tg:\/\/time\?([^)]*)\)/g)) {
    if (match[4] === undefined) {
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
      found.push({ unix: Number(attrs.unix), format: attrs.format ?? '', text: match[2] });
    } else {
      const params = new URLSearchParams(match[4]);
      found.push({ unix: Number(params.get('unix')), format: params.get('format') ?? '', text: match[3] });
    }
  }
  return found;
}

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
        if (name === 'tg-time') {
          const problem = timeTagProblem(attrs);
          if (problem) return `${problem} at byte offset ${i}`;
        }
        stack.push(name);
      }
      i += whole.length - 1;
    }
  }
  return stack.length ? `Can't find end tag for "${stack.at(-1)}"` : null;
}

// The `text_mention` entities Telegram reports for inline user links; other entity types are not modelled.
// Offsets and lengths count UTF-16 units of the text with its tags removed and its entities decoded.
export function mentionEntities(html) {
  const entities = [];
  let offset = 0;
  let open = null;
  for (let i = 0; i < html.length; ) {
    const rest = html.slice(i);
    const tag = /^<(\/?)([A-Za-z][\w-]*)([^<>]*)>/.exec(rest);
    if (tag) {
      const [whole, closing, name, attrs] = tag;
      const user = /href="tg:\/\/user\?id=(\d+)"/.exec(attrs);
      if (name === 'a' && !closing) open = user ? { id: Number(user[1]), offset } : null;
      if (name === 'a' && closing && open) {
        entities.push({ type: 'text_mention', offset: open.offset, length: offset - open.offset, user: { id: open.id, is_bot: false, first_name: 'Owner' } });
        open = null;
      }
      i += whole.length;
      continue;
    }
    const ref = ENTITY.exec(rest);
    if (ref) {
      const numeric = /^#(x)?([0-9a-fA-F]+)$/.exec(ref[1]);
      offset += numeric ? String.fromCodePoint(parseInt(numeric[2], numeric[1] ? 16 : 10)).length : 1;
      i += ref[0].length;
      continue;
    }
    offset += 1;
    i += 1;
  }
  return entities;
}

const RICH_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'details', 'summary', 'tg-time']);
const RICH_ENTITY = /^&(amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|lsquo|rsquo|ldquo|rdquo|#\d+|#x[0-9a-fA-F]+);/;
const RICH_CHAR_LIMIT = 32768;
const RICH_BLOCK_LIMIT = 500;

// The line without its code spans: a backtick run closes at the next run of the same length; an unmatched run is text.
function withoutSpans(line) {
  let out = '';
  for (let i = 0; i < line.length; ) {
    if (line[i] === '\\') {
      out += line.slice(i, i + 2);
      i += 2;
    } else if (line[i] !== '`') {
      out += line[i];
      i += 1;
    } else {
      const size = /^`+/.exec(line.slice(i))[0].length;
      let j = i + size;
      let close = -1;
      while (j < line.length) {
        if (line[j] !== '`') {
          j += 1;
          continue;
        }
        const run = /^`+/.exec(line.slice(j))[0].length;
        if (run === size) {
          close = j;
          break;
        }
        j += run;
      }
      if (close < 0) {
        out += line.slice(i, i + size);
        i += size;
      } else {
        i = close + size;
      }
    }
  }
  return out;
}

// Lines of rich Markdown with the fenced code blocks and the inline code spans taken out; null when a fence stays open.
function outsideCode(markdown) {
  const kept = [];
  let fence = null;
  for (const line of markdown.split('\n')) {
    const found = /^[\s>]*(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence cannot have a backtick in its info string; such a line is a code span.
    const mark = found && !(found[1][0] === '`' && found[2].includes('`')) ? found : null;
    if (fence) {
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && /^[\s>]*(`+|~+)\s*$/.test(line)) fence = null;
      continue;
    }
    if (mark) {
      fence = mark[1];
      kept.push('(code block)');
      continue;
    }
    kept.push(withoutSpans(line));
  }
  return fence ? null : kept;
}

// Stricter than Telegram on some points so a slip shows up: no media, no unknown tag, no loose `&`, no open code block.
export function validateRichMarkdown(markdown) {
  if (typeof markdown !== 'string' || markdown.trim().length === 0) return 'message text is empty';
  if (Array.from(markdown).length > RICH_CHAR_LIMIT) return 'rich message is too long';
  const lines = outsideCode(markdown);
  if (lines === null) return "code block is not closed";
  if (lines.filter((line) => line.trim()).length > RICH_BLOCK_LIMIT) return 'rich message has too many blocks';
  const stack = [];
  for (const raw of lines) {
    // A date-time image stands for its text; one without a valid unix time is refused.
    let line = raw;
    for (const match of raw.matchAll(/(?<!\\)!\[([^\]]*)\]\(tg:\/\/time\?([^)]*)\)/g)) {
      const problem = timeLinkProblem(match[2]);
      if (problem) return problem;
      line = line.replace(match[0], match[1]);
    }
    if (/(?<!\\)!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/.test(line)) return 'media blocks are not allowed here';
    for (let i = 0; i < line.length; i += 1) {
      const rest = line.slice(i);
      if (line[i] === '\\') {
        i += 1;
      } else if (line[i] === '&') {
        if (!RICH_ENTITY.test(rest)) return `Unsupported entity at byte offset ${i}`;
      } else if (line[i] === '<') {
        const match = /^<(\/?)([A-Za-z][\w-]*)([^<>]*)>/.exec(rest);
        if (!match) return `Unescaped "<" at byte offset ${i}`;
        const [whole, closing, name, attrs] = match;
        if (!RICH_TAGS.has(name)) return `Unsupported start tag "${name}" at byte offset ${i}`;
        if (closing) {
          if (stack.pop() !== name) return `Unmatched end tag at byte offset ${i}`;
        } else {
          if (name === 'a' && !/\shref="[^"]*"/.test(attrs)) return 'Link without href';
          if (name === 'tg-time') {
            const problem = timeTagProblem(attrs);
            if (problem) return problem;
          }
          stack.push(name);
        }
        i += whole.length - 1;
      }
    }
  }
  if (stack.length) return `Can't find end tag for "${stack.at(-1)}"`;
  // The Markdown inside <details> is only parsed when it stands apart from the tags by blank lines.
  if (/<\/summary>(?!\n\n)/.test(lines.join('\n')) && /<details>/.test(markdown)) return 'details content must follow a blank line';
  return null;
}

// The user ids that rich Markdown links with tg://user, outside code.
export function richMentionIds(markdown) {
  const ids = [];
  for (const line of outsideCode(markdown) ?? []) {
    for (const match of line.matchAll(/\]\(tg:\/\/user\?id=(\d+)\)|href="tg:\/\/user\?id=(\d+)"/g)) ids.push(Number(match[1] ?? match[2]));
  }
  return ids;
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
  const sends = [];
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
  let dropMentions = false;
  let richRefusal = null;
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

  // A rich send or edit; false after answering with an error. `richRefusal` makes the fake refuse them on demand.
  function checkRich(res, params) {
    if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found'), false;
    const markdown = params.rich_message?.markdown;
    const keys = Object.keys(params.rich_message ?? {}).filter((key) => ['html', 'markdown', 'blocks'].includes(key));
    if (keys.length !== 1 || params.text !== undefined || params.parse_mode !== undefined || params.link_preview_options !== undefined) {
      return error(res, 400, 'Bad Request: rich_message must be the only content'), false;
    }
    note('text', markdown);
    if (richRefusal && richRefusal.times > 0) {
      if (richRefusal.times !== Infinity) richRefusal.times -= 1;
      return error(res, 400, richRefusal.description), false;
    }
    const problem = validateRichMarkdown(markdown);
    if (problem) return error(res, 400, `Bad Request: can't parse rich message: ${problem}`), false;
    return checkMarkup(res, params.reply_markup);
  }

  // The rich_message Telegram returns: the mention shows up as a text_mention block.
  const richResult = (markdown) => ({
    blocks: [
      {
        type: 'paragraph',
        text: dropMentions ? markdown : richMentionIds(markdown).map((id) => ({ type: 'text_mention', text: 'Owner', user: { id, is_bot: false, first_name: 'Owner' } })),
      },
    ],
  });

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
        silent: params.disable_notification === true,
      };
      messages.set(message.message_id, message);
      sends.push({ messageId: message.message_id, text: params.text, markup: params.reply_markup ?? null, silent: message.silent });
      const entities = dropMentions || params.parse_mode !== 'HTML' ? [] : mentionEntities(params.text);
      respond(res, 200, {
        ok: true,
        result: {
          message_id: message.message_id,
          chat: message.chat,
          date: 0,
          text: message.text,
          ...(entities.length > 0 ? { entities } : {}),
          ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}),
        },
      });
    },
    sendRichMessage(res, params) {
      if (!checkRich(res, params)) return;
      if (!checkThread(res, params.message_thread_id)) return;
      const thread = params.message_thread_id ?? null;
      const markdown = params.rich_message.markdown;
      const message = {
        message_id: nextMessageId++,
        chat: { id: chatId, type: chat.type },
        date: 0,
        text: markdown,
        rich: true,
        markup: params.reply_markup ?? null,
        replyTo: params.reply_parameters?.message_id ?? null,
        thread,
        pinned: null,
        edits: 0,
        silent: params.disable_notification === true,
      };
      messages.set(message.message_id, message);
      sends.push({ messageId: message.message_id, text: markdown, rich: true, markup: params.reply_markup ?? null, silent: message.silent });
      respond(res, 200, {
        ok: true,
        result: {
          message_id: message.message_id,
          chat: message.chat,
          date: 0,
          rich_message: richResult(markdown),
          ...(thread ? { message_thread_id: thread, is_topic_message: true } : {}),
        },
      });
    },
    editMessageText(res, params) {
      const rich = params.rich_message !== undefined;
      if (rich ? !checkRich(res, params) : !checkMessage(res, params)) return;
      const message = messages.get(params.message_id);
      if (!message) return error(res, 400, 'Bad Request: message to edit not found');
      const markup = params.reply_markup ?? null;
      const text = rich ? params.rich_message.markdown : params.text;
      if (message.text === text && Boolean(message.rich) === rich && JSON.stringify(message.markup) === JSON.stringify(markup)) {
        return error(res, 400, 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same');
      }
      message.text = text;
      message.rich = rich;
      message.markup = markup;
      message.edits += 1;
      respond(res, 200, { ok: true, result: { message_id: message.message_id, chat: message.chat, date: 0, ...(rich ? { rich_message: richResult(text) } : { text }) } });
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
      topics.set(id, { id, name: params.name, icon_color: params.icon_color ?? ICON_COLORS[0], iconId: params.icon_custom_emoji_id ?? '', closed: false, deleted: false, by: 'bot' });
      return respond(res, 200, { ok: true, result: { message_thread_id: id, name: params.name, icon_color: params.icon_color ?? ICON_COLORS[0] } });
    },
    editForumTopic(res, params) {
      if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found');
      note('topic name', params.name);
      const topic = topics.get(params.message_thread_id);
      if (!topic || topic.deleted) return error(res, 400, 'Bad Request: TOPIC_ID_INVALID');
      if (!mayManage() && topic.by !== 'bot') return error(res, 400, 'Bad Request: not enough rights to manage topics');
      if (params.name !== undefined && (params.name.length < 1 || params.name.length > 128)) return error(res, 400, 'Bad Request: invalid topic name length');
      const icon = params.icon_custom_emoji_id;
      const renamed = params.name !== undefined && params.name !== topic.name;
      const reiconed = icon !== undefined && icon !== topic.iconId;
      if (!renamed && !reiconed) return error(res, 400, 'Bad Request: TOPIC_NOT_MODIFIED');
      if (renamed) topic.name = params.name;
      if (reiconed) topic.iconId = icon;
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
    // Deleting a topic needs the Delete messages right and takes its messages with it.
    deleteForumTopic(res, params) {
      if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found');
      const topic = topics.get(params.message_thread_id);
      if (!topic || topic.deleted) return error(res, 400, 'Bad Request: TOPIC_ID_INVALID');
      if (!isAdmin() || chat.botRights.can_delete_messages !== true) return error(res, 400, 'Bad Request: not enough rights to delete the topic');
      api.deleteTopic(topic.id);
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
    // Every message as sent (later edits do not change these) that was not sent with disable_notification.
    loudSends: () => sends.filter((entry) => !entry.silent),
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
    // Makes the fake answer sends without the mention entities, as when Telegram does not keep a mention.
    dropMentions(value = true) {
      dropMentions = value;
    },
    // Makes the next `times` rich sends and rich edits fail with a refusal (all of them by default).
    refuseRich({ times = Infinity, description = "Bad Request: can't parse rich message" } = {}) {
      richRefusal = { times, description };
    },
    allowRich() {
      richRefusal = null;
    },
    // Messages sent or last edited as rich messages.
    richMessages: () => [...messages.values()].filter((m) => m.rich),
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
      topics.set(id, { id, name, icon_color: ICON_COLORS[0], iconId: '', closed: false, deleted: false, by: 'owner' });
      return id;
    },
    // The owner deletes one of the bot's messages.
    deleteMessage(messageId) {
      messages.delete(messageId);
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
      const folder = { photo: 'photos', voice: 'voice' }[kind] ?? 'documents';
      const entry = { id, name, data: bytes, size: size ?? bytes.length, path: `${folder}/file_${nextFileNumber}${name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''}` };
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
    // A voice note the owner sends; `duration` is the length Telegram reports, in seconds.
    voiceUpdate(file, { duration = 5, ...options } = {}) {
      const extra = { voice: { file_id: file.id, file_unique_id: `unique-${file.id}`, duration, mime_type: 'audio/ogg', file_size: file.size } };
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
      // Like Telegram, the message of a tap carries its current text and its buttons.
      const shown = sent ? { ...(sent.rich ? {} : { text: sent.text }), ...(sent.markup ? { reply_markup: sent.markup } : {}) } : {};
      return {
        update_id: nextUpdateId++,
        callback_query: { id: `cb-${nextUpdateId}`, from: { id: from, is_bot: false }, message: { message_id: messageId, chat: { id: chatOf, type }, ...inTopic, ...shown }, data },
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
