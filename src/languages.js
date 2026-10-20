import { button } from './format.js';

// A Whisper language code: 2 or 3 lowercase letters.
export const LANGUAGE_CODE = /^[a-z]{2,3}$/;

export const MAX_LANGUAGES = 4;

const NAMES = new Intl.DisplayNames(['en'], { type: 'language' });

// "English" for "en"; the code itself when the runtime has no name for it.
export const languageName = (code) => NAMES.of(code) ?? code;

// The languages of the voice switch, or null when the config does not list any.
export const voiceLanguages = (bot) => bot.config.voice?.languages ?? null;

// True where a note can be read again in another language: the config lists at least two.
export const canSwitchLanguage = (bot) => (voiceLanguages(bot)?.length ?? 0) >= 2;

// The language new notes are read in: the picked one while it is still listed, else the first.
export function switchLanguage(bot) {
  const languages = voiceLanguages(bot);
  if (!languages) return null;
  return languages.includes(bot.state.voiceLanguage) ? bot.state.voiceLanguage : languages[0];
}

// The listed language after the current one, wrapping around.
export function nextLanguage(bot) {
  const languages = voiceLanguages(bot);
  return languages[(languages.indexOf(switchLanguage(bot)) + 1) % languages.length];
}

// The language a note is read in: its own, else the switch. Without a list in the config it is the fixed language,
// or null for detection.
export function noteLanguage(bot, job) {
  if (!voiceLanguages(bot)) return bot.config.voice?.language ?? null;
  return job.language ?? switchLanguage(bot);
}

// One neutral button per listed language other than `current`, to read a note again; none without a switch.
// `op` is the voice action of the button and `key` the job or offer it belongs to.
export function readAgainButtons(bot, op, key, current) {
  if (!canSwitchLanguage(bot)) return [];
  return voiceLanguages(bot)
    .filter((code) => code !== current)
    .map((code) => button(languageName(code), `V:${op}:${key}:${code}`));
}
