import { PaperclipError } from './paperclip.js';
import { TelegramError } from './telegram.js';

export const isUnauthorized = (err) => err instanceof PaperclipError && err.status === 401;

// Telegram unreachable or overloaded: nothing sent now will work, so the poll should stop and read its window again.
export const isTelegramOutage = (err) => err instanceof TelegramError && (err.network || err.code === 429 || err.code >= 500);

// Telegram answered with a settled refusal (a 4xx other than 429): trying the same call again will not help.
export const isRefused = (err) => err instanceof TelegramError && !err.network && err.code >= 400 && err.code < 500 && err.code !== 429;

const WARN_INTERVAL_MS = 60 * 60 * 1000;

// Logs a warning at most once an hour for each `key`.
export function warnHourly(bot, key, message, detail) {
  const last = bot.warnedAt.get(key);
  if (last !== undefined && bot.now() - last < WARN_INTERVAL_MS) return;
  bot.warnedAt.set(key, bot.now());
  bot.log.warn(message, detail);
}

// Runs one item of a poll; a failure is logged and skipped so the rest still goes out, except a 401.
export async function guarded(bot, label, job) {
  try {
    return await job();
  } catch (err) {
    if (isUnauthorized(err)) throw err;
    bot.log.warn(`could not process ${label}`, { error: err.message });
    return undefined;
  }
}
