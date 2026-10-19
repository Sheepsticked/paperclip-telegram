import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTelegramHtml } from './fakes/telegram.js';
import { mentioned } from './alerts.js';
import { UI_BASE_URL, confirmPayload, outcomePattern, startWorld, waitFor } from './helpers.js';

async function setup(t, options, botOptions) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const bot = await w.primedBot(botOptions);
  return { w, bot };
}

const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const posts = (w, suffix) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));
// Line 1 without its link markup, so a test can name the item by its words.
const plain = (text) => text.replace(/<a href="[^"]*">|<\/a>/g, '');
const startsWith = (w, head) => w.tg.sent().find((m) => plain(m.text).startsWith(head));
// Button labels per row, with the style of each styled button in brackets.
const styledRows = (w, id) =>
  (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => (b.style ? `${b.text} [${b.style}]` : b.text)));
const tap = (w, bot, message, label, options) => bot.handleUpdate(w.tg.tapButton(message.message_id, label, options));

// A task that has already been seen in progress, so a later status change counts as new.
async function seenTask(w, bot, fields = {}) {
  const issue = w.pc.addIssue({ title: 'Ship the release', status: 'in_progress', ...fields });
  await bot.pollOnce();
  return issue;
}

test('an approval shows its type, requester and payload, with Approve, Reject and the task button', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Staffing', status: 'in_progress' });
  const approval = w.pc.addApproval({
    type: 'hire_agent',
    issueId: issue.id,
    payload: { title: 'Hire a designer', role: 'Designer', budget: 500, tags: ['ui', 'brand'], notes: 'Needs <b>care</b> & speed' },
  });
  await bot.pollOnce();

  const message = startsWith(w, '<b>Approval</b>');
  assert.ok(message);
  assert.equal(validateTelegramHtml(message.text), null);
  const lines = message.text.split('\n');
  assert.equal(lines[0], `<b>Approval</b> · <a href="${UI_BASE_URL}/TST/approvals/${approval.id}">TST-1</a> Staffing`);
  assert.ok(lines.includes('Approval is pending a board decision.'));
  assert.ok(lines.includes('Type: Hire agent'));
  assert.ok(lines.includes('Requested by: Dev'));
  assert.ok(lines.includes('title: Hire a designer'));
  assert.ok(lines.includes('role: Designer'));
  assert.ok(lines.includes('budget: 500'));
  assert.ok(lines.includes('tags: ui, brand'));
  assert.ok(lines.includes('notes: Needs &lt;b&gt;care&lt;/b&gt; &amp; speed'));
  assert.ok(!message.text.includes('Open in Paperclip'));
  assert.deepEqual(rowsOf(w, message.message_id), [['Approve', 'Reject'], ['Open task']]);
  assert.equal(w.tg.buttons(message.message_id).at(-1).callback_data, `T:v:${issue.id}`);
  assert.equal(w.tg.callsTo('sendMessage').length, 1, 'one message for one item');
});

test('an approval payload is cut to 800 characters', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addApproval({ payload: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, 'v'.repeat(120)])) });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  assert.ok(message);
  const payload = message.text.split('\n').filter((line) => /^field\d+:/.test(line));
  assert.ok(payload.length > 0 && payload.length < 30);
  assert.ok(payload.join('\n').length <= 800);
  assert.equal(validateTelegramHtml(message.text), null);
});

test('Approve needs a second tap, then posts an empty body and edits the message', async (t) => {
  const { w, bot } = await setup(t);
  const approval = w.pc.addApproval({ type: 'hire_agent', payload: { title: 'Hire' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  assert.deepEqual(rowsOf(w, message.message_id), [['Approve', 'Reject']]);

  await tap(w, bot, message, 'Approve');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Tap again to confirm');
  assert.deepEqual(rowsOf(w, message.message_id), [['Tap again to confirm', 'Reject']]);
  assert.equal(posts(w, '/approve').length, 0);
  assert.equal(w.pc.approvals.get(approval.id).status, 'pending');

  await tap(w, bot, message, 'Tap again to confirm');
  assert.equal(posts(w, '/approve').length, 1);
  assert.equal(posts(w, '/approve')[0].path, `/api/approvals/${approval.id}/approve`);
  assert.deepEqual(posts(w, '/approve')[0].body, {});
  assert.equal(w.pc.approvals.get(approval.id).status, 'approved');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Approved');
  assert.deepEqual(rowsOf(w, message.message_id), []);
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Approved'));
});

test('Reject needs a second tap, then posts an empty body', async (t) => {
  const { w, bot } = await setup(t);
  const approval = w.pc.addApproval({ type: 'budget_override_required', payload: { title: 'More budget' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');

  await tap(w, bot, message, 'Reject');
  assert.equal(posts(w, '/reject').length, 0);
  // Tapping the other button moves the confirmation to it instead of acting.
  await tap(w, bot, message, 'Approve');
  assert.equal(posts(w, '/approve').length, 0);
  assert.deepEqual(rowsOf(w, message.message_id), [['Tap again to confirm', 'Reject']]);
  await tap(w, bot, message, 'Reject');
  assert.equal(posts(w, '/reject').length, 0);
  await tap(w, bot, message, 'Tap again to confirm');

  assert.equal(posts(w, '/reject').length, 1);
  assert.equal(posts(w, '/reject')[0].path, `/api/approvals/${approval.id}/reject`);
  assert.deepEqual(posts(w, '/reject')[0].body, {});
  assert.equal(w.pc.approvals.get(approval.id).status, 'rejected');
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Rejected'));
  assert.deepEqual(rowsOf(w, message.message_id), []);
});

test('an armed approval button goes back to normal when the window ends', async (t) => {
  const { w, bot } = await setup(t, undefined, { confirmMs: 300 });
  w.pc.addApproval({ payload: { title: 'Hire' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  await tap(w, bot, message, 'Approve');
  assert.deepEqual(rowsOf(w, message.message_id), [['Tap again to confirm', 'Reject']]);
  await waitFor(() => rowsOf(w, message.message_id)[0][0] === 'Approve', { label: 'button reset' });

  // A tap after the window arms the button again instead of approving.
  await tap(w, bot, message, 'Approve');
  assert.equal(posts(w, '/approve').length, 0);
  assert.deepEqual(rowsOf(w, message.message_id), [['Tap again to confirm', 'Reject']]);
});

test('an approval that cannot be answered inline shows text and a link only', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Board matter', status: 'in_progress' });
  const approval = w.pc.addApproval({ type: 'request_board_approval', issueId: issue.id, payload: { title: 'Sign off the plan' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  assert.ok(message.text.includes('Type: Board approval'));
  assert.ok(message.text.includes('Answer this one in Paperclip'));
  assert.ok(message.text.includes(`<a href="${UI_BASE_URL}/TST/approvals/${approval.id}">TST-1</a>`), 'the task id links to the approval');
  assert.ok(!message.text.includes('Open in Paperclip'));
  assert.deepEqual(rowsOf(w, message.message_id), [['Open task']]);
});

test('a decision shows its body and one button per option, and a tap decides it', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Pick a stack', status: 'in_progress' });
  const decision = w.pc.addDecision({
    issueId: issue.id,
    title: 'Database choice',
    body: 'Which database should we use?',
    options: [
      { id: 'pg', label: 'Postgres', description: 'Reliable and boring', effects: [] },
      { id: 'lite', label: 'SQLite', effects: [] },
    ],
  });
  await bot.pollOnce();

  const message = startsWith(w, '<b>Decision</b>');
  assert.ok(message);
  assert.equal(validateTelegramHtml(message.text), null);
  assert.ok(
    message.text.startsWith(`<b>Decision</b> · <a href="${UI_BASE_URL}/TST/decisions?decisionId=${decision.id}">TST-1</a> Pick a stack\n<b>Database choice</b>\n`),
  );
  assert.ok(message.text.includes('Which database should we use?'));
  assert.ok(message.text.includes('- Postgres: Reliable and boring'));
  assert.ok(!message.text.includes('Open in Paperclip'));
  assert.deepEqual(rowsOf(w, message.message_id), [['Postgres'], ['SQLite'], ['Dismiss'], ['Open task']]);

  await tap(w, bot, message, 'SQLite');
  const decides = posts(w, '/decide');
  assert.equal(decides.length, 1);
  assert.equal(decides[0].path, `/api/decisions/${decision.id}/decide`);
  assert.deepEqual(decides[0].body, { optionId: 'lite', idempotencyKey: `telegram-decision-${decision.id}` });
  assert.equal(w.pc.decisions.get(decision.id).chosenOptionId, 'lite');
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Decided', 'SQLite'));
  assert.deepEqual(rowsOf(w, message.message_id), []);
});

test('a decision body is cut to 800 characters', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Long choice', status: 'in_progress' });
  w.pc.addDecision({ issueId: issue.id, body: `Start ${'word '.repeat(400)}END` });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Decision</b>');
  assert.ok(message.text.includes('Start word'));
  assert.ok(!message.text.includes('END'));
  assert.equal(validateTelegramHtml(message.text), null);
});

test('a decision that needs input has no option buttons and points to Paperclip', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Needs details', status: 'in_progress' });
  const decision = w.pc.addDecision({
    issueId: issue.id,
    options: [{ id: 'go', label: 'Go ahead', effects: [] }, { id: 'hold', label: 'Hold', effects: [] }],
    inputs: [{ id: 'reason', label: 'Reason', type: 'text', required: true }],
  });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Decision</b>');
  assert.ok(message.text.includes('More options in Paperclip'));
  assert.ok(message.text.includes('- Go ahead'));
  assert.ok(!message.text.includes('Open in Paperclip'));
  assert.deepEqual(rowsOf(w, message.message_id), [['Open task']], 'Dismiss would decide the first option, which needs the input');

  // Hand-made option and dismiss taps are refused without calling Paperclip.
  const key = [...bot.state.inbox.keys()][0];
  await bot.handleUpdate(w.tg.tap(message.message_id, `I:o:${key}:0`));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await bot.handleUpdate(w.tg.tap(message.message_id, `I:x:${key}`));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  assert.equal(posts(w, '/decide').length, 0);
  assert.equal(posts(w, '/dismiss').length, 0);
  assert.equal(w.pc.decisions.get(decision.id).status, 'open');
});

test('the server refuses a dismiss while a required input is empty, as the fake does', async (t) => {
  const { w } = await setup(t);
  const decision = w.pc.addDecision({ issueId: null, inputs: [{ id: 'reason', label: 'Reason', type: 'text', required: true }] });
  const response = await fetch(`${w.pc.url}/api/decisions/${decision.id}/dismiss`, {
    method: 'POST',
    headers: { authorization: `Bearer ${w.tokens.paperclip}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 422);
  assert.equal(w.pc.decisions.get(decision.id).status, 'open');
});

test('Dismiss on a decision posts an empty body', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Not needed', status: 'in_progress' });
  const decision = w.pc.addDecision({ issueId: issue.id });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Decision</b>');
  await tap(w, bot, message, 'Dismiss');
  assert.equal(posts(w, '/dismiss').length, 1);
  assert.equal(posts(w, '/dismiss')[0].path, `/api/decisions/${decision.id}/dismiss`);
  assert.deepEqual(posts(w, '/dismiss')[0].body, {});
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Dismissed'));
  assert.deepEqual(rowsOf(w, message.message_id), []);
});

test('a destructive decision option needs a second tap', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Risky', status: 'in_progress' });
  w.pc.addDecision({ issueId: issue.id, options: [{ id: 'wipe', label: 'Wipe it', style: 'destructive', effects: [] }, { id: 'keep', label: 'Keep it', effects: [] }] });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Decision</b>');
  await tap(w, bot, message, 'Wipe it');
  assert.equal(posts(w, '/decide').length, 0);
  assert.deepEqual(rowsOf(w, message.message_id)[0], ['Tap again to confirm']);
  await tap(w, bot, message, 'Tap again to confirm');
  assert.equal(posts(w, '/decide')[0].body.optionId, 'wipe');
});

// A review that is in review and needs the owner's decision; the task was seen in progress first.
async function stalledReview(w, bot) {
  const issue = await seenTask(w, bot, { title: 'Stuck in review' });
  w.pc.setStatus(issue.id, 'in_review');
  w.pc.addReview(issue.id, { stalled: true });
  await bot.pollOnce();
  return { issue, message: startsWith(w, '<b>Review</b>') };
}

test('a stalled review offers Approve, Request changes and Send back', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, message } = await stalledReview(w, bot);
  assert.ok(message);
  assert.ok(message.text.startsWith(`<b>Review</b> · <a href="${UI_BASE_URL}/TST/issues/TST-1">TST-1</a> Stuck in review\n`));
  assert.ok(message.text.includes('Issue is in review without a maintained reviewer'));
  assert.ok(!message.text.includes('Open in Paperclip'));
  assert.deepEqual(rowsOf(w, message.message_id), [['Approve', 'Request changes', 'Send back'], ['Open task']]);
  assert.equal(w.tg.buttons(message.message_id).at(-1).callback_data, `T:v:${issue.id}`);
});

test('Approve on a stalled review posts the approve action', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, message } = await stalledReview(w, bot);
  await tap(w, bot, message, 'Approve');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Tap again to confirm');
  assert.deepEqual(rowsOf(w, message.message_id)[0], ['Tap again to confirm', 'Request changes', 'Send back']);
  assert.equal(posts(w, '/stalled-review-decision').length, 0);
  assert.equal(w.pc.issues.get(issue.id).status, 'in_review');
  await tap(w, bot, message, 'Tap again to confirm');
  const calls = posts(w, '/stalled-review-decision');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/issues/${issue.id}/stalled-review-decision`);
  assert.deepEqual(calls[0].body, { action: 'approve' });
  assert.equal(w.pc.issues.get(issue.id).status, 'done');
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Approved'));
  assert.deepEqual(rowsOf(w, message.message_id), []);
});

test('Send back on a stalled review posts the send_back action', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, message } = await stalledReview(w, bot);
  await tap(w, bot, message, 'Send back');
  assert.deepEqual(rowsOf(w, message.message_id)[0], ['Approve', 'Request changes', 'Tap again to confirm']);
  assert.equal(posts(w, '/stalled-review-decision').length, 0);
  await tap(w, bot, message, 'Tap again to confirm');
  assert.deepEqual(posts(w, '/stalled-review-decision')[0].body, { action: 'send_back' });
  assert.equal(w.pc.issues.get(issue.id).status, 'todo');
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Sent back'));
});

test('Request changes asks for a note and the reply becomes the note', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, message } = await stalledReview(w, bot);

  await tap(w, bot, message, 'Request changes');
  assert.equal(posts(w, '/stalled-review-decision').length, 0);
  const prompt = w.tg.lastMessage();
  assert.ok(prompt.text.includes('Reply to this message with your note'));
  assert.equal(prompt.replyTo, message.message_id);
  assert.equal(prompt.markup.force_reply, true);
  assert.ok(w.tg.messages.get(message.message_id).text.includes('Waiting for the note'));

  // A second tap does not ask again.
  await tap(w, bot, message, 'Request changes');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Reply to the note prompt first');
  assert.equal(w.tg.sent().filter((m) => m.text.includes('Reply to this message')).length, 1);

  await bot.handleUpdate(w.tg.message('Please add a test for the edge case', { replyTo: prompt.message_id }));
  const calls = posts(w, '/stalled-review-decision');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { action: 'request_changes', note: 'Please add a test for the edge case' });
  assert.equal(w.pc.issues.get(issue.id).status, 'todo');
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Changes requested'));
  assert.ok(!w.tg.messages.get(message.message_id).text.includes('Waiting for the note'));
  assert.deepEqual(rowsOf(w, message.message_id), []);
  assert.equal(w.pc.comments.filter((c) => c.body === 'Please add a test for the edge case').length, 1);
});

test('a reply without text to the note prompt is declined and the prompt stays', async (t) => {
  const { w, bot } = await setup(t);
  const { message } = await stalledReview(w, bot);
  await tap(w, bot, message, 'Request changes');
  const prompt = w.tg.lastMessage();
  await bot.handleUpdate(w.tg.message(undefined, { replyTo: prompt.message_id, extra: { sticker: { file_id: 'x' } } }));
  assert.equal(w.tg.lastMessage().text, 'Only text replies are supported');
  assert.equal(posts(w, '/stalled-review-decision').length, 0);
  await bot.handleUpdate(w.tg.message('Tighten the error handling', { replyTo: prompt.message_id }));
  assert.equal(posts(w, '/stalled-review-decision').length, 1);
});

test('a review that is no longer stalled is reported as resolved', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, message } = await stalledReview(w, bot);
  await tap(w, bot, message, 'Approve');
  w.pc.setStatus(issue.id, 'done');
  await tap(w, bot, message, 'Tap again to confirm');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already resolved');
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Resolved in Paperclip'));
  assert.deepEqual(rowsOf(w, message.message_id), []);
});

test('a review that is not stalled gets text, a link and the task button only, even with in-review messages off', async (t) => {
  const { w, bot } = await setup(t);
  bot.state.settings.inReview = false;
  const issue = await seenTask(w, bot, { title: 'Look at this', assigneeUserId: 'board-user-1' });
  w.pc.setStatus(issue.id, 'in_review');
  w.pc.addReview(issue.id);
  await bot.pollOnce();
  assert.equal(startsWith(w, '<b>In review</b>'), undefined);

  const message = startsWith(w, '<b>Review</b>');
  assert.ok(message);
  assert.equal(message.text.split('\n')[0], `<b>Review</b> · <a href="${UI_BASE_URL}/TST/issues/TST-1">TST-1</a> Look at this`);
  assert.ok(message.text.includes('Issue is in review and assigned to a user.'));
  assert.ok(!message.text.includes('Open in Paperclip'));
  assert.deepEqual(rowsOf(w, message.message_id), [['Open task']]);
});

test('a review is left out when an earlier poll sent the in-review message for its task', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await seenTask(w, bot, { title: 'Look at this', assigneeUserId: 'board-user-1' });
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  assert.ok(startsWith(w, '<b>In review</b>'), 'the status message comes first, from an earlier poll');
  w.pc.addReview(issue.id);
  await bot.pollOnce();
  assert.equal(startsWith(w, '<b>Review</b>'), undefined);
  const count = w.tg.callsTo('sendMessage').length;
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, count, 'and not on a later poll either');
  assert.ok(bot.state.reviewSent.has(issue.id));
});

test('the memory of an in-review message ends when the task leaves review', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await seenTask(w, bot, { title: 'Back and forth', assigneeUserId: 'board-user-1' });
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  assert.ok(bot.state.reviewSent.has(issue.id));
  w.pc.setStatus(issue.id, 'in_progress');
  await bot.pollOnce();
  assert.ok(!bot.state.reviewSent.has(issue.id));

  bot.state.settings.inReview = false;
  w.pc.setStatus(issue.id, 'in_review');
  w.pc.addReview(issue.id);
  await bot.pollOnce();
  assert.ok(startsWith(w, '<b>Review</b>'), 'this time no in-review message covered it');
});

test('a review is left out when the same poll sent an in-review message for its task', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await seenTask(w, bot, { title: 'Look at this', assigneeUserId: 'board-user-1' });
  w.pc.setStatus(issue.id, 'in_review');
  w.pc.addReview(issue.id);
  await bot.pollOnce();
  assert.ok(startsWith(w, '<b>In review</b>'));
  assert.equal(startsWith(w, '<b>Review</b>'), undefined);
  const count = w.tg.callsTo('sendMessage').length;
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, count, 'it is not sent on a later poll either');
});

test('a review is left out when the same poll sent a card or an approval for its task', async (t) => {
  const { w, bot } = await setup(t);
  const withCard = w.pc.addIssue({ title: 'Has a card', status: 'in_review' });
  w.pc.addReview(withCard.id);
  w.pc.addInteraction(withCard.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'Ship it?' }) });
  const withApproval = w.pc.addIssue({ title: 'Has an approval', status: 'in_review' });
  w.pc.addReview(withApproval.id);
  w.pc.addApproval({ issueId: withApproval.id, payload: { title: 'Hire' } });
  await bot.pollOnce();
  assert.ok(w.tg.findMessage('Ship it?'));
  assert.ok(startsWith(w, '<b>Approval</b>'));
  assert.equal(startsWith(w, '<b>Review</b>'), undefined);
});

test('blocker, recovery and join request items are text with a link and no actions', async (t) => {
  const { w, bot } = await setup(t);
  const blocked = w.pc.addIssue({ title: 'Needs a key', status: 'blocked' });
  const stranded = w.pc.addIssue({ title: 'Went quiet', status: 'in_progress' });
  w.pc.addBlocker(blocked.id, { whyNow: 'Provide the missing access key.' });
  w.pc.addRecovery(stranded.id, { nextAction: 'Decide how to recover this task' });
  w.pc.addJoinRequest({ name: 'Helper <bot>' });
  await bot.pollOnce();

  const block = startsWith(w, '<b>Blocked</b>');
  assert.equal(block.text.split('\n')[0], `<b>Blocked</b> · <a href="${UI_BASE_URL}/TST/issues/TST-1">TST-1</a> Needs a key`);
  assert.ok(block.text.includes('Provide the missing access key.'));
  assert.deepEqual(rowsOf(w, block.message_id), [['Open task']]);

  const recovery = startsWith(w, '<b>Recovery</b>');
  assert.equal(recovery.text.split('\n')[0], `<b>Recovery</b> · <a href="${UI_BASE_URL}/TST/issues/TST-2">TST-2</a> Went quiet`);
  assert.ok(recovery.text.includes('Decide how to recover this task'));
  assert.ok(recovery.text.includes('Recovery action is assigned to a human owner.'));
  assert.deepEqual(rowsOf(w, recovery.message_id), [['Open task']]);

  const join = startsWith(w, '<b>Join request</b>');
  assert.equal(join.text.split('\n')[0], `<b>Join request</b> · <a href="${UI_BASE_URL}/TST/settings/access">Helper &lt;bot&gt;</a>`);
  assert.ok(join.text.includes('Join request is pending approval.'));
  assert.deepEqual(rowsOf(w, join.message_id), []);
  for (const message of [block, recovery, join]) {
    assert.equal(validateTelegramHtml(message.text), null);
    assert.ok(!message.text.includes('Open in Paperclip'));
  }
});

test('an item is sent once and not again on the next polls', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addApproval({ payload: { title: 'Hire' } });
  w.pc.addJoinRequest({});
  await bot.pollOnce();
  const count = w.tg.callsTo('sendMessage').length;
  await bot.pollOnce();
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, count);
});

test('an item that leaves the feed is edited to Resolved and loses its buttons', async (t) => {
  const { w, bot } = await setup(t);
  const approval = w.pc.addApproval({ payload: { title: 'Hire' } });
  const join = w.pc.addJoinRequest({});
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  const joinMessage = startsWith(w, '<b>Join request</b>');
  const buttonData = w.tg.buttons(message.message_id)[0].callback_data;

  w.pc.approvals.get(approval.id).status = 'approved';
  join.close();
  await bot.pollOnce();
  for (const sent of [message, joinMessage]) {
    assert.match(w.tg.messages.get(sent.message_id).text, outcomePattern('Resolved in Paperclip'));
    assert.deepEqual(rowsOf(w, sent.message_id), []);
  }
  const edits = w.tg.callsTo('editMessageText').length;
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('editMessageText').length, edits, 'resolved once');

  await bot.handleUpdate(w.tg.tap(message.message_id, buttonData));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already resolved');
  assert.equal(posts(w, '/approve').length, 0);
});

test('an item answered in Paperclip makes the tap say Already resolved', async (t) => {
  const { w, bot } = await setup(t);
  const approval = w.pc.addApproval({ payload: { title: 'Hire' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  w.pc.approvals.get(approval.id).status = 'rejected';

  await tap(w, bot, message, 'Approve');
  await tap(w, bot, message, 'Tap again to confirm');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already resolved');
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Resolved in Paperclip'));
  assert.deepEqual(rowsOf(w, message.message_id), []);
});

test('a decision decided elsewhere makes the option tap say Already resolved', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Choose', status: 'in_progress' });
  const decision = w.pc.addDecision({ issueId: issue.id });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Decision</b>');
  w.pc.decisions.get(decision.id).status = 'decided';
  await tap(w, bot, message, 'Go ahead');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already resolved');
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Resolved in Paperclip'));
});

test('an item dismissed in Paperclip counts as left the feed', async (t) => {
  const { w, bot } = await setup(t);
  const stranded = w.pc.addIssue({ title: 'Went quiet', status: 'in_progress' });
  w.pc.addRecovery(stranded.id, {});
  await bot.pollOnce();
  const message = startsWith(w, '<b>Recovery</b>');
  w.pc.dismissAttention([...bot.state.inbox.values()][0].dedupKey);
  await bot.pollOnce();
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Resolved in Paperclip'));
});

test('a walk of the feed that did not finish resolves nothing', async (t) => {
  const { w, bot } = await setup(t);
  const join = w.pc.addJoinRequest({});
  await bot.pollOnce();
  const message = startsWith(w, '<b>Join request</b>');
  join.close();

  const walk = bot.pc.attentionFeed.bind(bot.pc);
  bot.pc.attentionFeed = async (...args) => ({ ...(await walk(...args)), complete: false });
  await bot.pollOnce();
  assert.ok(!w.tg.messages.get(message.message_id).text.includes('Resolved'));
  assert.equal(w.tg.callsTo('editMessageText').length, 0);

  bot.pc.attentionFeed = walk;
  await bot.pollOnce();
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Resolved in Paperclip'));
});

test('a failed read of the feed resolves nothing and the next poll catches up', async (t) => {
  const { w, bot } = await setup(t);
  const join = w.pc.addJoinRequest({});
  await bot.pollOnce();
  const message = startsWith(w, '<b>Join request</b>');
  join.close();
  w.pc.failRequests('GET', /\/attention$/, 500, 1);
  await assert.rejects(bot.pollOnce());
  assert.ok(!w.tg.messages.get(message.message_id).text.includes('Resolved'));
  await bot.pollOnce();
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Resolved in Paperclip'));
});

test('inbox items arrive while muted and with every toggle off', async (t) => {
  const { w, bot } = await setup(t);
  for (const key of Object.keys(bot.state.settings)) bot.state.settings[key] = false;
  bot.state.mute(bot.now(), 8);
  const issue = w.pc.addIssue({ title: 'Blocked while muted', status: 'blocked' });
  w.pc.addApproval({ payload: { title: 'Hire' } });
  w.pc.addBlocker(issue.id, {});
  w.pc.addJoinRequest({});
  await bot.pollOnce();
  for (const head of ['<b>Approval</b>', '<b>Blocked</b>', '<b>Join request</b>']) assert.ok(startsWith(w, head), head);
  assert.ok(w.tg.buttons(startsWith(w, '<b>Approval</b>').message_id).length >= 2);
});

test('the first start sends at most ten items across all kinds and points to /status', async (t) => {
  const w = await startWorld();
  t.after(() => w.close());
  for (let i = 0; i < 4; i += 1) {
    const issue = w.pc.addIssue({ title: `Question ${i}`, status: 'in_review' });
    w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: `Prompt ${i}` }) });
    w.pc.addApproval({ payload: { title: `Approval ${i}` } });
    w.pc.addJoinRequest({ name: `Joiner ${i}` });
  }
  const bot = w.makeBot();
  await bot.pollOnce();
  const texts = w.tg.sent().map((m) => m.text);
  assert.equal(texts.length, 11);
  assert.equal(texts.at(-1), '+2 more, see /status');

  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 11, 'the skipped ones are not sent later');
  const restarted = w.makeBot();
  await restarted.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 11);

  await restarted.handleUpdate(w.tg.message('/status'));
  const status = w.tg.sent().slice(11);
  const waiting = status.find((m) => m.text.startsWith('<b>Waiting for you</b>'));
  assert.ok(waiting.text.startsWith('<b>Waiting for you</b> (12)'));
});

test('/status lists every inbox kind as a button that opens the task or sends the item again', async (t) => {
  const { w, bot } = await setup(t);
  const task = w.pc.addIssue({ title: 'Has a task', status: 'in_progress' });
  const decisionTask = w.pc.addIssue({ title: 'Choose one', status: 'in_progress' });
  const blocked = w.pc.addIssue({ title: 'Blocked one', status: 'blocked' });
  w.pc.addApproval({ issueId: task.id, payload: { title: 'Approve with a task' } });
  w.pc.addApproval({ payload: { title: 'Approve without a task' } });
  w.pc.addDecision({ issueId: decisionTask.id, title: 'Which one' });
  w.pc.addBlocker(blocked.id, {});
  w.pc.addJoinRequest({ name: 'Joiner' });
  await bot.pollOnce();

  await bot.handleUpdate(w.tg.message('/status'));
  const waiting = w.tg.sent().find((m) => m.text.startsWith('<b>Waiting for you</b>'));
  assert.ok(waiting.text.startsWith('<b>Waiting for you</b> (5)'));
  const buttons = w.tg.buttons(waiting.message_id);
  assert.deepEqual(buttons.map((b) => b.text).sort(), ['Approval · Approve with a task', 'Approval · Approve without a task', 'Join request · Joiner', 'TST-2 · Which one', 'TST-3 · Blocked one'].sort());
  assert.equal(buttons.find((b) => b.text === 'Approval · Approve with a task').callback_data, `T:v:${task.id}`);
  assert.equal(buttons.find((b) => b.text.startsWith('TST-2')).callback_data, `T:v:${decisionTask.id}`);

  const count = w.tg.callsTo('sendMessage').length;
  await tap(w, bot, waiting, 'Join request · Joiner');
  assert.equal(w.tg.callsTo('sendMessage').length, count + 1, 'the item message is sent again');
  assert.ok(plain(w.tg.lastMessage().text).startsWith('<b>Join request</b> · Joiner'));
  await tap(w, bot, waiting, 'Approval · Approve without a task');
  const resent = w.tg.lastMessage();
  assert.ok(plain(resent.text).startsWith('<b>Approval</b>'));
  assert.deepEqual(rowsOf(w, resent.message_id), [['Approve', 'Reject']]);

  await tap(w, bot, resent, 'Approve');
  await tap(w, bot, resent, 'Tap again to confirm');
  assert.equal(posts(w, '/approve').length, 1);
});

test('the button of an item that is gone says so and sends nothing', async (t) => {
  const { w, bot } = await setup(t);
  const approval = w.pc.addApproval({ payload: { title: 'No task' } });
  // Both items are listed in /status before the poll has sent them.
  await bot.handleUpdate(w.tg.message('/status'));
  const waiting = w.tg.sent().find((m) => m.text.startsWith('<b>Waiting for you</b>'));
  w.pc.approvals.get(approval.id).status = 'approved';
  const count = w.tg.callsTo('sendMessage').length;
  await tap(w, bot, waiting, 'Approval ·');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already resolved');
  assert.equal(w.tg.callsTo('sendMessage').length, count);
});

test('a tap on an unknown item key is answered without calling Paperclip', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addApproval({ payload: { title: 'Hire' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  const requests = w.pc.requests.length;
  await bot.handleUpdate(w.tg.tap(message.message_id, 'I:a:zzzz'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This item is no longer available');
  await bot.handleUpdate(w.tg.tap(message.message_id, 'I:q'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This item is no longer available');
  assert.equal(w.pc.requests.length, requests);
});

test('inbox buttons from another user or chat change nothing', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addApproval({ payload: { title: 'Hire' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  const requests = w.pc.requests.length;
  const answers = w.tg.callbackAnswers.length;
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Approve', { from: 2002 }));
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Approve', { chat: 9999 }));
  assert.equal(w.pc.requests.length, requests);
  assert.equal(w.tg.callbackAnswers.length, answers);
  assert.equal(bot.isArmed(message.message_id, 'a'), false);
});

test('the inbox keeps its messages across a restart', async (t) => {
  const { w, bot } = await setup(t);
  const approval = w.pc.addApproval({ payload: { title: 'Hire' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  const restarted = w.makeBot();
  await restarted.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
  await restarted.handleUpdate(w.tg.tapButton(message.message_id, 'Approve'));
  await restarted.handleUpdate(w.tg.tapButton(message.message_id, 'Tap again to confirm'));
  assert.equal(w.pc.approvals.get(approval.id).status, 'approved');
});

test('every inbox callback stays within 64 bytes', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Everything at once', status: 'in_progress' });
  w.pc.addApproval({ issueId: issue.id, payload: { title: 'Hire' } });
  w.pc.addDecision({ issueId: issue.id });
  w.pc.setStatus(issue.id, 'in_review');
  w.pc.addReview(issue.id, { stalled: true });
  w.pc.addJoinRequest({});
  await bot.pollOnce();
  let seen = 0;
  for (const message of w.tg.sent()) {
    for (const b of w.tg.buttons(message.message_id)) {
      seen += 1;
      assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
    }
  }
  assert.ok(seen >= 8);
});

const GROUP_ID = -1001234567890;

// A task that already has its topic, in a forum group.
async function topicSetup(t) {
  const w = await startWorld({ telegram: { chatId: GROUP_ID, forum: true } });
  t.after(() => w.close());
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Plan the launch', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  const { thread } = bot.state.topics.get(issue.id);
  return { w, bot, issue, thread };
}

test('an inbox item about a task goes into that task topic, and one without a task into the main chat', async (t) => {
  const { w, bot, issue, thread } = await topicSetup(t);
  w.pc.addApproval({ issueId: issue.id, payload: { title: 'Hire' } });
  w.pc.addJoinRequest({});
  await bot.pollOnce();

  const approval = startsWith(w, '<b>Approval</b>');
  assert.equal(approval.thread, thread);
  assert.equal(approval.text.split('\n')[0], mentioned('Approval', w.tg.userId), 'line 1 is the kind alone inside its own topic');
  assert.deepEqual(rowsOf(w, approval.message_id), [['Approve', 'Reject']], 'and there is no Open task button');
  const join = startsWith(w, '<b>Join request</b>');
  assert.equal(join.thread, null);

  await tap(w, bot, approval, 'Approve');
  await tap(w, bot, approval, 'Tap again to confirm');
  assert.equal(posts(w, '/approve').length, 1);
  assert.match(w.tg.messages.get(approval.message_id).text, outcomePattern('Approved'));
});

test('the note prompt of a stalled review is asked inside the topic of its task', async (t) => {
  const { w, bot, issue, thread } = await topicSetup(t);
  w.pc.addReview(issue.id, { stalled: true });
  await bot.pollOnce();
  const review = startsWith(w, '<b>Review</b>');
  assert.equal(review.thread, thread);

  await tap(w, bot, review, 'Request changes');
  const prompt = w.tg.lastMessage();
  assert.equal(prompt.thread, thread);
  assert.equal(prompt.markup.force_reply, true);
  await bot.handleUpdate(w.tg.message('Add the missing tests', { replyTo: prompt.message_id, thread }));
  assert.deepEqual(posts(w, '/stalled-review-decision')[0].body, { action: 'request_changes', note: 'Add the missing tests' });
  assert.equal(posts(w, '/comments').length, 0, 'the reply is the note, not a second comment');
});

test('an item sent again from /status lands in the topic it was asked from', async (t) => {
  const { w, bot, thread } = await topicSetup(t);
  w.pc.addJoinRequest({ name: 'Joiner' });
  await bot.pollOnce();
  await bot.handleUpdate(w.tg.message('/status', { thread }));
  const waiting = w.tg.sent().find((m) => m.text.startsWith('<b>Waiting for you</b>'));
  assert.equal(waiting.thread, thread);
  await tap(w, bot, waiting, 'Join request · Joiner');
  assert.equal(w.tg.lastMessage().thread, thread);
  assert.ok(plain(w.tg.lastMessage().text).startsWith('<b>Join request</b> · Joiner'));
});

test('Approve is success and Reject is danger, and an armed button keeps its colour', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addApproval({ payload: { title: 'Hire' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  assert.deepEqual(styledRows(w, message.message_id), [['Approve [success]', 'Reject [danger]']]);

  await tap(w, bot, message, 'Approve');
  assert.deepEqual(styledRows(w, message.message_id), [['Tap again to confirm [success]', 'Reject [danger]']]);
  await tap(w, bot, message, 'Reject');
  assert.deepEqual(styledRows(w, message.message_id), [['Approve [success]', 'Tap again to confirm [danger]']]);
});

test('on a stalled review only Approve is coloured', async (t) => {
  const { w, bot } = await setup(t);
  const { message } = await stalledReview(w, bot);
  assert.deepEqual(styledRows(w, message.message_id), [['Approve [success]', 'Request changes', 'Send back'], ['Open task']]);
  await tap(w, bot, message, 'Send back');
  assert.deepEqual(styledRows(w, message.message_id)[0], ['Approve [success]', 'Request changes', 'Tap again to confirm']);
});

test('decision options and Dismiss have no colour', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Pick a stack', status: 'in_progress' });
  w.pc.addDecision({
    issueId: issue.id,
    options: [{ id: 'pg', label: 'Postgres', effects: [] }, { id: 'wipe', label: 'Wipe it', style: 'destructive', effects: [] }],
  });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Decision</b>');
  assert.deepEqual(styledRows(w, message.message_id), [['Postgres'], ['Wipe it'], ['Dismiss'], ['Open task']]);
});

test('line 1 links the task id when the item has a task and the title when it has none', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Staffing', status: 'in_progress' });
  const withTask = w.pc.addApproval({ issueId: issue.id, payload: { title: 'Hire' } });
  const without = w.pc.addApproval({ payload: { title: 'No task here' } });
  w.pc.addJoinRequest({ name: 'Joiner' });
  await bot.pollOnce();

  const first = w.tg.sent().find((m) => m.text.includes(`approvals/${withTask.id}`));
  assert.equal(first.text.split('\n')[0], `<b>Approval</b> · <a href="${UI_BASE_URL}/TST/approvals/${withTask.id}">TST-1</a> Staffing`);
  const second = w.tg.sent().find((m) => m.text.includes(`approvals/${without.id}`));
  assert.equal(second.text.split('\n')[0], `<b>Approval</b> · <a href="${UI_BASE_URL}/TST/approvals/${without.id}">No task here</a>`);
  const join = startsWith(w, '<b>Join request</b>');
  assert.equal(join.text.split('\n')[0], `<b>Join request</b> · <a href="${UI_BASE_URL}/TST/settings/access">Joiner</a>`);
  for (const message of [first, second, join]) assert.equal(validateTelegramHtml(message.text), null);
});

test('inside its own topic an item has no Open task button; a subtask item in the parent topic keeps it', async (t) => {
  const { w, bot, issue, thread } = await topicSetup(t);
  const child = w.pc.addIssue({ title: 'Small step', status: 'blocked', parentId: issue.id });
  w.pc.addBlocker(issue.id, { whyNow: 'Waiting for a key.' });
  w.pc.addBlocker(child.id, { whyNow: 'Waiting for access.' });
  await bot.pollOnce();

  const own = w.tg.sent().find((m) => m.text.includes('Waiting for a key.'));
  assert.equal(own.thread, thread);
  assert.equal(own.text.split('\n')[0], mentioned('Blocked', w.tg.userId));
  assert.deepEqual(rowsOf(w, own.message_id), []);

  const sub = w.tg.sent().find((m) => m.text.includes('Waiting for access.'));
  assert.equal(sub.thread, thread);
  assert.equal(sub.text.split('\n')[0], `${mentioned('Blocked', w.tg.userId)} · <a href="${UI_BASE_URL}/TST/issues/TST-2">TST-2</a> Small step`);
  assert.deepEqual(rowsOf(w, sub.message_id), [['Open task']]);
});
