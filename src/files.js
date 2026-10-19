import { reportFailure } from './actions.js';
import { escapeHtml } from './format.js';
import { PaperclipError } from './paperclip.js';
import { TelegramError } from './telegram.js';
import { where } from './thread.js';

// Telegram does not let a bot download anything bigger.
export const FILE_LIMIT_BYTES = 20 * 1024 * 1024;
const TOO_BIG = 'That file is over the 20 MB limit for bots.';

// A problem the owner can be told about in plain words.
export class FileProblem extends Error {}

// The file in a message: the largest photo size, or the document.
export function fileOf(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const best = msg.photo.reduce((a, b) => ((b.file_size ?? 0) >= (a.file_size ?? 0) ? b : a));
    return { fileId: best.file_id, name: `photo-${msg.message_id}.jpg`, mime: 'image/jpeg', size: best.file_size ?? null };
  }
  const doc = msg.document;
  if (doc?.file_id) return { fileId: doc.file_id, name: doc.file_name || `file-${msg.message_id}`, mime: doc.mime_type || 'application/octet-stream', size: doc.file_size ?? null };
  return null;
}

// Download problems never carry the file URL (it holds the bot token); only a short reason is kept.
function asProblem(bot, err) {
  if (!(err instanceof TelegramError)) return err;
  if (/too big/i.test(err.description)) return new FileProblem(TOO_BIG);
  bot.log.warn('could not download a file', { error: err.message });
  return new FileProblem('Could not download the file from Telegram.');
}

async function download(bot, file) {
  if (file.size !== null && file.size > FILE_LIMIT_BYTES) throw new FileProblem(TOO_BIG);
  try {
    const info = await bot.tg.getFile({ file_id: file.fileId });
    if (!info?.file_path) throw new FileProblem('Could not download the file from Telegram.');
    return await bot.tg.downloadFile(info.file_path, { maxBytes: FILE_LIMIT_BYTES });
  } catch (err) {
    throw asProblem(bot, err);
  }
}

// Uploads the file to the task and posts a comment that carries it.
export async function attachFile(bot, issue, file, caption) {
  const data = await download(bot, file);
  const attachment = await bot.pc.uploadAttachment(bot.config.companyId, issue.id, { name: file.name, type: file.mime, data });
  await bot.pc.postComment(issue.id, caption || `Attachment: ${file.name}`, { attachmentIds: [attachment.id] });
}

// Tells the owner why a file did not go through.
export async function reportFileFailure(bot, err, msg) {
  if (err instanceof FileProblem) return bot.send(escapeHtml(err.message), where(bot, msg));
  if (err instanceof PaperclipError) return reportFailure(bot, err, msg);
  throw err;
}

export async function attachToTask(bot, msg, issue, file, caption) {
  try {
    await attachFile(bot, issue, file, caption);
  } catch (err) {
    return reportFileFailure(bot, err, msg);
  }
  return bot.send(`Attached to ${escapeHtml(issue.identifier ?? 'the task')}`, { ...where(bot, msg), issue });
}
