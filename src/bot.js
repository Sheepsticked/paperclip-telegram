import { handleCallback } from './actions.js';
import { handleMessage } from './commands.js';
import { MESSAGE_LIMIT, truncate } from './format.js';
import { pollPaperclip } from './notifications.js';
import { PaperclipClient, PaperclipError } from './paperclip.js';
import { SerialQueue } from './queue.js';
import { TelegramClient, TelegramError, defaultSleep } from './telegram.js';

export const LONG_POLL_SECONDS = 50;
const AGENT_CACHE_MS = 10 * 60 * 1000;
const AUTH_ALERT_INTERVAL_MS = 60 * 60 * 1000;
const BACKOFF_CAP_MS = 60_000;

export const COMMANDS = [
  { command: 'new', description: 'Create a task: /new <text>' },
  { command: 'status', description: 'What is running and what waits for you' },
  { command: 'help', description: 'List the commands' },
];

export function backoffMs(failures, baseMs) {
  return Math.min(BACKOFF_CAP_MS, baseMs * 2 ** Math.max(0, failures - 1));
}

export class Bot {
  constructor({ config, tokens, state, log, fetchImpl, sleep = defaultSleep, now = Date.now, longPollSeconds = LONG_POLL_SECONDS }) {
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
    this.agents = new Map();
    this.agentsLoadedAt = 0;
  }

  // Every outgoing message goes to the one configured chat.
  async send(html, { keyboard, replyTo, forceReply, issue } = {}) {
    if (html.length > MESSAGE_LIMIT) throw new Error('refusing to send a message over the Telegram limit');
    const params = {
      chat_id: this.config.telegramChatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    if (keyboard?.length) params.reply_markup = { inline_keyboard: keyboard };
    if (forceReply) params.reply_markup = { force_reply: true, input_field_placeholder: 'Reason' };
    if (replyTo) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    const sent = await this.tg.sendMessage(params);
    if (issue) this.state.mapMessage(sent.message_id, issue.id, issue.identifier);
    return sent.message_id;
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

  async agentName(agentId) {
    if (!agentId) return null;
    if (this.now() - this.agentsLoadedAt > AGENT_CACHE_MS) {
      try {
        const list = await this.pc.listAgents(this.config.companyId);
        this.agents = new Map(list.map((agent) => [agent.id, agent.name]));
        this.agentsLoadedAt = this.now();
      } catch (err) {
        if (err instanceof PaperclipError && err.status === 401) throw err;
        this.log.warn('could not load the agent list', { error: err.message });
        this.agentsLoadedAt = this.now() - AGENT_CACHE_MS + 30_000;
      }
    }
    return this.agents.get(agentId) ?? null;
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
    const chatId = message ? message.chat?.id : callback?.message?.chat?.id;
    if (senderId !== this.config.telegramUserId || chatId !== this.config.telegramChatId) {
      this.log.info('ignored an update from an unauthorized sender');
      return;
    }
    try {
      if (callback) await handleCallback(this, callback);
      else await handleMessage(this, update);
    } catch (err) {
      this.log.error('update handling failed', { error: err.message });
      if (callback) await this.answer(callback.id, 'Something went wrong, try again');
    }
  }

  pollOnce() {
    return pollPaperclip(this);
  }

  async run() {
    await Promise.all([this.#telegramLoop(), this.#paperclipLoop()]);
    await this.queue.idle();
    this.state.save();
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
  }

  async #registerCommands() {
    try {
      await this.tg.setMyCommands(COMMANDS);
      this.commandsRegistered = true;
    } catch (err) {
      this.log.warn('could not register bot commands', { error: err.message });
    }
  }

  async #telegramLoop() {
    let failures = 0;
    while (!this.stopped) {
      try {
        if (!this.commandsRegistered) await this.#registerCommands();
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
        this.log.error('a webhook is set for this bot; use a separate bot or remove the webhook', { detail: err.description });
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
