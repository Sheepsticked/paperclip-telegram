import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateTelegramHtml } from './fakes/telegram.js';
import { mentioned } from './alerts.js';
import { confirmPayload, startWorld, UI_BASE_URL } from './helpers.js';

const GROUP_ID = -1001234567890;
const TASK_URL = `${UI_BASE_URL}/TST/issues/TST-1`;
const runUrlOf = (run, agentId = 'agent-1') => `${UI_BASE_URL}/TST/agents/${agentId}/runs/${run.id}`;

const sentTexts = (w) => w.tg.sent().map((m) => m.text);
const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));

async function world(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  return w;
}

test('done message quotes the last agent comment and links the task id', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Write the docs', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.pollOnce();

  const body = ['line 1 <b>&</b>', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'].join('\n');
  w.pc.addComment(issue.id, { body, authorType: 'agent' });
  w.pc.addComment(issue.id, { body: 'thanks, looks good', authorType: 'user' });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  const message = w.tg.findMessage('Done');
  assert.ok(message, 'a done message was sent');
  assert.equal(
    message.text,
    `<b>Done</b> · <a href="${TASK_URL}">TST-1</a> Write the docs\n<blockquote expandable>line 1 &lt;b&gt;&amp;&lt;/b&gt;\nline 2\nline 3\nline 4\nline 5\nline 6</blockquote>`,
  );
  assert.equal(validateTelegramHtml(message.text), null);
  assert.ok(!message.text.includes('thanks'));
  assert.deepEqual(rowsOf(w, message.message_id), [['Open task']]);
  assert.equal(w.tg.buttons(message.message_id)[0].callback_data, `T:v:${issue.id}`);
});

test('a long comment is cut to 2000 characters', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Long report', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.addComment(issue.id, { body: 'x'.repeat(2500) });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  const message = w.tg.findMessage('Done');
  const quote = /<blockquote expandable>(.*)<\/blockquote>/s.exec(message.text)[1];
  assert.equal(Array.from(quote).length, 2000);
  assert.ok(quote.endsWith('…'));
});

test('done and in-review messages in General link the id and carry an Open task button', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const finished = w.pc.addIssue({ title: 'Finished work', status: 'in_progress' });
  const reviewed = w.pc.addIssue({ title: 'Reviewed work', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(finished.id, 'done');
  w.pc.setStatus(reviewed.id, 'in_review');
  await bot.pollOnce();

  const link = (issue) => `<a href="${UI_BASE_URL}/TST/issues/${issue.identifier}">${issue.identifier}</a>`;
  const done = w.tg.findMessage('Done');
  const review = w.tg.findMessage('In review');
  assert.equal(done.text, `<b>Done</b> · ${link(finished)} Finished work`);
  assert.equal(review.text, `<b>In review</b> · ${link(reviewed)} Reviewed work`);
  assert.deepEqual(rowsOf(w, done.message_id), [['Open task']]);
  assert.deepEqual(rowsOf(w, review.message_id), [['Open task']]);
  assert.equal(w.tg.buttons(review.message_id)[0].callback_data, `T:v:${reviewed.id}`);
  assert.ok(!sentTexts(w).some((text) => text.includes('Open in Paperclip')));
});

test('done and in-review messages in the task\'s own topic are the kind word alone, with no buttons', async (t) => {
  const w = await world(t, { telegram: { chatId: GROUP_ID, forum: true } });
  const bot = await w.primedBot();
  const finished = w.pc.addIssue({ title: 'Finished work', status: 'in_progress' });
  const reviewed = w.pc.addIssue({ title: 'Reviewed work', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.addComment(reviewed.id, { body: 'Ready for review.' });
  w.pc.setStatus(finished.id, 'done');
  w.pc.setStatus(reviewed.id, 'in_review');
  await bot.pollOnce();

  const inTopic = (issue) => w.tg.inTopic(bot.state.topics.get(issue.id).thread);
  const done = inTopic(finished).at(-1);
  const review = inTopic(reviewed).at(-1);
  assert.equal(done.text, mentioned('Done', w.tg.userId));
  assert.equal(review.text, '<b>In review</b>\n<blockquote>Ready for review.</blockquote>');
  assert.deepEqual(rowsOf(w, done.message_id), []);
  assert.deepEqual(rowsOf(w, review.message_id), []);
  assert.equal(w.tg.sent().filter((m) => m.thread === null && m.message_id !== bot.state.boardMessageId).length, 0, 'nothing but the board went to General');
});

test('a task without any agent comment still gets a message', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Quiet work', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  const message = w.tg.findMessage('Done');
  assert.ok(message);
  assert.ok(!message.text.includes('<blockquote>'));
});

test('in_review message is sent when no card is involved', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Needs a look', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.addComment(issue.id, { body: 'Ready for review.' });
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  const message = w.tg.findMessage('In review');
  assert.ok(message);
  assert.equal(message.text, `<b>In review</b> · <a href="${TASK_URL}">TST-1</a> Needs a look\n<blockquote>Ready for review.</blockquote>`);
});

test('no in_review message when a card was sent in the same poll', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Waiting on you', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
  assert.equal(w.tg.findMessage('In review'), undefined);
  assert.ok(w.tg.findMessage('Deploy the change?'));
});

test('no in_review message while the card is still pending, but done is still reported', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Waiting on you', status: 'in_progress' });
  await bot.pollOnce();
  const interaction = w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  assert.equal(w.tg.findMessage('In review'), undefined);

  w.pc.resolveElsewhere(interaction.id, 'accepted');
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  assert.ok(w.tg.findMessage('Done'));
});

test('each status change is reported once', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Flip flop', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 1);

  w.pc.setStatus(issue.id, 'in_progress');
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 2);
});

test('the issue list is read through a short window with the documented query', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  w.pc.requests.length = 0;
  await bot.pollOnce();
  const list = w.pc.requests.find((r) => r.path.endsWith('/issues'));
  const query = new URLSearchParams(list.query);
  assert.equal(query.get('sortField'), 'updated');
  assert.equal(query.get('sortDir'), 'desc');
  assert.equal(query.get('limit'), '200');
  assert.ok(Number.isFinite(Date.parse(query.get('updatedSince'))));
  const attention = w.pc.requests.find((r) => r.path.endsWith('/attention'));
  const attentionQuery = new URLSearchParams(attention.query);
  assert.equal(attentionQuery.get('limit'), '100');
  assert.equal(attentionQuery.get('includeDismissed'), 'true');
});

test('more than ten changes in one poll become one summary line', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  for (let i = 0; i < 9; i += 1) w.pc.addIssue({ title: `Done ${i}`, status: 'done' });
  for (let i = 0; i < 3; i += 1) w.pc.addIssue({ title: `Review ${i}`, status: 'in_review' });
  await bot.pollOnce();
  assert.deepEqual(sentTexts(w), ['<b>9 done</b>, 3 in review since the last check, see /status']);
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
});

test('failed run is alerted once and routine error codes are skipped', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Flaky job', status: 'in_progress', assigneeAgentId: 'agent-1' });
  const failed = w.pc.addFailedRun({ issueId: issue.id, errorCode: 'adapter_failed', error: 'The adapter exited\nsecond line' });
  for (const errorCode of ['cancelled', 'agent_paused', 'issue_not_in_progress']) w.pc.addFailedRun({ errorCode, error: 'routine' });

  await bot.pollOnce();
  await bot.pollOnce();
  const alerts = w.tg.sent().filter((m) => m.text.includes('Run failed'));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].text, `<b>Run failed</b> · <a href="${UI_BASE_URL}/TST/issues/TST-1">TST-1</a> Flaky job\n<a href="${runUrlOf(failed)}">Dev</a>: adapter_failed — The adapter exited`);
  assert.deepEqual(rowsOf(w, alerts[0].message_id), [['Open task']]);
  assert.ok(!sentTexts(w).some((text) => text.includes('Open in Paperclip')));
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
});

test('a run failure alert in the task\'s own topic keeps the run link on the agent name and has no buttons', async (t) => {
  const w = await world(t, { telegram: { chatId: GROUP_ID, forum: true } });
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Flaky job', status: 'in_progress', assigneeAgentId: 'agent-1' });
  const failed = w.pc.addFailedRun({ issueId: issue.id, errorCode: 'adapter_failed', error: 'The adapter exited' });
  await bot.pollOnce();

  const alert = w.tg.inTopic(bot.state.topics.get(issue.id).thread).find((m) => m.text.includes('Run failed'));
  assert.equal(alert.text, `${mentioned('Run failed', w.tg.userId)}\n<a href="${runUrlOf(failed)}">Dev</a>: adapter_failed — The adapter exited`);
  assert.deepEqual(rowsOf(w, alert.message_id), []);
  assert.ok(!sentTexts(w).some((text) => text.includes('Open in Paperclip')));
});

test('a failed run that has no task still alerts, with the agent name linking to the run', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const failed = w.pc.addFailedRun({ agentId: 'agent-1', errorCode: 'timeout', error: 'took too long' });
  await bot.pollOnce();
  const alert = w.tg.findMessage('Run failed');
  assert.equal(alert.text, `<b>Run failed</b> · <a href="${runUrlOf(failed)}">Dev</a>\ntimeout — took too long`);
  assert.deepEqual(rowsOf(w, alert.message_id), []);
});

test('the routine error code list is configurable', async (t) => {
  const w = await world(t, { config: { routineRunErrorCodes: ['adapter_failed'] } });
  const bot = await w.primedBot();
  w.pc.addFailedRun({ errorCode: 'adapter_failed' });
  w.pc.addFailedRun({ errorCode: 'cancelled' });
  await bot.pollOnce();
  const alerts = sentTexts(w);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /cancelled/);
});

test('first start sends pending cards but backfills nothing', async (t) => {
  const w = await world(t);
  w.pc.addIssue({ title: 'Old done', status: 'done' });
  w.pc.addIssue({ title: 'Old review', status: 'in_review' });
  w.pc.addFailedRun({ errorCode: 'adapter_failed' });
  const waiting = w.pc.addIssue({ title: 'Needs an answer', status: 'in_review' });
  w.pc.addInteraction(waiting.id, { kind: 'request_confirmation', payload: confirmPayload() });

  const bot = w.makeBot();
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
  assert.match(w.tg.lastMessage().text, /Deploy the change\?/);
  assert.ok(w.tg.buttons(w.tg.lastMessage().message_id).length > 0);

  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
});

test('first start sends at most ten pending cards and points to /status', async (t) => {
  const w = await world(t);
  for (let i = 0; i < 12; i += 1) {
    const issue = w.pc.addIssue({ title: `Question ${i}`, status: 'in_review' });
    w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: `Prompt ${i}` }) });
  }
  const bot = w.makeBot();
  await bot.pollOnce();
  const texts = sentTexts(w);
  assert.equal(texts.length, 11);
  assert.equal(texts.at(-1), '+2 more, see /status');
  assert.equal(texts.filter((text) => text.includes('Deploy') || text.includes('Prompt')).length, 10);
});

test('the attention feed is read across pages', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  for (let i = 0; i < 105; i += 1) w.pc.addFailedRun({ errorCode: 'cancelled' });
  w.pc.requests.length = 0;
  await bot.pollOnce();
  assert.equal(w.pc.requests.filter((r) => r.path.endsWith('/attention')).length, 2);
});

test('a restart neither re-sends cards nor re-alerts runs, and keeps the offset', async (t) => {
  const w = await world(t);
  const first = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Needs an answer', status: 'in_review' });
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });
  w.pc.addFailedRun({ errorCode: 'adapter_failed' });
  await first.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 2);

  const update = w.tg.message('/help');
  await first.handleUpdate(update);
  first.state.offset = update.update_id + 1;
  first.state.save();
  const before = w.tg.callsTo('sendMessage').length;

  const second = w.makeBot();
  assert.equal(second.state.offset, update.update_id + 1);
  await second.pollOnce();
  await second.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, before);
  assert.equal(second.state.pendingCards().length, 1);
});

test('a change made while the bot was stopped is reported after a restart', async (t) => {
  const w = await world(t);
  const first = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Finished while away', status: 'in_progress' });
  await first.pollOnce();

  w.pc.setStatus(issue.id, 'done');
  const second = w.makeBot();
  await second.pollOnce();
  assert.ok(w.tg.findMessage('Done'));
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
});

test('state is saved as a private file', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  assert.ok(bot.state.baselineAt);
  const { mode } = fs.statSync(w.statePath);
  assert.equal(mode & 0o077, 0);
});

test('a Paperclip outage during a poll is retried on the next poll without losing changes', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Eventually done', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');

  w.pc.setDropConnections(true);
  await assert.rejects(bot.pollOnce());
  w.pc.setDropConnections(false);
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
  assert.ok(w.tg.findMessage('Done'));
});

test('a long comment full of special characters stays valid HTML under the limit', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: '<&>'.repeat(60), status: 'in_progress' });
  await bot.pollOnce();
  w.pc.addComment(issue.id, { body: '<&>'.repeat(5000) });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  const message = w.tg.findMessage('Done');
  assert.ok(message, 'the message was accepted by the fake, which checks length and HTML');
  assert.ok(message.text.length <= 4096);
  assert.equal(validateTelegramHtml(message.text), null);
  assert.ok(message.text.includes(`<a href="${TASK_URL}">TST-1</a>`));
  assert.deepEqual(rowsOf(w, message.message_id), [['Open task']]);
});

test('the first-start card limit holds for later polls and restarts, and /status still lists the rest', async (t) => {
  const w = await world(t);
  for (let i = 0; i < 25; i += 1) {
    const issue = w.pc.addIssue({ title: `Question ${i}`, status: 'in_review' });
    w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: `Prompt ${i}` }) });
  }
  const bot = w.makeBot();
  await bot.pollOnce();
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 11);
  assert.equal(sentTexts(w).at(-1), '+15 more, see /status');

  const restarted = w.makeBot();
  await restarted.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 11);
  assert.equal(restarted.state.pendingCards().length, 10);

  await restarted.handleUpdate(w.tg.message('/status'));
  const status = w.tg.callsTo('sendMessage').slice(11).map((call) => call.params.text).join('\n');
  assert.match(status, /<b>Waiting for you<\/b> \(25\)/);
  assert.match(status, /\+10 more/);
});

// An issue whose interactions cannot be read, a card on another issue, a failed run and a done change.
async function brokenItemSetup(w) {
  const bot = await w.primedBot();
  const finished = w.pc.addIssue({ title: 'Finished work', status: 'in_progress' });
  await bot.pollOnce();
  const broken = w.pc.addIssue({ title: 'Broken lookups', status: 'in_review' });
  w.pc.addInteraction(broken.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'Broken question' }) });
  const fine = w.pc.addIssue({ title: 'Fine issue', status: 'in_review' });
  w.pc.addInteraction(fine.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'Fine question' }) });
  w.pc.addFailedRun({ errorCode: 'adapter_failed', error: 'crashed' });
  w.pc.setStatus(finished.id, 'done');
  return { bot, broken, finished };
}

test('one issue whose interactions fail does not stop the cards, alerts and updates of the poll', async (t) => {
  const w = await world(t);
  const { bot, broken } = await brokenItemSetup(w);
  w.pc.failRequests('GET', new RegExp(`/api/issues/${broken.id}/interactions$`), 500);

  await bot.pollOnce();
  assert.ok(w.tg.findMessage('Fine question'), 'the card on the other issue was sent');
  assert.ok(w.tg.findMessage('Run failed'), 'the failed run was alerted');
  assert.ok(w.tg.findMessage('Done'), 'the done change was reported');
  assert.equal(w.tg.findMessage('Broken question'), undefined);
  assert.ok(w.tg.findMessage('In review'), 'the issue without a known card is reported as in review');
  assert.ok(w.logs.err.some((line) => line.includes('could not process card TST-2') && line.includes('500')));

  w.pc.clearFailures();
  await bot.pollOnce();
  assert.ok(w.tg.findMessage('Broken question'), 'the card is sent once its lookup works again');
  assert.equal(w.tg.sent().length, 5);
});

test('a Telegram rejection of one card does not stop the rest of the poll', async (t) => {
  const w = await world(t);
  const { bot } = await brokenItemSetup(w);
  w.tg.failNext('sendMessage', 400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" });

  await bot.pollOnce();
  assert.equal(w.tg.sent().length, 4, 'one card, the run alert, an in-review line and the done message');
  assert.ok(w.tg.findMessage('Run failed'));
  assert.ok(w.tg.findMessage('Done'));
  assert.equal(w.tg.sent().filter((m) => m.text.includes('question')).length, 1, 'one of the two cards got through');
  assert.ok(w.logs.err.some((line) => line.includes('could not process card')));

  await bot.pollOnce();
  assert.equal(w.tg.sent().filter((m) => m.text.includes('question')).length, 2, 'the rejected card is retried');
  assert.equal(w.tg.sent().length, 5);
});

test('a card that cannot be refreshed does not stop the poll either', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Has a card', status: 'in_review' });
  const interaction = w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });
  const other = w.pc.addIssue({ title: 'Finishes', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.resolveElsewhere(interaction.id, 'accepted');
  w.pc.setStatus(other.id, 'done');
  w.pc.failRequests('GET', new RegExp(`/api/issues/${issue.id}/interactions$`), 503);

  await bot.pollOnce();
  assert.ok(w.tg.findMessage('Done'));
  assert.equal(bot.state.pendingCards().length, 1, 'the card stays pending and is checked again later');
  w.pc.clearFailures();
  await bot.pollOnce();
  assert.equal(bot.state.pendingCards().length, 0);
});

test('a done message goes out without the quote when the comments cannot be read', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Quiet finish', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.addComment(issue.id, { body: 'A comment that cannot be fetched.' });
  w.pc.setStatus(issue.id, 'done');
  w.pc.failRequests('GET', /\/comments$/, 500);
  await bot.pollOnce();
  const message = w.tg.findMessage('Done');
  assert.ok(message);
  assert.ok(!message.text.includes('<blockquote>'));
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
});

test('a Paperclip 401 on a single item still ends the poll so the token alert fires', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Needs an answer', status: 'in_review' });
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });
  w.pc.failRequests('GET', /\/interactions$/, 401);
  await assert.rejects(bot.pollOnce(), (err) => err.status === 401);
  assert.equal(w.tg.callsTo('sendMessage').length, 0);
});

test('a failing failed-run alert is retried on the next poll', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  w.pc.addFailedRun({ errorCode: 'adapter_failed' });
  w.tg.failNext('sendMessage', 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
  await bot.pollOnce();
  assert.equal(w.tg.sent().length, 0);
  await bot.pollOnce();
  assert.equal(w.tg.sent().length, 1);
  assert.match(w.tg.lastMessage().text, /Run failed/);
});

const REFUSED = { ok: false, error_code: 400, description: "Bad Request: can't parse entities" };
const mentions = (part) => (params) => params.text.includes(part);

test('a status message that is refused is tried on the next polls and given up after three tries', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const stuck = w.pc.addIssue({ title: 'Stuck update', status: 'in_progress' });
  const fine = w.pc.addIssue({ title: 'Fine update', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(stuck.id, 'done');
  w.pc.setStatus(fine.id, 'done');
  w.tg.failNext('sendMessage', 400, REFUSED, Infinity, mentions('Stuck update'));
  const attempts = () => w.tg.callsTo('sendMessage').filter((call) => call.params.text.includes('Stuck update')).length;

  const before = bot.state.lastPollAt;
  await bot.pollOnce();
  assert.ok(w.tg.findMessage('Fine update'), 'the other task was still reported');
  assert.ok(Date.parse(bot.state.lastPollAt) > Date.parse(before), 'the poll finished');
  assert.equal(bot.state.statuses.get(stuck.id), 'in_progress', 'the failed change is not recorded');
  assert.equal(attempts(), 1);

  await bot.pollOnce();
  assert.equal(attempts(), 2);
  assert.equal(bot.state.statuses.get(stuck.id), 'in_progress');
  assert.doesNotMatch(w.allLogText(), /gave up/);

  await bot.pollOnce();
  assert.equal(attempts(), 3);
  assert.equal(bot.state.statuses.get(stuck.id), 'done', 'recorded after the third failed try');
  assert.match(w.allLogText(), /warn gave up sending the done message of TST-1/);

  await bot.pollOnce();
  assert.equal(attempts(), 3, 'no fourth try');
  assert.equal(w.tg.sent().filter((m) => m.text.includes('Fine update')).length, 1);
});

test('a status message that was refused is sent by a later poll after it left the update window', async (t) => {
  const w = await world(t);
  let clock = Date.now();
  const bot = await w.primedBot({ now: () => clock });
  const issue = w.pc.addIssue({ title: 'Late update', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  w.tg.failNext('sendMessage', 400, REFUSED, 1, mentions('Late update'));

  clock += 3_600_000;
  await bot.pollOnce();
  assert.equal(w.tg.findMessage('Late update'), undefined);

  clock += 3_600_000;
  await bot.pollOnce();
  assert.ok(w.tg.findMessage('Late update'), 'the retry reads the task again');
  assert.equal(bot.state.statusRetries.size, 0);
  assert.equal(bot.state.statuses.get(issue.id), 'done');
});

test('a status retry whose task can no longer be read is given up after three tries', async (t) => {
  const w = await world(t);
  let clock = Date.now();
  const bot = await w.primedBot({ now: () => clock });
  const issue = w.pc.addIssue({ title: 'Unreadable update', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  w.tg.failNext('sendMessage', 400, REFUSED, 1, mentions('Unreadable update'));
  clock += 3_600_000;
  await bot.pollOnce();
  assert.equal(bot.state.statusRetries.get(issue.id).tries, 1);

  const reads = () => w.pc.requestsTo('GET', new RegExp(`/api/issues/${issue.id}$`)).length;
  w.pc.failRequests('GET', new RegExp(`/api/issues/${issue.id}$`), 500);
  const before = reads();
  for (let i = 0; i < 2; i += 1) {
    clock += 3_600_000;
    await bot.pollOnce();
  }
  assert.equal(reads() - before, 2);
  assert.equal(bot.state.statusRetries.size, 0, 'the retry ended');
  assert.equal(bot.state.statuses.get(issue.id), 'done');
  assert.match(w.allLogText(), /warn gave up sending the done message of /);

  clock += 3_600_000;
  await bot.pollOnce();
  assert.equal(reads() - before, 2, 'no further reads');
});

test('a Telegram outage while sending a status message keeps the change for the next poll', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Eventually done', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');

  w.tg.failNext('sendMessage', 500, { ok: false, error_code: 500, description: 'Internal Server Error' }, Infinity);
  const before = bot.state.lastPollAt;
  await assert.rejects(bot.pollOnce(), /500/);
  assert.equal(bot.state.lastPollAt, before, 'the window is read again');
  assert.equal(bot.state.statusRetries.size, 0, 'an outage does not count as a failed try');

  w.tg.clearFailures();
  await bot.pollOnce();
  assert.equal(w.tg.sent().filter((m) => m.text.includes('Eventually done')).length, 1);
});
