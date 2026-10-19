import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateTelegramHtml } from './fakes/telegram.js';
import { confirmPayload, startWorld, UI_BASE_URL } from './helpers.js';

const sentTexts = (w) => w.tg.sent().map((m) => m.text);

async function world(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  return w;
}

test('done message quotes the trimmed last agent comment and links to the task', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Write the docs', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.pollOnce();

  const body = ['line 1 <b>&</b>', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6 is cut'].join('\n');
  w.pc.addComment(issue.id, { body, authorType: 'agent' });
  w.pc.addComment(issue.id, { body: 'thanks, looks good', authorType: 'user' });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  const message = w.tg.findMessage('Done');
  assert.ok(message, 'a done message was sent');
  assert.match(message.text, /^✅ <b>Done<\/b> · <b>TST-1<\/b> Write the docs\n/);
  assert.match(message.text, /<blockquote>line 1 &lt;b&gt;&amp;&lt;\/b&gt;\nline 2\nline 3\nline 4\nline 5…<\/blockquote>/);
  assert.ok(!message.text.includes('line 6'));
  assert.ok(!message.text.includes('thanks'));
  assert.ok(message.text.includes(`<a href="${UI_BASE_URL}/TST/issues/TST-1">Open in Paperclip</a>`));
});

test('a long comment is cut to 400 characters', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Long report', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.addComment(issue.id, { body: 'x'.repeat(1000) });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  const quote = /<blockquote>(.*)<\/blockquote>/s.exec(w.tg.findMessage('Done').text)[1];
  assert.equal(Array.from(quote).length, 400);
  assert.ok(quote.endsWith('…'));
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
  assert.match(message.text, /^👀 <b>In review<\/b> · <b>TST-1<\/b> Needs a look/);
  assert.match(message.text, /Ready for review\./);
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
  assert.deepEqual(sentTexts(w), ['9 done, 3 in review while the bot was offline, see /status']);
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
  const alerts = sentTexts(w).filter((text) => text.includes('Run failed'));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /^⚠️ <b>Run failed<\/b> · Dev\n<b>TST-1<\/b> Flaky job\nadapter_failed — The adapter exited\n/);
  assert.ok(!alerts[0].includes('second line'));
  assert.ok(alerts[0].includes(`<a href="${UI_BASE_URL}/TST/agents/agent-1/runs/${failed.id}">Open run</a>`));
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
});

test('a failed run that has no task still alerts', async (t) => {
  const w = await world(t);
  const bot = await w.primedBot();
  w.pc.addFailedRun({ agentId: 'agent-1', errorCode: 'timeout', error: 'took too long' });
  await bot.pollOnce();
  assert.match(w.tg.findMessage('Run failed').text, /timeout — took too long/);
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
  assert.ok(message.text.includes('Open in Paperclip'));
});
