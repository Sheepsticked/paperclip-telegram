import { PaperclipError } from './paperclip.js';
import { TelegramError } from './telegram.js';

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// Telegram shows a picture up to 10 MB as a photo; bots send other files up to this size.
export const PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_LIMIT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 10;
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// `/api/attachments/<id>` as a relative path or after a base URL; the base is checked by the caller.
const ATTACHMENT_LINK = new RegExp(`(?<![\\w/.:~%@-])(?<base>https?://[^\\s()<>[\\]"']*?)?/api/attachments/(?<id>${UUID})(?![\\w-])`, 'gi');

const trimSlash = (url) => url.replace(/\/+$/, '').toLowerCase();

// The ids of the attachments a comment body links to, in order: relative links and links under `uiBaseUrl`.
export function linkedAttachmentIds(body, uiBaseUrl) {
  const ids = new Set();
  for (const match of String(body ?? '').matchAll(ATTACHMENT_LINK)) {
    const { base, id } = match.groups;
    if (base === undefined || trimSlash(base) === trimSlash(uiBaseUrl)) ids.add(id.toLowerCase());
  }
  return [...ids];
}

const typeOf = (attachment) => String(attachment.contentType ?? '').split(';')[0].trim().toLowerCase();

// The images to send for a comment: the attachments it links to, then the ones bound to it, minus those already sent.
function pickImages(bot, comment, attachments) {
  const byId = new Map(attachments.map((attachment) => [String(attachment.id).toLowerCase(), attachment]));
  const linked = linkedAttachmentIds(comment.body, bot.config.uiBaseUrl).map((id) => byId.get(id)).filter(Boolean);
  // The server lists the newest first.
  const bound = attachments.filter((attachment) => attachment.issueCommentId === comment.id && !linked.includes(attachment)).reverse();
  const usable = (attachment) => {
    const size = attachment.byteSize;
    const sized = !Number.isFinite(size) || (size > 0 && size <= DOCUMENT_LIMIT_BYTES);
    return IMAGE_TYPES.has(typeOf(attachment)) && sized && !bot.state.hasSentImage(attachment.id);
  };
  return [...linked, ...bound].filter(usable).slice(0, MAX_IMAGES);
}

// Short and free of URLs and tokens.
function reasonOf(err) {
  if (err instanceof PaperclipError) return [err.status, err.detail].filter(Boolean).join(' ') || 'network error';
  return err instanceof TelegramError ? err.message : (err?.name ?? 'error');
}

const refused = (err) => err instanceof TelegramError && (err.code === 400 || err.code === 413);

// A picture of 10 MB or less goes as a photo; a GIF and a bigger one go as a document so they arrive whole.
const asDocument = (attachment) => typeOf(attachment) === 'image/gif' || attachment.byteSize > PHOTO_LIMIT_BYTES;

async function download(bot, attachment) {
  const document = asDocument(attachment);
  try {
    const data = await bot.pc.downloadAttachment(attachment.id, { maxBytes: document ? DOCUMENT_LIMIT_BYTES : PHOTO_LIMIT_BYTES });
    return { id: attachment.id, document, name: attachment.originalFilename || `image.${EXTENSIONS[typeOf(attachment)]}`, type: typeOf(attachment), data };
  } catch (err) {
    bot.log.warn('could not download an image of a comment', { error: reasonOf(err) });
    return null;
  }
}

// Maps the pictures Telegram returned to the task, so a reply to one is a comment on that task.
function mapSent(bot, issue, result) {
  for (const message of [result].flat()) if (message?.message_id) bot.state.mapMessage(message.message_id, issue.id, issue.identifier);
}

// One image on its own. A photo that Telegram refuses (size or dimensions) is sent again as a document.
async function sendOne(bot, image, { issue, params }) {
  const { id, document, ...file } = image;
  const send = async (asDocument) => {
    mapSent(bot, issue, await (asDocument ? bot.tg.sendDocument(params, file) : bot.tg.sendPhoto(params, file)));
    bot.state.noteImageSent(id);
  };
  try {
    await send(document);
  } catch (err) {
    if (document || !refused(err)) {
      bot.log.warn('could not send an image of a comment', { error: reasonOf(err) });
      return;
    }
    try {
      await send(true);
    } catch (again) {
      bot.log.warn('could not send an image of a comment', { error: reasonOf(again) });
    }
  }
}

// Images of one kind: a single one on its own, several as an album. An album that Telegram refuses is sent one by one.
async function sendKind(bot, images, target) {
  if (images.length === 0) return;
  if (images.length > 1) {
    try {
      const files = images.map(({ name, type, data }) => ({ name, type, data }));
      mapSent(bot, target.issue, await bot.tg.sendMediaGroup(target.params, images[0].document ? 'document' : 'photo', files));
      for (const image of images) bot.state.noteImageSent(image.id);
      return;
    } catch (err) {
      if (!refused(err)) {
        bot.log.warn('could not send the images of a comment', { error: reasonOf(err) });
        return;
      }
    }
  }
  for (const image of images) await sendOne(bot, image, target);
}

// Sends the images of a comment as silent replies to the message that showed it (`placed` is what `sendAbout` returned).
// Nothing here may fail the caller: the comment is already out, and an image that does not arrive stays a link in it.
export async function sendCommentImages(bot, issue, comment, placed) {
  try {
    const attachments = await bot.pc.listAttachments(issue.id);
    const picked = Array.isArray(attachments) ? pickImages(bot, comment, attachments) : [];
    if (picked.length === 0) return;
    const images = [];
    for (const attachment of picked) {
      const image = await download(bot, attachment);
      if (image) images.push(image);
    }
    const target = { issue, params: bot.quietReply(placed.messageId, placed.thread) };
    // An album holds only photos or only documents, so the two kinds go separately.
    await sendKind(bot, images.filter((image) => !image.document), target);
    await sendKind(bot, images.filter((image) => image.document), target);
  } catch (err) {
    bot.log.warn('could not send the images of a comment', { error: reasonOf(err) });
  }
}
