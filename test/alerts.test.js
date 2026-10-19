import assert from 'node:assert/strict';
import test from 'node:test';
import { isAlertKind, unexpectedLoud } from './alerts.js';
import { startFakeTelegram } from './fakes/telegram.js';
import { confirmPayload, startWorld } from './helpers.js';
import { PaperclipError } from '../src/paperclip.js';

const GROUP_ID = -1001234567890;
const FORUM = { telegram: { chatId: GROUP_ID, forum: true }, config: { topics: 'auto' } };

async function setup(t, world) {
  const w = await startWorld(world);
  t.after(() => w.close());
  return { w, bot: await w.primedBot() };
}

// A task the bot has seen in progress, so later changes are news.
async function seenTask(w, bot, fields = {}) {
  const issue = w.pc.addIssue({ title: 'Ship the release', status: 'in_progress', assigneeAgentId: 'agent-1', ...fields });
  await bot.pollOnce();
  return issue;
}

const sounds = (w, needle) => w.tg.sent().filter((m) => m.text.includes(needle)).map((m) => !m.silent);
const sendParams = (w) => w.tg.callsTo('sendMessage').map((call) => call.params);

test('the suite-wide check lets alert kinds through and names any other loud message', () => {
  const entry = (text, markup = null) => ({ text, markup });
  const alerts = [
    '<b>Question</b>\nDeploy the change?',
    '<b>Question</b> · <a href="https://example.com/x">TST-1</a> Title\nDeploy?',
    '<b>Approval</b> · <a href="https://example.com/x">TST-1</a> Staffing',
    '<b><a href="https://example.com/x">Approval</a></b> · Request 1',
    '<b>Decision</b> · TST-1 Title',
    '<b>Blocked</b> · TST-1 Title',
    '<b>Recovery</b> · TST-1 Title',
    '<b><a href="https://example.com/x">Join request</a></b> · Helper',
    '<b><a href="https://example.com/x">Run failed</a></b> · Dev',
    '<b>Done</b>',
    'Paperclip token rejected: create a new board key',
  ];
  for (const text of alerts) assert.ok(isAlertKind(entry(text)), text);

  const stalled = { inline_keyboard: [[{ text: 'Approve' }, { text: 'Request changes' }]] };
  assert.ok(isAlertKind(entry('<b>Review</b> · TST-1 Title', stalled)));
  assert.ok(!isAlertKind(entry('<b>Review</b> · TST-1 Title', { inline_keyboard: [[{ text: 'Open task' }]] })));

  const loud = [entry('<b>Dev</b> · TST-1 Title\nquote'), entry('<b>Done</b>'), entry('<b>In review</b>'), entry('Usage: /task &lt;ID&gt;\nsecond line')];
  assert.deepEqual(unexpectedLoud(loud), ['<b>Dev</b> · TST-1 Title', '<b>In review</b>', 'Usage: /task &lt;ID&gt;']);
});

test('the fake records which messages were sent without disable_notification', async (t) => {
  const tg = await startFakeTelegram({ chatId: 1001 });
  t.after(() => tg.close());
  const send = (params) =>
    fetch(`${tg.url}/bot${tg.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: 1001, ...params }) });
  await send({ text: 'quiet', disable_notification: true });
  await send({ text: 'loud' });
  await send({ text: 'also loud', disable_notification: false });

  assert.deepEqual(tg.sent().map((m) => [m.text, m.silent]), [['quiet', true], ['loud', false], ['also loud', false]]);
  assert.deepEqual(tg.loudSends().map((entry) => entry.text), ['loud', 'also loud']);
});

test('closing the world fails when a message that is not an alert was sent with a sound', async () => {
  const w = await startWorld();
  const bot = await w.primedBot();
  await bot.send('A plain note that should not make a sound', { alert: true });
  await assert.rejects(w.close(), /should be silent:\nA plain note that should not make a sound/);
});

test('a message is silent unless it is sent as an alert', async (t) => {
  const { w, bot } = await setup(t);
  await bot.send('quiet');
  await bot.send('<b>Done</b>', { alert: true });
  const [quiet, loud] = sendParams(w);
  assert.equal(quiet.disable_notification, true);
  assert.equal(loud.disable_notification, undefined);
});

test('in a forum group the pinned view, In review and comments are silent; the card and Done make a sound', async (t) => {
  const { w, bot } = await setup(t, FORUM);
  const issue = await seenTask(w, bot, { title: 'Build the bot' });
  w.pc.addComment(issue.id, { body: 'Ready for review.' });
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });
  w.pc.addComment(issue.id, { body: 'Waiting for your answer.' });
  await bot.pollOnce();
  w.pc.addComment(issue.id, { body: 'Merged.' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  const thread = bot.state.topics.get(issue.id).thread;
  const kinds = w.tg.inTopic(thread).map((m) => [m.text.split('\n')[0].replace(/<[^>]*>/g, ''), !m.silent]);
  assert.deepEqual(kinds, [
    ['TST-1 Build the bot', false],
    ['In review', false],
    ['Question', true],
    ['Dev', false],
    ['Dev', false],
    ['Done', true],
  ]);
  assert.deepEqual(w.tg.messages.get(w.tg.inTopic(thread)[0].message_id).pinned, { silent: true });
});

test('in the main chat a followed comment and an In review message are silent; Done makes a sound', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await seenTask(w, bot);
  await bot.handleUpdate(w.tg.message('/task TST-1'));
  const view = w.tg.lastMessage();
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'More'));
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Follow'));
  assert.equal(view.silent, true, 'the task view is a reply to a command');

  w.pc.addComment(issue.id, { body: 'A followed comment' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  assert.deepEqual(sounds(w, 'A followed comment'), [false], 'the comment is said once');
  assert.deepEqual(sounds(w, 'In review'), [false]);
  assert.deepEqual(sounds(w, '<b>Done</b>'), [true]);
});

test('a finished top-level task makes a sound and a finished subtask does not', async (t) => {
  const { w, bot } = await setup(t);
  const parent = w.pc.addIssue({ title: 'Parent work', status: 'in_progress' });
  const child = w.pc.addIssue({ title: 'Child work', status: 'in_progress', parentId: parent.id });
  await bot.pollOnce();
  w.pc.setStatus(child.id, 'done');
  w.pc.setStatus(parent.id, 'done');
  await bot.pollOnce();

  assert.deepEqual(sounds(w, 'Parent work'), [true]);
  assert.deepEqual(sounds(w, 'Child work'), [false]);
});

test('in a forum group the subtask Done in the parent topic is silent and the parent Done makes a sound', async (t) => {
  const { w, bot } = await setup(t, FORUM);
  const parent = w.pc.addIssue({ title: 'Parent work', status: 'in_progress' });
  const child = w.pc.addIssue({ title: 'Child work', status: 'in_progress', parentId: parent.id });
  await bot.pollOnce();
  w.pc.setStatus(child.id, 'done');
  await bot.pollOnce();
  w.pc.setStatus(parent.id, 'done');
  await bot.pollOnce();

  const thread = bot.state.topics.get(parent.id).thread;
  const done = w.tg.inTopic(thread).filter((m) => m.text.includes('Done'));
  assert.equal(done.length, 2);
  assert.ok(done[0].text.includes('Child work'));
  assert.equal(done[0].silent, true);
  assert.equal(done[1].text, '<b>Done</b>');
  assert.equal(done[1].silent, false);
});

// The sound setting of every try to send a message that holds `needle`, the refused ones included.
const triesFor = (w, needle) => sendParams(w).filter((p) => p.text.includes(needle)).map((p) => p.disable_notification === true);

test('a message sent again after its topic was deleted keeps its sound', async (t) => {
  const { w, bot } = await setup(t, FORUM);
  const issue = await seenTask(w, bot);
  w.pc.addComment(issue.id, { body: 'First note' });
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  w.tg.deleteTopic(bot.state.topics.get(issue.id).thread);
  w.pc.addComment(issue.id, { body: 'Second note' });
  await bot.pollOnce();
  w.tg.deleteTopic(bot.state.topics.get(issue.id).thread);
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  assert.equal(w.tg.callsTo('createForumTopic').length, 3);
  const note = triesFor(w, 'Second note');
  assert.ok(note.length >= 2 && note.every(Boolean), 'the refused try and the resend are silent');
  const done = triesFor(w, '<b>Done</b>');
  assert.ok(done.length >= 2 && done.every((silent) => !silent), 'the refused try and the resend make a sound');
});

test('a message that falls back to the main chat keeps its sound', async (t) => {
  const { w, bot } = await setup(t, FORUM);
  const issue = await seenTask(w, bot);
  w.pc.addComment(issue.id, { body: 'Opening note' });
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  w.tg.failNext('sendMessage', 400, { ok: false, error_code: 400, description: 'Bad Request: TOPIC_CLOSED' }, Infinity, (params) => params.message_thread_id !== undefined);
  w.pc.addComment(issue.id, { body: 'Closing note' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  const note = w.tg.sent().find((m) => m.text.includes('Closing note'));
  const done = w.tg.sent().find((m) => m.text.startsWith('<b>Done</b>'));
  assert.equal(note?.thread, null, 'the note reached the main chat');
  assert.equal(done?.thread, null, 'Done reached the main chat');
  assert.equal(note.silent, true);
  assert.equal(done.silent, false);
});

test('a card, an approval and the items that need the owner make a sound', async (t) => {
  const { w, bot } = await setup(t);
  const card = w.pc.addIssue({ title: 'Has a question', status: 'in_review' });
  w.pc.addInteraction(card.id, { kind: 'request_confirmation', payload: confirmPayload() });
  w.pc.addApproval({ type: 'hire_agent', payload: { title: 'Hire a designer' } });
  w.pc.addDecision({ issueId: card.id });
  const blocked = w.pc.addIssue({ title: 'Needs a key', status: 'blocked' });
  w.pc.addBlocker(blocked.id);
  const stranded = w.pc.addIssue({ title: 'Went quiet', status: 'in_progress' });
  w.pc.addRecovery(stranded.id);
  w.pc.addJoinRequest({ name: 'Helper' });
  await bot.pollOnce();

  for (const head of ['<b>Question</b>', '<b>Approval</b>', '<b>Decision</b>', '<b>Blocked</b>', '<b>Recovery</b>', '<b>Join request</b>']) {
    const found = w.tg.sent().filter((m) => m.text.replace(/<a href="[^"]*">|<\/a>/g, '').startsWith(head));
    assert.equal(found.length, 1, head);
    assert.equal(found[0].silent, false, head);
  }
});

test('a stalled review makes a sound and a review that is not stalled does not', async (t) => {
  const { w, bot } = await setup(t);
  bot.state.settings.inReview = false;
  const stalled = await seenTask(w, bot, { title: 'Stuck in review' });
  const plain = await seenTask(w, bot, { title: 'Look at this', assigneeUserId: 'board-user-1' });
  w.pc.setStatus(stalled.id, 'in_review');
  w.pc.addReview(stalled.id, { stalled: true });
  w.pc.setStatus(plain.id, 'in_review');
  w.pc.addReview(plain.id);
  await bot.pollOnce();

  assert.deepEqual(sounds(w, 'Stuck in review'), [true]);
  assert.deepEqual(sounds(w, 'Look at this'), [false]);
});

test('a failed run makes a sound, with or without a task', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await seenTask(w, bot, { title: 'Flaky job' });
  w.pc.addFailedRun({ issueId: issue.id, errorCode: 'adapter_failed', error: 'The adapter exited' });
  w.pc.addFailedRun({ agentId: 'agent-1', errorCode: 'timeout', error: 'took too long' });
  await bot.pollOnce();

  const alerts = w.tg.sent().filter((m) => m.text.includes('Run failed'));
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((m) => m.silent), [false, false]);
});

test('the rejected-token alert makes a sound', async (t) => {
  const { w, bot } = await setup(t);
  assert.equal(await bot.paperclipFailed(new PaperclipError('GET', '/x', { status: 401 })), true);
  assert.equal(w.tg.findMessage('Paperclip token rejected').silent, false);
});

test('command replies, lists, settings and the first-start summary are silent', async (t) => {
  const w = await startWorld();
  t.after(() => w.close());
  for (let i = 0; i < 12; i += 1) w.pc.addApproval({ payload: { title: `Request ${i}` } });
  const bot = w.makeBot();
  await bot.pollOnce();
  const items = w.tg.sent().filter((m) => m.text.startsWith('<b>'));
  assert.equal(items.length, 10);
  assert.ok(items.every((m) => !m.silent));
  assert.equal(w.tg.findMessage('+2 more, see /status').silent, true);

  const issue = w.pc.addIssue({ title: 'Plan the launch', status: 'todo' });
  await bot.pollOnce();
  const before = w.tg.sent().length;
  for (const text of ['/help', '/tasks', '/status', '/settings', '/following', '/agents', '/projects', '/find launch', '/task TST-1', '/new Another task', '/task nope']) {
    await bot.handleUpdate(w.tg.message(text));
  }
  await bot.handleUpdate(w.tg.message('A plain comment', { replyTo: w.tg.lastMessage().message_id }));
  const replies = w.tg.sent().slice(before);
  assert.ok(replies.length >= 10, `${replies.length} replies`);
  assert.ok(replies.every((m) => m.silent), replies.filter((m) => !m.silent).map((m) => m.text.split('\n')[0]).join(', '));
});
