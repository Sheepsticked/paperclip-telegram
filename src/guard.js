import { PaperclipError } from './paperclip.js';

export const isUnauthorized = (err) => err instanceof PaperclipError && err.status === 401;

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
