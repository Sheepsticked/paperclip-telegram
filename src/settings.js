import { button } from './format.js';

const MUTE_HOURS = [1, 8];

const TOGGLES = [
  ['done', 'Done messages'],
  ['inReview', 'In-review messages'],
  ['runFailed', 'Failed-run alerts'],
  ['followedComments', 'Followed comments'],
  ['autoFollowCreated', 'Auto-follow tasks I create'],
];

// Which counter a muted message adds to.
const MUTED_COUNTER = { done: 'done', inReview: 'inReview', runFailed: 'runFailed', followedComments: 'comments' };

// 'send' when a notification of this kind may go out, 'off' when its toggle is off, 'muted' during a mute.
export function gate(bot, setting) {
  if (!bot.state.settings[setting]) return 'off';
  return bot.state.isMuted(bot.now()) ? 'muted' : 'send';
}

// Counts the hidden message when muted; returns true when the message should be sent.
export function allow(bot, setting) {
  const mode = gate(bot, setting);
  if (mode === 'muted') bot.state.countMuted(MUTED_COUNTER[setting]);
  return mode === 'send';
}

function untilText(iso) {
  return `${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export function renderSettings(bot) {
  const { state } = bot;
  const lines = ['<b>Settings</b>'];
  lines.push(state.isMuted(bot.now()) ? `🔕 Muted until ${untilText(state.muteUntil)}` : '🔔 Notifications are on');
  lines.push('Cards that need an answer are always sent.');
  const keyboard = TOGGLES.map(([key, label]) => [button(`${state.settings[key] ? '✅' : '⬜'} ${label}`, `S:t:${key}`)]);
  keyboard.push([
    ...MUTE_HOURS.map((hours) => button(`🔕 Mute ${hours} h`, `S:m:${hours}`)),
    button('🔔 Unmute', 'S:u'),
  ]);
  return { text: lines.join('\n'), keyboard };
}

export function catchUpLine(counts) {
  return `While muted: ${counts.done} done, ${counts.inReview} in review, ${counts.runFailed} run failures, ${counts.comments} comments, see /status`;
}

// Ends the mute; sends the catch-up line when something was hidden.
export async function endMute(bot) {
  const counts = bot.state.hiddenCounts();
  if (counts) await bot.send(catchUpLine(counts));
  bot.state.endMute();
  bot.state.save();
}

// Called by the poll: a mute that ran out is ended with its catch-up line.
export async function announceMuteEnd(bot) {
  const { state } = bot;
  if (state.muteUntil && !state.isMuted(bot.now())) await endMute(bot);
}

export async function commandSettings(bot, msg) {
  const { text, keyboard } = renderSettings(bot);
  await bot.send(text, { keyboard, replyTo: msg.message_id });
}

export async function handleSettingsCallback(bot, cq) {
  const [, op, arg] = String(cq.data).split(':');
  const { state } = bot;
  let answer = '';
  if (op === 't' && TOGGLES.some(([key]) => key === arg)) {
    state.settings[arg] = !state.settings[arg];
    state.save();
    answer = `${TOGGLES.find(([key]) => key === arg)[1]}: ${state.settings[arg] ? 'on' : 'off'}`;
  } else if (op === 'm' && MUTE_HOURS.includes(Number(arg))) {
    state.mute(bot.now(), Number(arg));
    state.save();
    answer = `Muted for ${arg} h`;
  } else if (op === 'u') {
    await endMute(bot);
    answer = 'Unmuted';
  } else {
    return bot.answer(cq.id, 'Unknown action');
  }
  const { text, keyboard } = renderSettings(bot);
  await bot.edit(cq.message.message_id, text, keyboard);
  return bot.answer(cq.id, answer);
}
