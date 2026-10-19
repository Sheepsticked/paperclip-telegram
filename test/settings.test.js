import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { followIssue } from '../src/follow.js';
import { validateTelegramHtml } from './fakes/telegram.js';
import { confirmPayload, startWorld } from './helpers.js';

async function setup(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const bot = await w.primedBot();
  return { w, bot };
}

// Rows with the colour of each button after its label: "Done messages · On [success]".
const styledRows = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => (b.style ? `${b.text} [${b.style}]` : b.text)));
const HOUR = 60 * 60 * 1000;
const texts = (w) => w.tg.sent().map((m) => m.text);

async function openSettings(w, bot) {
  await bot.handleUpdate(w.tg.message('/settings'));
  return w.tg.lastMessage();
}

test('/settings shows every toggle, the mute buttons and the always-sent note', async (t) => {
  const { w, bot } = await setup(t);
  const update = w.tg.message('/settings');
  await bot.handleUpdate(update);
  const view = w.tg.lastMessage();
  assert.equal(view.replyTo, update.message.message_id);
  assert.equal(view.text, '<b>Settings</b>\nNotifications are on\nCards that need an answer are always sent.');
  assert.deepEqual(styledRows(w, view.message_id), [
    ['Done messages · On [success]'],
    ['In-review messages · On [success]'],
    ['Failed-run alerts · On [success]'],
    ['Followed comments · On [success]'],
    ['Follow new tasks · On [success]'],
    ['Mute 1 h', 'Mute 8 h', 'Unmute'],
  ]);
  assert.equal(validateTelegramHtml(view.text), null);
});

test('a toggle flips in place, is saved, and the answer names the new value', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openSettings(w, bot);
  const sent = w.tg.sent().length;

  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Done messages'));
  assert.deepEqual(styledRows(w, view.message_id)[0], ['Done messages · Off'], 'an off toggle has no colour');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Done messages: off');
  assert.equal(w.tg.sent().length, sent);
  assert.equal(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).settings.done, false);

  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Done messages'));
  assert.deepEqual(styledRows(w, view.message_id)[0], ['Done messages · On [success]']);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Done messages: on');

  const restarted = w.makeBot();
  assert.deepEqual(restarted.state.settings, { done: true, inReview: true, runFailed: true, followedComments: true, autoFollowCreated: true });
});

test('settings survive a restart', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openSettings(w, bot);
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'In-review'));
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Mute 8 h'));
  const restarted = w.makeBot();
  assert.equal(restarted.state.settings.inReview, false);
  assert.ok(restarted.state.isMuted(restarted.now()));
});

test('a turned-off kind is not sent and not announced later', async (t) => {
  const { w, bot } = await setup(t);
  bot.state.settings.done = false;
  bot.state.settings.inReview = false;
  bot.state.settings.runFailed = false;
  const finished = w.pc.addIssue({ title: 'Finished', status: 'in_progress' });
  const waiting = w.pc.addIssue({ title: 'Waiting', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(finished.id, 'done');
  w.pc.setStatus(waiting.id, 'in_review');
  w.pc.addFailedRun({ issueId: finished.id, errorCode: 'adapter_failed', error: 'boom' });
  await bot.pollOnce();
  assert.equal(w.tg.sent().length, 0);

  bot.state.settings.done = true;
  bot.state.settings.inReview = true;
  bot.state.settings.runFailed = true;
  await bot.pollOnce();
  assert.equal(w.tg.sent().length, 0, 'what was skipped is not replayed');
});

test('cards that need an answer are sent even when everything is off and muted', async (t) => {
  const { w, bot } = await setup(t);
  for (const key of Object.keys(bot.state.settings)) bot.state.settings[key] = false;
  bot.state.mute(bot.now(), 8);
  const issue = w.pc.addIssue({ title: 'Needs an answer', status: 'in_review' });
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });
  await bot.pollOnce();
  const card = w.tg.findMessage('Deploy the change?');
  assert.ok(card);
  assert.ok(w.tg.buttons(card.message_id).length >= 2);
});

test('Mute 1 h hides messages, counts them and shows when it ends', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openSettings(w, bot);
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Mute 1 h'));

  const until = new Date(bot.state.muteUntil).getTime();
  assert.ok(Math.abs(until - (Date.now() + HOUR)) < 5000);
  assert.match(w.tg.messages.get(view.message_id).text, /^Muted until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/m);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Muted for 1 h');

  const done = w.pc.addIssue({ title: 'Done while muted', status: 'in_progress' });
  const review = w.pc.addIssue({ title: 'Review while muted', status: 'in_progress' });
  const followedIssue = w.pc.addIssue({ title: 'Followed while muted', status: 'in_progress' });
  await followIssue(bot, followedIssue);
  await bot.pollOnce();
  w.pc.setStatus(done.id, 'done');
  w.pc.setStatus(review.id, 'in_review');
  w.pc.addComment(followedIssue.id, { body: 'Quiet comment' });
  w.pc.addFailedRun({ issueId: done.id, errorCode: 'adapter_failed', error: 'boom' });
  const before = w.tg.sent().length;
  await bot.pollOnce();
  assert.equal(w.tg.sent().length, before, 'nothing is sent while muted');
  assert.deepEqual(bot.state.hiddenCounts(), { done: 1, inReview: 1, runFailed: 1, comments: 1 });

  // The mute runs out: the next poll says what was hidden, once.
  bot.state.muteUntil = new Date(Date.now() - 1000).toISOString();
  await bot.pollOnce();
  assert.equal(w.tg.lastMessage().text, 'While muted: 1 done, 1 in review, 1 run failures, 1 comments, see /status');
  assert.equal(bot.state.muteUntil, null);
  assert.equal(bot.state.hiddenCounts(), null);
  const count = w.tg.sent().length;
  await bot.pollOnce();
  assert.equal(w.tg.sent().length, count);
});

test('a mute that hid nothing ends without a message', async (t) => {
  const { w, bot } = await setup(t);
  bot.state.mute(bot.now(), 1);
  bot.state.muteUntil = new Date(Date.now() - 1000).toISOString();
  await bot.pollOnce();
  assert.equal(w.tg.sent().length, 0);
  assert.equal(bot.state.muteUntil, null);
});

test('Unmute ends the mute at once and shows what was hidden', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openSettings(w, bot);
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Mute 8 h'));
  const issue = w.pc.addIssue({ title: 'Quiet finish', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Unmute'));
  assert.ok(texts(w).includes('While muted: 1 done, 0 in review, 0 run failures, 0 comments, see /status'));
  assert.equal(w.tg.messages.get(view.message_id).text.includes('Notifications are on'), true);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unmuted');
  assert.equal(bot.state.muteUntil, null);

  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Unmute'));
  assert.equal(texts(w).filter((text) => text.startsWith('While muted')).length, 1, 'nothing hidden the second time');
});

test('a turned-off kind is not counted during a mute', async (t) => {
  const { w, bot } = await setup(t);
  bot.state.settings.done = false;
  bot.state.mute(bot.now(), 1);
  const issue = w.pc.addIssue({ title: 'Quiet finish', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  assert.equal(bot.state.hiddenCounts(), null);
});

test('unknown settings buttons are answered and change nothing', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openSettings(w, bot);
  const before = JSON.stringify(bot.state.settings);
  await bot.handleUpdate(w.tg.tap(view.message_id, 'S:t:nope'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await bot.handleUpdate(w.tg.tap(view.message_id, 'S:m:99'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await bot.handleUpdate(w.tg.tap(view.message_id, 'S:t:done', { from: 2002 }));
  assert.equal(JSON.stringify(bot.state.settings), before);
  assert.equal(bot.state.muteUntil, null);
});

test('auto-follow can be switched off from the settings', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openSettings(w, bot);
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Follow new tasks'));
  await bot.handleUpdate(w.tg.message('/new Not followed'));
  assert.equal(bot.state.following.size, 0);
});
