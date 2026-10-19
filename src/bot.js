import { routeCallback } from './callbacks.js';
import { handleMessage } from './commands.js';
import { MESSAGE_LIMIT, truncate } from './format.js';
import { pollPaperclip } from './notifications.js';
import { PaperclipClient, PaperclipError } from './paperclip.js';
import { SerialQueue } from './queue.js';
import { TelegramClient, TelegramError, defaultSleep } from './telegram.js';
import { dropTopic, topicTarget } from './topics.js';
import { COMMENT_REACTION, threadGone } from './thread.js';

export const LONG_POLL_SECONDS = 50;
const AGENT_CACHE_MS = 10 * 60 * 1000;
const PROJECT_CACHE_MS = 60 * 1000;
const CONFIRM_MS = 30 * 1000;
const AUTH_ALERT_INTERVAL_MS = 60 * 60 * 1000;
const BACKOFF_CAP_MS = 60_000;

export const COMMANDS = [
  { command: 'new', description: 'Create a task: /new [@agent] [#project] <text>' },
  { command: 'task', description: 'Open a task: /task <ID>' },
  { command: 'tasks', description: 'List open tasks' },
  { command: 'find', description: 'Search tasks: /find <text>' },
  { command: 'status', description: 'What is running and what waits for you' },
  { command: 'following', description: 'Tasks you follow' },
  { command: 'agents', description: 'Agents and what they work on' },
  { command: 'settings', description: 'Notifications and mute' },
  { command: 'help', description: 'List the commands' },
];

const SHORT_DESCRIPTION = 'Open, create and follow your Paperclip tasks and answer agent questions.';
const DESCRIPTION =
  'Control Paperclip from your phone: open and update tasks, create new ones, follow the ones you care about, answer agent questions and tune the notifications.';

export function backoffMs(failures, baseMs) {
  return Math.min(BACKOFF_CAP_MS, baseMs * 2 ** Math.max(0, failures - 1));
}

export class Bot {
  constructor({ config, tokens, state, log, fetchImpl, sleep = defaultSleep, now = Date.now, longPollSeconds = LONG_POLL_SECONDS, confirmMs = CONFIRM_MS }) {
    this.config = config;
    this.state = state;
    this.log = log;
    this.sleep = sleep;
    this.now = now;
    this.longPollSeconds = longPollSeconds;
    this.tg = new TelegramClient({ baseUrl: config.telegramApiUrl, token: tokens.telegram, fetchImpl, sleep });
    this.pc = new PaperclipClient({ baseUrl: config.paperclipUrl, token: tokens.paperclip, fetchImpl });
    this.queue = new SerialQueue();
    this.abort = new AbortController();
    this.stopped = false;
    this.commandsRegistered = false;
    this.confirmMs = confirmMs;
    this.agents = new Map();
    this.agentRows = [];
    this.agentsLoadedAt = 0;
    this.projects = [];
    this.projectsLoadedAt = 0;
    this.armed = new Map();
    this.profileRegistered = false;
    this.topics = { on: false, canPin: false };
    this.topicWarnedAt = null;
    this.ignoredChats = new Set();
    this.topicCheck = null;
  }

  // Every outgoing message goes to the one configured chat; `thread` picks a topic (none means the main chat).
  async send(html, { keyboard, replyTo, forceReply, issue, thread } = {}) {
    if (html.length > MESSAGE_LIMIT) throw new Error('refusing to send a message over the Telegram limit');
    const params = {
      chat_id: this.config.telegramChatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    if (thread != null && this.topics.on) params.message_thread_id = thread;
    if (keyboard?.length) params.reply_markup = { inline_keyboard: keyboard };
    if (forceReply) params.reply_markup = { force_reply: true, input_field_placeholder: typeof forceReply === 'string' ? forceReply : 'Reason' };
    if (replyTo) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    const sent = await this.tg.sendMessage(params);
    if (issue) this.state.mapMessage(sent.message_id, issue.id, issue.identifier);
    return sent.message_id;
  }

  // Sends a message about a task into its top-level task's topic; a deleted topic is made again once.
  // `build({ own })` returns { text, keyboard }; own is true when the message lands in the task's own topic.
  async sendAbout(issue, build, { replyTo, kind } = {}) {
    let target = await topicTarget(this, issue, { kind });
    try {
      return await this.#sendInTopic(target, issue, build, replyTo);
    } catch (err) {
      if (target.thread === null || !threadGone(err)) throw err;
      dropTopic(this, target.rootId);
      target = await topicTarget(this, issue, { kind });
      return this.#sendInTopic(target, issue, build, replyTo);
    }
  }

  async #sendInTopic(target, issue, build, replyTo) {
    const { text, keyboard } = build({ own: target.own });
    const messageId = await this.send(text, {
      keyboard,
      replyTo,
      thread: target.thread,
      issue: { id: issue.id, identifier: issue.identifier },
    });
    return { messageId, thread: target.thread, own: target.own };
  }

  // Marks a message with the "comment posted" reaction; false when Telegram refuses.
  async react(messageId) {
    try {
      await this.tg.setMessageReaction({
        chat_id: this.config.telegramChatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji: COMMENT_REACTION }],
      });
      return true;
    } catch (err) {
      this.log.warn('could not react to a message', { error: err.message });
      return false;
    }
  }

  async edit(messageId, html, keyboard = []) {
    try {
      await this.tg.editMessageText({
        chat_id: this.config.telegramChatId,
        message_id: messageId,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      const harmless = err instanceof TelegramError && err.code === 400 && /not modified|not found|can't be edited/i.test(err.description);
      if (!harmless) throw err;
    }
  }

  // Replaces only the buttons of a message.
  async editKeyboard(messageId, keyboard) {
    try {
      await this.tg.editMessageReplyMarkup({
        chat_id: this.config.telegramChatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      const harmless = err instanceof TelegramError && err.code === 400 && /not modified|not found|can't be edited/i.test(err.description);
      if (!harmless) throw err;
    }
  }

  async answer(callbackId, text = '', alert = false) {
    try {
      await this.tg.answerCallbackQuery({
        callback_query_id: callbackId,
        ...(text ? { text: truncate(text, 190) } : {}),
        ...(alert ? { show_alert: true } : {}),
      });
    } catch (err) {
      this.log.warn('could not answer callback query', { error: err.message });
    }
  }

  // The agent list, cached for a while; `fresh` reads it again and lets a failure through.
  async agentRecords({ fresh = false } = {}) {
    if (fresh || this.now() - this.agentsLoadedAt > AGENT_CACHE_MS) {
      try {
        const list = await this.pc.listAgents(this.config.companyId);
        this.agentRows = list;
        this.agents = new Map(list.map((agent) => [agent.id, agent.name]));
        this.agentsLoadedAt = this.now();
      } catch (err) {
        if (fresh || (err instanceof PaperclipError && err.status === 401)) throw err;
        this.log.warn('could not load the agent list', { error: err.message });
        this.agentsLoadedAt = this.now() - AGENT_CACHE_MS + 30_000;
      }
    }
    return this.agentRows;
  }

  async agentName(agentId) {
    if (!agentId) return null;
    await this.agentRecords();
    return this.agents.get(agentId) ?? null;
  }

  // Active projects, cached briefly so paging a picker does not reload them.
  async projectList({ fresh = false } = {}) {
    if (fresh || this.now() - this.projectsLoadedAt > PROJECT_CACHE_MS) {
      this.projects = await this.pc.listProjects(this.config.companyId);
      this.projectsLoadedAt = this.now();
    }
    return this.projects;
  }

  // Done and Cancel need a second tap within the confirm window; the button label changes meanwhile.
  armedOps(messageId) {
    const ops = new Set();
    for (const [key, entry] of this.armed) {
      if (entry.messageId === messageId && entry.until > this.now()) ops.add(entry.op);
    }
    return ops;
  }

  isArmed(messageId, op) {
    return this.armedOps(messageId).has(op);
  }

  // Arms a button; `restore` redraws the message when the window ends without a second tap.
  arm(messageId, op, restore) {
    this.disarm(messageId, op);
    const timer = setTimeout(() => {
      if (this.armed.get(`${messageId}:${op}`)?.timer !== timer) return;
      this.armed.delete(`${messageId}:${op}`);
      this.queue
        .run(restore)
        .catch((err) => this.log.warn('could not reset a confirm button', { error: err.message }));
    }, this.confirmMs);
    timer.unref();
    this.armed.set(`${messageId}:${op}`, { messageId, op, until: this.now() + this.confirmMs, timer });
  }

  // Clears one armed button, or all of a message when no op is given.
  disarm(messageId, op) {
    for (const [key, entry] of [...this.armed]) {
      if (entry.messageId !== messageId || (op && entry.op !== op)) continue;
      clearTimeout(entry.timer);
      this.armed.delete(key);
    }
  }

  // Logs a rejected Paperclip token and alerts the owner at most once an hour; true when it was a 401.
  async paperclipFailed(err) {
    if (!(err instanceof PaperclipError) || err.status !== 401) return false;
    this.log.error('Paperclip rejected the API token (401): create a new board key and update the token file');
    const last = this.state.lastAuthAlertAt;
    if (last == null || this.now() - last >= AUTH_ALERT_INTERVAL_MS) {
      this.state.lastAuthAlertAt = this.now();
      this.state.save();
      try {
        await this.send('Paperclip token rejected: create a new board key');
      } catch (sendErr) {
        this.log.warn('could not send the token alert', { error: sendErr.message });
      }
    }
    return true;
  }

  // Only the configured user in the configured chat is served; everything else is dropped.
  async handleUpdate(update) {
    const message = update.message;
    const callback = update.callback_query;
    const senderId = message?.from?.id ?? callback?.from?.id;
    const chat = message ? message.chat : callback?.message?.chat;
    if (chat?.id !== undefined && chat.id !== this.config.telegramChatId) {
      // Only the chat id and type are logged, once per chat, so the owner can find the id of a new group.
      if (!this.ignoredChats.has(chat.id)) {
        this.ignoredChats.add(chat.id);
        this.log.info(`ignored an update from chat ${chat.id} (${chat.type ?? 'unknown'})`);
      }
      return;
    }
    if (senderId !== this.config.telegramUserId || chat?.id !== this.config.telegramChatId) {
      this.log.info('ignored an update from an unauthorized sender');
      return;
    }
    try {
      await this.topicsReady();
      if (callback) await routeCallback(this, callback);
      else await handleMessage(this, update);
    } catch (err) {
      this.log.error('update handling failed', { error: err.message });
      if (callback) await this.answer(callback.id, 'Something went wrong, try again');
    }
  }

  pollOnce() {
    return pollPaperclip(this);
  }

  // Resolves once the topic check ran; a failed check is tried again by the next caller.
  topicsReady() {
    if (!this.topicCheck) {
      this.topicCheck = this.#detectTopics().catch((err) => {
        this.topicCheck = null;
        throw err;
      });
    }
    return this.topicCheck;
  }

  // Topics need a forum group where the bot is an admin who may manage topics; checked once at start.
  async #detectTopics() {
    const off = (reason) => this.log.info(`topics off: ${reason}`);
    if (this.config.topics === 'off') return off('off in the config');
    const chat_id = this.config.telegramChatId;
    let chat;
    let member;
    try {
      chat = await this.tg.getChat({ chat_id });
      if (chat.type !== 'supergroup' || chat.is_forum !== true) return off('not a forum');
      const me = await this.tg.getMe();
      member = await this.tg.getChatMember({ chat_id, user_id: me.id });
    } catch (err) {
      const settled = err instanceof TelegramError && !err.network && err.code >= 400 && err.code < 500 && err.code !== 429;
      if (!settled) throw err;
      return off('the chat cannot be read');
    }
    const creator = member.status === 'creator';
    if (!creator && member.status !== 'administrator') return off('the bot is not an admin');
    if (!creator && member.can_manage_topics !== true) return off('the bot lacks the Manage topics right');
    this.topics = { on: true, canPin: creator || member.can_pin_messages === true };
    this.log.info('topics on');
    if (!this.topics.canPin) this.log.warn('the bot lacks the Pin messages right, so task views are not pinned');
    return undefined;
  }

  async run() {
    await Promise.all([this.#telegramLoop(), this.#paperclipLoop()]);
    await this.queue.idle();
    this.state.save();
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    for (const entry of this.armed.values()) clearTimeout(entry.timer);
    this.armed.clear();
  }

  async #registerCommands() {
    try {
      await this.tg.setMyCommands(COMMANDS);
      this.commandsRegistered = true;
    } catch (err) {
      this.log.warn('could not register bot commands', { error: err.message });
    }
  }

  async #registerProfile() {
    this.profileRegistered = true;
    for (const [label, call] of [
      ['short description', () => this.tg.setMyShortDescription(SHORT_DESCRIPTION)],
      ['description', () => this.tg.setMyDescription(DESCRIPTION)],
    ]) {
      try {
        await call();
      } catch (err) {
        this.log.warn(`could not set the bot ${label}`, { error: err.message });
      }
    }
  }

  async #telegramLoop() {
    let failures = 0;
    while (!this.stopped) {
      try {
        await this.topicsReady();
        if (!this.commandsRegistered) await this.#registerCommands();
        if (!this.profileRegistered) await this.#registerProfile();
        const updates = await this.tg.getUpdates(
          { offset: this.state.offset, timeout: this.longPollSeconds, allowed_updates: ['message', 'callback_query'] },
          this.abort.signal,
        );
        failures = 0;
        for (const update of updates) {
          if (this.stopped) break;
          await this.queue.run(() => this.handleUpdate(update));
          this.state.offset = update.update_id + 1;
          this.state.save();
        }
      } catch (err) {
        if (this.stopped) break;
        failures += 1;
        await this.sleep(this.#telegramFailureDelay(err, failures), this.abort.signal);
      }
    }
  }

  #telegramFailureDelay(err, failures) {
    if (err instanceof TelegramError) {
      if (err.code === 409) {
        this.log.error('Telegram 409: a webhook is set or another copy of the bot is running', { detail: err.description });
      } else if (err.code === 401 || err.code === 404) {
        this.log.error('Telegram rejected the bot token: check telegramTokenFile');
      } else {
        this.log.warn('telegram polling failed', { error: err.message });
      }
      if (err.code === 429 && err.retryAfter != null) return err.retryAfter * 1000;
    } else {
      this.log.warn('telegram polling failed', { error: err.message });
    }
    return backoffMs(failures, 1000);
  }

  async #paperclipLoop() {
    const pollMs = this.config.pollSeconds * 1000;
    let failures = 0;
    while (!this.stopped) {
      let delay = pollMs;
      try {
        await this.queue.run(() => this.pollOnce());
        failures = 0;
      } catch (err) {
        if (this.stopped) break;
        failures += 1;
        if (!(await this.paperclipFailed(err))) this.log.warn('paperclip poll failed', { error: err.message });
        delay = backoffMs(failures, Math.max(pollMs, 250));
      }
      await this.sleep(delay, this.abort.signal);
    }
  }
}
