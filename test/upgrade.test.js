import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { confirmPayload, questionsPayload, startWorld, textQuestion } from './helpers.js';

const GROUP_ID = -1001234567890;
const V1_STATE = fs.readFileSync(new URL('./fixtures/v1-state.json', import.meta.url), 'utf8');

const posts = (w, suffix) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));
// The kind word that starts a message, with or without a link around it.
const headOf = (message) => message.text.match(/^<b>(?:<a [^>]*>)?([^<]+)/)?.[1];

// Four tasks and two interactions on the fake server that match the ids in the state file written by the first version.
function seedV1(w) {
  const issues = [
    w.pc.addIssue({ title: 'Prepare the release', status: 'in_progress' }),
    w.pc.addIssue({ title: 'Review the notes', status: 'in_review' }),
    w.pc.addIssue({ title: 'Ship the patch', status: 'done' }),
    w.pc.addIssue({ title: 'Plan the next sprint', status: 'todo' }),
  ];
  const question = w.pc.addInteraction(issues[0].id, { kind: 'ask_user_questions', payload: questionsPayload([textQuestion('why', 'What is the reason?')]) });
  const confirmation = w.pc.addInteraction(issues[3].id, { kind: 'request_confirmation', payload: confirmPayload() });
  w.pc.resolveElsewhere(confirmation.id);

  // Writes the saved state with the placeholder ids replaced; `statuses` adds tasks the fixture does not know.
  const install = ({ statuses = {} } = {}) => {
    let text = V1_STATE.replaceAll('interaction-1', question.id).replaceAll('interaction-2', confirmation.id);
    issues.forEach((issue, i) => {
      text = text.replaceAll(`issue-${i + 1}`, issue.id);
    });
    const state = JSON.parse(text);
    state.baselineAt = new Date(Date.now() - 1000).toISOString();
    state.lastPollAt = state.baselineAt;
    state.cards['1'].resolvedAt = state.baselineAt;
    Object.assign(state.statuses, statuses);
    fs.mkdirSync(path.dirname(w.statePath), { recursive: true });
    fs.writeFileSync(w.statePath, JSON.stringify(state));
  };
  return { issues, question, install };
}

test('a state written by the first version, in the same chat, sends nothing and loses nothing', async (t) => {
  const w = await startWorld();
  t.after(() => w.close());
  const { issues, install } = seedV1(w);
  install();
  const bot = w.makeBot();
  await bot.pollOnce();

  assert.equal(w.tg.callsTo('sendMessage').length, 0);
  assert.equal(bot.state.chatId, w.config.telegramChatId);
  assert.deepEqual([...bot.state.messages.keys()], [100, 101, 102, 103, 104]);
  assert.equal(bot.state.cards.size, 2);
  assert.doesNotMatch(w.allLogText(), /chat changed/);

  // An old message id still leads to its task.
  await bot.handleUpdate(w.tg.message('A note on the task', { replyTo: 102 }));
  const comments = posts(w, '/comments');
  assert.equal(comments.length, 1);
  assert.ok(comments[0].path.includes(issues[1].id));
});

test('a move to a forum group sends open cards and approvals there, in topics, and forgets the old message ids', async (t) => {
  const w = await startWorld({ telegram: { firstMessageId: 900 } });
  t.after(() => w.close());
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Prepare the release', status: 'in_progress' });
  await bot.pollOnce();
  const question = w.pc.addInteraction(issue.id, { kind: 'ask_user_questions', payload: questionsPayload([textQuestion('why', 'What is the reason?')]) });
  const approval = w.pc.addApproval({ issueId: issue.id });
  await bot.pollOnce();
  const oldCard = bot.state.cardByInteraction(question.id);
  const oldApproval = [...bot.state.inbox.values()].find((record) => record.kind === 'approval');
  assert.ok(oldCard.messageId >= 900 && oldApproval.messageIds[0] >= 900, 'both went to the private chat');
  assert.equal(w.tg.sent().length, 2);

  bot.stop();
  w.tg.switchChat({ chatId: GROUP_ID, forum: true });
  const moved = w.makeBot({ config: { ...w.config, telegramChatId: GROUP_ID } });
  await moved.pollOnce();

  assert.match(w.allLogText(), /chat changed/);
  assert.equal(moved.state.chatId, GROUP_ID);
  const cardMessage = w.tg.sent().find((m) => m.text.includes('What is the reason?'));
  const approvalMessage = w.tg.sent().find((m) => headOf(m) === 'Approval');
  assert.ok(cardMessage, 'the question card arrived');
  assert.ok(approvalMessage, 'the approval arrived');
  assert.notEqual(cardMessage.thread, null, 'the card is in a topic');
  assert.equal(approvalMessage.thread, cardMessage.thread, 'both are in the topic of their task');
  assert.deepEqual(
    [...moved.state.messages.keys()].filter((id) => id >= 900),
    [],
    'no id of the old chat is left',
  );
  assert.equal(moved.state.cardByInteraction(question.id).messageId, cardMessage.message_id);
  assert.equal(moved.state.statuses.get(issue.id), 'in_progress', 'what is not tied to the old chat is kept');

  // A reply to an unrelated message that only shares an old id leads nowhere.
  for (const oldId of [oldCard.messageId, oldApproval.messageIds[0]]) {
    await moved.handleUpdate(w.tg.message('A reply to something else', { replyTo: oldId }));
  }
  assert.equal(posts(w, '/comments').length, 0);
  assert.equal(posts(w, '/respond').length, 0);

  // Resolving the approval edits only its new message.
  const edited = () => [...w.tg.callsTo('editMessageText'), ...w.tg.callsTo('editMessageReplyMarkup')];
  const before = edited().length;
  await moved.handleUpdate(w.tg.tapButton(approvalMessage.message_id, 'Approve'));
  await moved.handleUpdate(w.tg.tapButton(approvalMessage.message_id, 'Tap again to confirm'));
  assert.equal(posts(w, `/approvals/${approval.id}/approve`).length, 1);
  const edits = edited().slice(before);
  assert.ok(edits.length > 0);
  for (const edit of edits) {
    assert.equal(edit.params.chat_id, GROUP_ID);
    assert.equal(edit.params.message_id, approvalMessage.message_id);
  }

  const sends = w.tg.callsTo('sendMessage').length;
  await moved.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length - sends, 0, 'a later poll sends nothing again');
});

test('a move to another chat sends at most ten open items and one summary line', async (t) => {
  const w = await startWorld({ telegram: { firstMessageId: 900 } });
  t.after(() => w.close());
  const bot = await w.primedBot();
  for (let i = 0; i < 13; i += 1) w.pc.addApproval({ payload: { title: `Request ${i}` } });
  await bot.pollOnce();
  assert.equal(w.tg.sent().length, 13);

  bot.stop();
  w.tg.switchChat({ chatId: GROUP_ID, forum: true });
  const moved = w.makeBot({ config: { ...w.config, telegramChatId: GROUP_ID } });
  await moved.pollOnce();
  const sentBeforeBoard = () => w.tg.sent().filter((m) => m.message_id !== moved.state.boardMessageId);
  const sent = sentBeforeBoard();
  assert.equal(sent.length, 11);
  assert.equal(sent.slice(0, 10).filter((m) => headOf(m) === 'Approval').length, 10);
  assert.equal(sent[10].text, '+3 more, see /status');
  await moved.pollOnce();
  assert.equal(sentBeforeBoard().length, 11);
});

test('the first poll after an upgrade sends ten inbox items, in order of importance, and one summary line', async (t) => {
  const w = await startWorld();
  t.after(() => w.close());
  const { issues, install } = seedV1(w);

  // The tasks the stalled reviews are about were already in review before the upgrade.
  const stalled = [1, 2, 3].map((i) => w.pc.addIssue({ title: `Stuck ${i}`, status: 'in_review' }));
  install({ statuses: Object.fromEntries(stalled.map((issue) => [issue.id, 'in_review'])) });
  for (let i = 0; i < 14; i += 1) w.pc.addJoinRequest({ name: `Agent ${i}` });
  for (let i = 0; i < 4; i += 1) w.pc.addDecision({ issueId: issues[0].id, title: `Choice ${i}` });
  for (let i = 0; i < 4; i += 1) w.pc.addApproval({ payload: { title: `Request ${i}` } });
  for (const issue of stalled) w.pc.addReview(issue.id, { stalled: true });
  w.pc.addReview(issues[1].id);

  const bot = w.makeBot();
  await bot.pollOnce();
  const sent = w.tg.sent();
  assert.equal(sent.length, 11, 'ten items and the summary');
  assert.deepEqual(sent.slice(0, 10).map(headOf), [...Array(4).fill('Approval'), ...Array(4).fill('Decision'), 'Review', 'Review']);
  assert.equal(sent[10].text, '+15 more, see /status');
  assert.ok(sent.every((m) => !m.text.includes('TST-2')), 'a plain review of a task already in review is not news');
  assert.equal(bot.state.inboxSyncDone, true);

  await bot.pollOnce();
  assert.equal(w.tg.sent().length, 11, 'the second poll sends nothing');
});
