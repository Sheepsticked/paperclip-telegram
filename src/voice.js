import fs from 'node:fs';
import { expiredOffer, markSettled, offerFromVoice, settledPlain, wasSettled } from './create.js';
import { FILE_LIMIT_BYTES } from './files.js';
import { TRANSCRIPT_LEVELS, button, escapeHtml, fitMessage, quote } from './format.js';
import { canSwitchLanguage, languageName, noteLanguage, readAgainButtons, switchLanguage, voiceLanguages } from './languages.js';
import { makeOutcome, outcomeBlock } from './outcome.js';
import { threadOf, where } from './thread.js';
import { TranscribeError } from './transcribe.js';

export const NOT_SET_UP = 'Voice notes are not set up on this machine.';
const WORKING = 'Transcribing…';
const NO_SPEECH = 'No speech heard.';
const FAILED = 'Could not transcribe this voice note.';

// "5 minutes" for a limit in whole minutes, else seconds.
export function lengthWords(seconds) {
  if (seconds % 60 !== 0) return `${seconds} seconds`;
  const minutes = seconds / 60;
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export const tooLong = (maxSeconds) => `Voice notes can be up to ${lengthWords(maxSeconds)} long.`;

// A voice note: reply "Transcribing…", transcribe it on this machine and show what was heard. `offer` is true where
// plain text would offer a new task; `replyTo` is the message the note answers, if any. The transcription itself
// runs in the voice queue, so this returns at once and the bot keeps serving buttons.
export async function handleVoice(bot, update, { offer, replyTo }) {
  const msg = update.message;
  const voice = bot.config.voice;
  if (!voice) return bot.send(NOT_SET_UP, where(bot, msg));
  const duration = Number.isFinite(msg.voice.duration) ? msg.voice.duration : 0;
  if (duration > voice.maxSeconds) return bot.send(tooLong(voice.maxSeconds), where(bot, msg));
  if (typeof msg.voice.file_id !== 'string') return bot.send(FAILED, where(bot, msg));
  const messageId = await bot.send(WORKING, where(bot, msg));
  const key = bot.state.addVoice({
    mode: offer ? 'offer' : 'confirm',
    fileId: msg.voice.file_id,
    duration,
    messageId,
    noteId: msg.message_id,
    updateId: update.update_id,
    thread: threadOf(bot, msg),
    replyTo,
    language: voiceLanguages(bot) ? switchLanguage(bot) : null,
    at: bot.now(),
  });
  bot.state.save();
  enqueueVoice(bot, key);
  return undefined;
}

// Starts the voice notes that were still being transcribed when the bot stopped, and warns when the helper is missing.
export function resumeVoice(bot) {
  const voice = bot.config.voice;
  if (!voice) return;
  try {
    fs.accessSync(voice.python, fs.constants.X_OK);
  } catch {
    bot.log.warn('voice notes are configured but the Python of the voice setup is missing: run scripts/install-voice.sh');
  }
  for (const [key, job] of bot.state.voice) if (job.status === 'pending') enqueueVoice(bot, key);
}

function enqueueVoice(bot, key) {
  bot.voiceQueue.run(() => transcribeJob(bot, key)).catch((err) => bot.log.error('voice note failed', { error: err.message }));
}

async function download(bot, fileId) {
  const info = await bot.tg.getFile({ file_id: fileId });
  if (!info?.file_path) throw new TranscribeError('Telegram gave no file path');
  return bot.tg.downloadFile(info.file_path, { maxBytes: FILE_LIMIT_BYTES });
}

// Downloads and transcribes one note, then shows the outcome through the main queue. A job that was cut off by a
// stop stays pending and starts again with the next run.
async function transcribeJob(bot, key) {
  const job = bot.state.voice.get(key);
  if (bot.stopped || job?.status !== 'pending') return;
  let result;
  try {
    result = await bot.transcriber.transcribe(await download(bot, job.fileId), { duration: job.duration, language: noteLanguage(bot, job) });
  } catch (err) {
    if (bot.stopped) return;
    bot.log.warn('voice transcription failed', { error: err.message });
    await bot.queue.run(() => finish(bot, key, FAILED));
    return;
  }
  if (bot.stopped) return;
  bot.log.info('voice note transcribed', { seconds: result.seconds, language: result.language ?? 'unknown', characters: result.text.length });
  await bot.queue.run(() => show(bot, key, result.text));
}

// Replaces the "Transcribing…" reply with a closing text and forgets the job.
async function finish(bot, key, text) {
  const job = bot.state.voice.get(key);
  if (!job) return;
  bot.state.voice.delete(key);
  bot.state.save();
  await editReply(bot, job, escapeHtml(text), []);
}

// An edit of the reply that Telegram refuses (for example the owner deleted the reply) is logged, not retried.
async function editReply(bot, job, html, keyboard) {
  try {
    await bot.edit(job.messageId, html, keyboard);
    return true;
  } catch (err) {
    bot.log.warn('could not show the result of a voice note', { error: err.message });
    return false;
  }
}

// The name of the language a note was read in; null where the config has no list of languages.
const languageLabel = (bot, job) => (voiceLanguages(bot) ? languageName(noteLanguage(bot, job)) : null);

function heardHtml(text, label, outcome, level) {
  const body = `<b>Heard</b>${label ? ` · ${escapeHtml(label)}` : ''}\n${quote(text, level)}`;
  return outcome ? `${body}\n\n${outcomeBlock({ outcome })}` : body;
}

const fitHeard = (text, label, outcome = null) => fitMessage((level) => heardHtml(text, label, outcome, level), TRANSCRIPT_LEVELS);

// Send and Cancel, then a button per other language: next to them when there is one, else in a row of their own.
function confirmKeyboard(bot, key, job) {
  const row = [button('Send', `V:s:${key}`, 'success'), button('Cancel', `V:x:${key}`, 'danger')];
  const again = readAgainButtons(bot, 'l', key, noteLanguage(bot, job));
  if (again.length === 1) return [[...row, ...again]];
  return again.length > 1 ? [row, again] : [row];
}

// The transcript is ready: no speech ends the job; in General it becomes the task offer; elsewhere the owner confirms it.
async function show(bot, key, text) {
  const job = bot.state.voice.get(key);
  if (job?.status !== 'pending') return;
  if (!text) return finish(bot, key, NO_SPEECH);
  if (job.mode === 'offer') {
    bot.state.voice.delete(key);
    try {
      await offerFromVoice(bot, job, text);
    } catch (err) {
      bot.log.warn('could not show the result of a voice note', { error: err.message });
    }
    return undefined;
  }
  Object.assign(job, { status: 'ready', text, readyAt: bot.now() });
  bot.state.save();
  if (!(await editReply(bot, job, fitHeard(text, languageLabel(bot, job)), confirmKeyboard(bot, key, job)))) {
    bot.state.voice.delete(key);
    bot.state.save();
  }
  return undefined;
}

// The message the transcript stands in for, as if the owner had typed it there.
function typedMessage(job) {
  return {
    message_id: job.noteId,
    text: job.text,
    ...(job.thread !== null ? { message_thread_id: job.thread, is_topic_message: true } : {}),
    ...(job.replyTo !== null ? { reply_to_message: { message_id: job.replyTo } } : {}),
  };
}

// The tap on a note that is gone: it was settled before, or it expired and the message is settled now.
async function gone(bot, cq) {
  const message = cq.message;
  // A note that was read again owns its message; a late tap on the buttons of an earlier reading changes nothing.
  if (bot.state.ownsVoiceMessage(message?.message_id, bot.now()) || wasSettled(bot, message?.message_id) || !message?.reply_markup?.inline_keyboard?.length) {
    return bot.answer(cq.id, 'Already handled');
  }
  await bot.answer(cq.id, 'This voice note has expired');
  const outcome = makeOutcome('Expired', null, bot.now());
  const shown = typeof message.text === 'string' && message.text.trim() ? message.text.trim() : 'Heard';
  return bot.edit(message.message_id, settledPlain(shown, outcome), []);
}

const canRead = (bot, code) => canSwitchLanguage(bot) && voiceLanguages(bot).includes(code);

// Saves the job that was just made pending, shows "Transcribing…" and starts the job in the voice queue. The job is
// saved before the edit, so a lost or refused edit, or a restart, still ends with the new reading in the message.
async function queueAgain(bot, cq, messageId, key, code) {
  bot.state.save();
  try {
    await bot.edit(messageId, WORKING, []);
  } catch (err) {
    bot.log.warn('could not show that a voice note is read again', { error: err.message });
  }
  enqueueVoice(bot, key);
  return bot.answer(cq.id, `Reading again in ${languageName(code)}`);
}

// The button of another language on a transcript: its text is dropped and the same audio is read again as a new job,
// so the buttons of the old transcript no longer match anything.
async function readAgain(bot, cq, key, job, code) {
  if (!canRead(bot, code)) return bot.answer(cq.id, 'Unknown action');
  bot.state.voice.delete(key);
  return queueAgain(bot, cq, job.messageId, bot.state.addVoice({ ...job, language: code }), code);
}

// The same on a task offer made from a note: the offer is dropped and the new transcript becomes a new offer.
async function readAgainFromOffer(bot, cq, key, code) {
  const offer = bot.state.getOffer(key, bot.now());
  if (!offer) return expiredOffer(bot, cq);
  const messageId = cq.message?.message_id;
  if (!offer.voice || !messageId || !canRead(bot, code)) return bot.answer(cq.id, 'Unknown action');
  bot.state.offers.delete(key);
  const jobKey = bot.state.addVoice({
    mode: 'offer',
    fileId: offer.voice.fileId,
    duration: offer.voice.duration,
    messageId,
    noteId: offer.messageId,
    updateId: offer.updateId,
    thread: offer.thread,
    replyTo: null,
    language: code,
    at: bot.now(),
  });
  return queueAgain(bot, cq, messageId, jobKey, code);
}

// Send, Cancel and the read-again buttons. `deliver(bot, msg)` handles the text like a typed message and says
// whether it was used.
export async function handleVoiceCallback(bot, cq, deliver) {
  const [, op, key, code] = String(cq.data).split(':');
  const messageId = cq.message?.message_id;
  if (op === 'o') return readAgainFromOffer(bot, cq, key, code);
  const job = bot.state.getVoice(key, bot.now());
  if (!job) return gone(bot, cq);
  if (op === 'l') return readAgain(bot, cq, key, job, code);
  if (op === 'x' || op === 's') {
    // The note is taken and saved before the text goes out, so neither a failure nor a restart after Paperclip took
    // it can send it twice.
    bot.state.voice.delete(key);
    bot.state.save();
    if (op === 's' && !(await deliver(bot, typedMessage(job)))) {
      bot.state.voice.set(key, job);
      bot.state.save();
      return bot.answer(cq.id, 'Not sent');
    }
    markSettled(bot, messageId);
    const outcome = makeOutcome(op === 's' ? 'Sent' : 'Cancelled', null, bot.now());
    await bot.edit(messageId, fitHeard(job.text, languageLabel(bot, job), outcome), []);
    return bot.answer(cq.id, outcome.kind);
  }
  return bot.answer(cq.id, 'Unknown action');
}
