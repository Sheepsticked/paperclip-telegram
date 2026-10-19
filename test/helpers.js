import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { loadSettings } from '../src/config.js';
import { createLogger } from '../src/log.js';
import { State } from '../src/state.js';
import { defaultSleep } from '../src/telegram.js';
import { mentionProblems, unexpectedLoud } from './alerts.js';
import { iconProblems } from './no-icons.js';
import { startFakePaperclip } from './fakes/paperclip.js';
import { startFakeTelegram } from './fakes/telegram.js';

export const TELEGRAM_TOKEN = 'fake-telegram-token';
export const PAPERCLIP_TOKEN = 'pcp_board_faketokenvalue';
export const LEAD_AGENT_ID = 'agent-lead';
export const UI_BASE_URL = 'https://paperclip.example.com';

export function writeTokenFile(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${value}\n`, { mode });
  fs.chmodSync(file, mode);
  return file;
}

export async function waitFor(check, { timeout = 4000, interval = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// Fake Telegram + fake Paperclip + config / token / state files in a temp dir.
export async function startWorld({ config: overrides = {}, telegram = {}, paperclip = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-telegram-test-'));
  const tg = await startFakeTelegram({ token: TELEGRAM_TOKEN, ...telegram });
  const pc = await startFakePaperclip({ token: PAPERCLIP_TOKEN, ...paperclip });

  const telegramTokenFile = writeTokenFile(path.join(dir, 'telegram-token'), TELEGRAM_TOKEN);
  const paperclipTokenFile = writeTokenFile(path.join(dir, 'paperclip-token'), PAPERCLIP_TOKEN);
  const configFile = path.join(dir, 'config.json');
  const rawConfig = {
    paperclipUrl: pc.url,
    uiBaseUrl: UI_BASE_URL,
    companyId: pc.companyId,
    leadAgentId: LEAD_AGENT_ID,
    newTaskProjectId: null,
    telegramUserId: tg.userId,
    telegramChatId: tg.chatId,
    telegramTokenFile,
    paperclipTokenFile,
    telegramApiUrl: tg.url,
    pollSeconds: 1,
    // Most tests read classic messages; the rich ones switch this on.
    richMessages: 'off',
    ...overrides,
  };
  fs.writeFileSync(configFile, JSON.stringify(rawConfig), { mode: 0o600 });

  const stateDir = path.join(dir, 'state');
  const env = { PAPERCLIP_TELEGRAM_CONFIG: configFile, STATE_DIRECTORY: stateDir };
  const { config, tokens } = loadSettings(env);
  const statePath = path.join(stateDir, 'state.json');

  const logs = { out: [], err: [] };
  const sleeps = [];
  const bots = [];

  // A short real sleep keeps the loops responsive while recording the requested delay.
  const sleep = (ms, signal) => {
    sleeps.push(ms);
    return defaultSleep(Math.min(ms, 15), signal);
  };

  const world = {
    dir,
    tg,
    pc,
    config,
    tokens,
    rawConfig,
    configFile,
    statePath,
    env,
    logs,
    sleeps,
    allLogText: () => [...logs.out, ...logs.err].join(''),
    // A new Bot over the saved state file, like a process restart.
    makeBot(extra = {}) {
      const log = createLogger({
        secrets: [tokens.telegram, tokens.paperclip],
        out: { write: (text) => logs.out.push(text) },
        err: { write: (text) => logs.err.push(text) },
      });
      const state = State.load(statePath, log);
      const bot = new Bot({ config, tokens, state, log, sleep, longPollSeconds: 1, ...extra });
      bots.push(bot);
      return bot;
    },
    // A bot that already finished its first poll, so later changes count as new.
    async primedBot(extra) {
      const bot = world.makeBot(extra);
      await bot.pollOnce();
      return bot;
    },
    // Closes everything, then fails when the bot wrote an emoji, made a sound it should not have, got the owner mention wrong
    // or used a topic icon.
    async close() {
      for (const bot of bots) bot.stop();
      await tg.close();
      await pc.close();
      fs.rmSync(dir, { recursive: true, force: true });
      const found = tg.emojiFindings();
      if (found.length > 0) {
        const lines = found.map((entry) => `${entry.kind}: ${entry.emoji.join(' ')} in "${entry.text.slice(0, 80)}"`);
        throw new Error(`the bot wrote emoji:\n${lines.join('\n')}`);
      }
      const loud = unexpectedLoud(tg.loudSends());
      if (loud.length > 0) throw new Error(`the bot sent messages with a sound that should be silent:\n${loud.join('\n')}`);
      const mentions = mentionProblems(tg.calls, tg.userId);
      if (mentions.length > 0) throw new Error(`the owner mention is wrong:\n${mentions.join('\n')}`);
      const icons = iconProblems(tg.calls);
      if (icons.length > 0) throw new Error(`the bot used topic icons:\n${icons.join('\n')}`);
    },
  };
  return world;
}

export const confirmPayload = (extra = {}) => ({ version: 1, prompt: 'Deploy the change?', acceptLabel: 'Deploy', rejectLabel: 'Hold', ...extra });

// A single-choice question in the shape the server stores (canonical set plus compatibility list).
export function choiceQuestion(id, prompt, labels, { multi = false, required = true } = {}) {
  const options = labels.map((label, i) => ({ id: `${id}-opt${i + 1}`, label }));
  return {
    set: { id, prompt, answerMode: multi ? 'multi_select' : 'single_select', required, options },
    legacy: { id, prompt, selectionMode: multi ? 'multi' : 'single', required, options },
  };
}

export function textQuestion(id, prompt, { required = true } = {}) {
  return {
    set: { id, prompt, answerMode: 'text', required },
    legacy: { id, prompt, selectionMode: 'single', required, options: [{ id: `${id}-other`, label: 'Other', freeText: true }] },
  };
}

export function questionsPayload(questions, extra = {}) {
  return {
    version: 1,
    ...extra,
    questionSet: { schema: 'paperclip.question_set.v1', questions: questions.map((q) => q.set) },
    questions: questions.map((q) => q.legacy),
  };
}

// The callback payload of the first button whose label contains `part`.
export function buttonData(tg, messageId, part) {
  const button = tg.buttons(messageId).find((b) => b.text.includes(part));
  if (!button) throw new Error(`no button containing "${part}"`);
  return button.callback_data;
}

const reEscape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A pattern for the outcome block that ends a settled message; `detail` is its source text after the kind, `before` and
// `below` the source text above and under it (`before` anchors the pattern at the start), `rich` selects rich Markdown.
export function outcomePattern(kind, detail = null, { rich = false, before = null, below = '' } = {}) {
  const time = rich ? '!\\[\\d\\d:\\d\\d UTC\\]\\(tg://time\\?unix=\\d+&format=r\\)' : '<tg-time unix="\\d+" format="r">\\d\\d:\\d\\d UTC</tg-time>';
  const body = `<b>${reEscape(kind)}</b>${detail ? ` · ${reEscape(detail)}` : ''} · ${time}`;
  const block = rich ? `==${body}==` : `<blockquote>${body}</blockquote>`;
  return new RegExp(`${before === null ? '' : `^${reEscape(before)}`}${block}${reEscape(below)}$`);
}
