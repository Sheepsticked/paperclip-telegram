import { PaperclipError } from './paperclip.js';
import { TelegramError } from './telegram.js';

export const isUnauthorized = (err) => err instanceof PaperclipError && err.status === 401;

// Telegram unreachable or overloaded: nothing sent now will work, so the poll should stop and read its window again.
export const isTelegramOutage = (err) => err instanceof TelegramError && (err.network || err.code === 429 || err.code >= 500);

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
