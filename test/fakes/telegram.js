import http from 'node:http';

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre', 'blockquote', 'tg-spoiler']);
const ENTITY = /^&(amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/;

// Mirrors Telegram's HTML parse mode: known tags only, balanced, with every & < > escaped.
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
        stack.push(name);
      }
      i += whole.length - 1;
    }
  }
  return stack.length ? `Can't find end tag for "${stack.at(-1)}"` : null;
}

// A stand-in for the Telegram Bot API that records every call and checks what the real API checks.
export async function startFakeTelegram({ token = 'fake-telegram-token', userId = 1001, chatId = 1001, holdMs = 80 } = {}) {
  const calls = [];
  const messages = new Map();
  const callbackAnswers = [];
  const updates = [];
  const waiters = new Set();
  const failures = new Map();
  let nextMessageId = 100;
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

  // Telegram refuses callback data of 0 or more than 64 bytes, and more than 100 buttons.
  function checkMarkup(res, markup) {
    const buttons = (markup?.inline_keyboard ?? []).flat();
    if (buttons.length > 100) return error(res, 400, 'Bad Request: reply markup is too long'), false;
    for (const b of buttons) {
      const size = Buffer.byteLength(b.callback_data ?? '');
      if (b.callback_data !== undefined && (size === 0 || size > 64)) return error(res, 400, 'Bad Request: BUTTON_DATA_INVALID'), false;
      if (typeof b.text !== 'string' || b.text.length === 0) return error(res, 400, 'Bad Request: text buttons are unallowed in the inline keyboard'), false;
    }
    return true;
  }

  function checkMessage(res, params) {
    if (params.chat_id !== chatId) return error(res, 400, 'Bad Request: chat not found'), false;
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
      const message = {
        message_id: nextMessageId++,
        chat: { id: chatId, type: 'private' },
        date: 0,
        text: params.text,
        markup: params.reply_markup ?? null,
        replyTo: params.reply_parameters?.message_id ?? null,
        edits: 0,
      };
      messages.set(message.message_id, message);
      respond(res, 200, { ok: true, result: { message_id: message.message_id, chat: message.chat, date: 0, text: message.text } });
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
      callbackAnswers.push({ id: params.callback_query_id, text: params.text ?? '', alert: params.show_alert === true });
      respond(res, 200, { ok: true, result: true });
    },
    setMyCommands(res, params) {
      const list = params.commands;
      const valid = Array.isArray(list) && list.length <= 100 && list.every((c) => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description?.length >= 1 && c.description.length <= 256);
      if (!valid) return error(res, 400, 'Bad Request: invalid commands');
      commands = list;
      return respond(res, 200, { ok: true, result: true });
    },
    setMyShortDescription(res, params) {
      if ((params.short_description ?? '').length > 120) return error(res, 400, 'Bad Request: short description is too long');
      shortDescription = params.short_description ?? '';
      return respond(res, 200, { ok: true, result: true });
    },
    setMyDescription(res, params) {
      if ((params.description ?? '').length > 512) return error(res, 400, 'Bad Request: description is too long');
      description = params.description ?? '';
      return respond(res, 200, { ok: true, result: true });
    },
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
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
      if (failure) {
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
    chatId,
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
    callsTo: (method) => calls.filter((c) => c.method === method),
    // Bot messages in send order, with their current text after any edits.
    sent: () => [...messages.values()],
    lastMessage: () => [...messages.values()].at(-1),
    findMessage: (needle) => [...messages.values()].find((m) => m.text.includes(needle)),
    buttons: (messageId) => (messages.get(messageId)?.markup?.inline_keyboard ?? []).flat(),
    failNext(method, status, body, times = 1) {
      failures.set(method, { status, body, times });
    },
    clearFailures: () => failures.clear(),
    // Builds an update from the configured owner; pass `from` / `chat` to impersonate someone else.
    message(text, { replyTo, from = userId, chat = chatId, extra = {} } = {}) {
      return {
        update_id: nextUpdateId++,
        message: {
          message_id: 5000 + nextUpdateId,
          from: { id: from, is_bot: false },
          chat: { id: chat, type: 'private' },
          date: 0,
          ...(text === undefined ? {} : { text }),
          ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
          ...extra,
        },
      };
    },
    tap(messageId, data, { from = userId, chat = chatId } = {}) {
      return {
        update_id: nextUpdateId++,
        callback_query: { id: `cb-${nextUpdateId}`, from: { id: from, is_bot: false }, message: { message_id: messageId, chat: { id: chat, type: 'private' } }, data },
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
