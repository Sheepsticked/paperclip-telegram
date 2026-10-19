import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { COMMANDS, LONG_POLL_SECONDS, backoffMs } from '../src/bot.js';
import { PaperclipError } from '../src/paperclip.js';
import { confirmPayload, startWorld, waitFor } from './helpers.js';

const OTHER_USER = 2002;
const OTHER_CHAT = 9999;

async function world(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  return w;
}

// Runs the real loops until the returned stop function is called.
function runLoops(bot) {
  const done = bot.run();
  return async () => {
    bot.stop();
    await done;
  };
}

test('updates from another user or another chat are ignored without touching Paperclip', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Needs an answer', status: 'in_review' });
  const interaction = w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });
  await bot.pollOnce();
  const card = w.tg.findMessage('Deploy the change?');

  const requests = w.pc.requests.length;
  const telegramCalls = w.tg.calls.length;
  const strangers = [
    w.tg.message('/new secret-payload', { from: OTHER_USER }),
    w.tg.message('/status', { from: OTHER_USER }),
    w.tg.message('/new secret-payload', { chat: OTHER_CHAT }),
    w.tg.message('secret-comment', { replyTo: card.message_id, from: OTHER_USER }),
    w.tg.message('secret-comment', { replyTo: card.message_id, chat: OTHER_CHAT }),
    w.tg.tapButton(card.message_id, 'Deploy', { from: OTHER_USER }),
    w.tg.tapButton(card.message_id, 'Deploy', { chat: OTHER_CHAT }),
    w.tg.tapButton(card.message_id, 'Hold', { from: OTHER_USER, chat: OTHER_CHAT }),
    { update_id: 900, inline_query: { id: 'q', from: { id: OTHER_USER }, query: 'secret-payload' } },
    { update_id: 901, edited_message: { message_id: 1, from: { id: OTHER_USER }, chat: { id: OTHER_CHAT }, text: 'secret-payload' } },
  ];
  for (const update of strangers) await bot.handleUpdate(update);

  assert.equal(w.pc.requests.length, requests, 'no Paperclip call was made');
  assert.equal(w.tg.calls.length, telegramCalls, 'nothing was sent back, edited or answered');
  assert.equal(w.pc.interactions.get(interaction.id).status, 'pending');
  const lines = w.logs.out.concat(w.logs.err);
  const wrongSender = lines.filter((line) => line.includes('ignored an update from an unauthorized sender'));
  const wrongChat = lines.filter((line) => line.includes(`ignored an update from chat ${OTHER_CHAT} (`));
  assert.equal(wrongSender.length, 6, 'each update from another user or without a chat is logged');
  assert.equal(wrongChat.length, 1, 'another chat is logged once, with its id and type');
  assert.ok(!w.allLogText().includes('secret-payload'));
  assert.ok(!w.allLogText().includes('secret-comment'));

  await bot.handleUpdate(w.tg.tapButton(card.message_id, 'Deploy'));
  assert.equal(w.pc.interactions.get(interaction.id).status, 'accepted');
});

test('a separate chat id is honoured: only that chat is served and written to', async (t) => {
  const w = await world(t, { telegram: { userId: 1001, chatId: -5005 }, config: { telegramChatId: -5005 } });
  const bot = await w.primedBot();
  await bot.handleUpdate(w.tg.message('/help', { chat: 1001 }));
  assert.equal(w.tg.callsTo('sendMessage').length, 0, 'the owner in another chat is ignored');
  await bot.handleUpdate(w.tg.message('/help'));
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
  assert.equal(w.tg.callsTo('sendMessage')[0].params.chat_id, -5005);
});

test('every outgoing message goes to the configured chat only', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Anything', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  w.pc.addFailedRun({ errorCode: 'adapter_failed' });
  await bot.pollOnce();
  await bot.handleUpdate(w.tg.message('/status'));
  assert.ok(w.tg.callsTo('sendMessage').length >= 3);
  for (const call of w.tg.callsTo('sendMessage')) assert.equal(call.params.chat_id, w.config.telegramChatId);
  for (const call of w.tg.callsTo('editMessageText')) assert.equal(call.params.chat_id, w.config.telegramChatId);
  for (const call of w.tg.calls) assert.notEqual(call.method, 'deleteWebhook');
});

test('the loops serve the owner, register commands once and persist the offset', async (t) => {
  const w = await world(t);
  const bot = w.makeBot();
  const stop = runLoops(bot);

  await waitFor(() => w.tg.commands, { label: 'setMyCommands' });
  for (const stranger of [w.tg.message('/new secret-payload', { from: OTHER_USER }), w.tg.message('x', { chat: OTHER_CHAT })]) w.tg.push(stranger);
  const help = w.tg.push(w.tg.message('/help'));
  await waitFor(() => w.tg.callsTo('sendMessage').length >= 1, { label: 'help reply' });
  await waitFor(() => bot.state.offset === help.update_id + 1, { label: 'offset' });
  await stop();

  assert.deepEqual(w.tg.commands, COMMANDS);
  assert.equal(w.tg.callsTo('setMyCommands').length, 1);
  const polls = w.tg.callsTo('getUpdates');
  assert.deepEqual(polls[0].params.allowed_updates, ['message', 'callback_query']);
  assert.equal(polls[0].params.timeout, 1);
  assert.equal(LONG_POLL_SECONDS, 50);
  assert.equal(w.pc.requests.filter((r) => r.method !== 'GET').length, 0, 'strangers caused no writes');
  assert.equal(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).offset, help.update_id + 1);
  assert.equal(fs.statSync(w.statePath).mode & 0o777, 0o600);

  // After a restart the saved offset is used and nothing is handled twice.
  const sent = w.tg.callsTo('sendMessage').length;
  const restarted = w.makeBot();
  const stopAgain = runLoops(restarted);
  await waitFor(() => w.tg.callsTo('getUpdates').some((c, i) => i >= polls.length && c.params.offset === help.update_id + 1), { label: 'resumed poll' });
  await stopAgain();
  assert.equal(w.tg.callsTo('sendMessage').length, sent);
  assert.equal(w.tg.callsTo('setMyCommands').length, 2, 'a new process registers the commands again');
});

test('the menu lists the commands in order and the bot profile text is set once', async (t) => {
  const w = await world(t);
  const bot = w.makeBot();
  const stop = runLoops(bot);
  await waitFor(() => w.tg.description, { label: 'profile text' });
  await stop();

  assert.deepEqual(
    w.tg.commands.map((c) => c.command),
    ['new', 'task', 'tasks', 'find', 'status', 'following', 'agents', 'projects', 'settings', 'help'],
  );
  assert.ok(w.tg.shortDescription.length > 0 && w.tg.shortDescription.length <= 120);
  assert.ok(w.tg.description.length > 0 && w.tg.description.length <= 512);
  assert.equal(w.tg.callsTo('setMyShortDescription').length, 1);
  assert.equal(w.tg.callsTo('setMyDescription').length, 1);
});

test('a refused profile text does not stop the bot and is not retried', async (t) => {
  const w = await world(t);
  w.tg.failNext('setMyShortDescription', 400, { ok: false, error_code: 400, description: 'Bad Request: nope' });
  w.tg.failNext('setMyDescription', 500, { ok: false, error_code: 500, description: 'Internal Server Error' });
  const bot = w.makeBot();
  const stop = runLoops(bot);
  w.tg.push(w.tg.message('/help'));
  await waitFor(() => w.tg.callsTo('sendMessage').length >= 1, { label: 'help reply' });
  await waitFor(() => w.tg.callsTo('getUpdates').length >= 3, { label: 'more polls' });
  await stop();

  assert.equal(w.tg.callsTo('setMyShortDescription').length, 1);
  assert.equal(w.tg.callsTo('setMyDescription').length, 1);
  assert.ok(w.logs.err.concat(w.logs.out).some((line) => line.includes('could not set the bot short description')));
  assert.ok(w.logs.err.concat(w.logs.out).some((line) => line.includes('could not set the bot description')));
});

test('a tap that arrives through the loop answers the card', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Loop card', status: 'in_review' });
  const interaction = w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });
  await bot.pollOnce();
  const card = w.tg.findMessage('Deploy the change?');
  const stop = runLoops(bot);
  w.tg.push(w.tg.tapButton(card.message_id, 'Deploy'));
  await waitFor(() => w.pc.interactions.get(interaction.id).status === 'accepted', { label: 'accept' });
  await stop();
  assert.deepEqual(w.tg.buttons(card.message_id), []);
});

test('a Paperclip 401 is logged and alerted once, however often it repeats', async (t) => {
  const w = await world(t);
  w.pc.setUnauthorized(true);
  const bot = w.makeBot();
  const stop = runLoops(bot);

  await waitFor(() => w.tg.findMessage('Token rejected'), { label: 'token alert' });
  const before = w.sleeps.length;
  await waitFor(() => w.sleeps.length >= before + 5, { label: 'more failed polls' });
  await stop();

  const alerts = w.tg.sent().filter((m) => m.text.includes('Token rejected'));
  assert.equal(alerts.length, 1);
  assert.ok(w.logs.err.some((line) => line.includes('401')));
  assert.ok(!w.allLogText().includes(w.tokens.paperclip));
});

test('the 401 alert may repeat after an hour', async (t) => {
  const w = await world(t);
  let now = 1_700_000_000_000;
  const bot = w.makeBot({ now: () => now });
  const unauthorized = new PaperclipError('GET', '/x', { status: 401, detail: 'no' });
  assert.equal(await bot.paperclipFailed(unauthorized), true);
  now += 30 * 60 * 1000;
  assert.equal(await bot.paperclipFailed(unauthorized), true);
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
  now += 31 * 60 * 1000;
  await bot.paperclipFailed(unauthorized);
  assert.equal(w.tg.callsTo('sendMessage').length, 2);
  assert.equal(await bot.paperclipFailed(new PaperclipError('GET', '/x', { status: 500 })), false);
});

test('a Telegram 429 is retried after retry_after seconds', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  w.tg.failNext('sendMessage', 429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } });
  await bot.handleUpdate(w.tg.message('/help'));
  assert.deepEqual(w.sleeps, [3000]);
  assert.equal(w.tg.callsTo('sendMessage').length, 2);
  assert.equal(w.tg.sent().length, 1, 'the message arrived once');
});

test('a Telegram 429 that keeps coming gives up after a few waits and the bot carries on', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  w.tg.failNext('sendMessage', 429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } }, Infinity);
  await bot.handleUpdate(w.tg.message('/help'));
  assert.deepEqual(w.sleeps, [2000, 2000, 2000]);
  assert.ok(w.logs.err.some((line) => line.includes('update handling failed')));
  w.tg.clearFailures();
  await bot.handleUpdate(w.tg.message('/help'));
  assert.equal(w.tg.sent().length, 1);
});

test('a 429 on the long poll is waited out', async (t) => {
  const w = await world(t);
  w.tg.failNext('getUpdates', 429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } });
  const bot = w.makeBot();
  const stop = runLoops(bot);
  await waitFor(() => w.sleeps.includes(7000), { label: 'retry_after sleep' });
  await stop();
});

test('a webhook conflict is logged clearly and the webhook is never deleted', async (t) => {
  const w = await world(t);
  w.tg.failNext(
    'getUpdates',
    409,
    { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first" },
    Infinity,
  );
  const bot = w.makeBot();
  const stop = runLoops(bot);
  await waitFor(() => w.sleeps.some((ms) => ms >= 2000), { label: 'backoff' });
  await stop();

  assert.ok(w.logs.err.some((line) => line.includes('Telegram 409: a webhook is set or another copy of the bot is running')));
  assert.equal(w.tg.callsTo('deleteWebhook').length, 0);
  assert.ok(w.sleeps.some((ms) => ms >= 2000), 'the retry delay grows');
});

test('a rejected Telegram token is explained in the log without printing it', async (t) => {
  const w = await world(t);
  const bot = w.makeBot();
  // The long poll answers 401, as it does for a revoked bot token.
  w.tg.failNext('getUpdates', 401, { ok: false, error_code: 401, description: 'Unauthorized' }, Infinity);
  const stop = runLoops(bot);
  await waitFor(() => w.logs.err.some((line) => line.includes('Telegram rejected the bot token')), { label: 'log line' });
  await stop();
  assert.ok(!w.allLogText().includes(w.tokens.telegram));
});

test('a Telegram outage is survived with growing, capped delays', async (t) => {
  const w = await world(t);
  const bot = w.makeBot();
  w.tg.failNext('getUpdates', 500, { ok: false, error_code: 500, description: 'Internal Server Error' }, 4);
  const stop = runLoops(bot);
  await waitFor(() => w.sleeps.filter((ms) => ms < 1000 * 60).length >= 4 && w.tg.callsTo('getUpdates').length >= 5, { label: 'recovery' });
  await stop();
  const telegramDelays = w.sleeps.filter((ms) => [1000, 2000, 4000, 8000].includes(ms));
  assert.ok(telegramDelays.includes(2000) && telegramDelays.includes(4000));
});

test('backoff doubles and is capped at one minute', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 12].map((n) => backoffMs(n, 1000)), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(backoffMs(0, 1000), 1000);
  assert.equal(backoffMs(3, 15000), 60000);
});

test('stopping the bot ends both loops and saves the state', async (t) => {
  const w = await world(t);
  const bot = w.makeBot();
  const done = bot.run();
  await waitFor(() => w.pc.requests.length > 0, { label: 'first poll' });
  bot.stop();
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('run() did not return after stop()')), 3000))]);
  assert.ok(fs.existsSync(w.statePath));
  assert.ok(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).baselineAt);
});
