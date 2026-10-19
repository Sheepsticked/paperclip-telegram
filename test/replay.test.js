import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { confirmPayload, startWorld, UI_BASE_URL } from './helpers.js';

const GROUP_ID = -1001234567890;
const TASK_URL = `${UI_BASE_URL}/TST/issues/TST-1`;
const TITLE = 'Build the bot';
const logText = (w) => w.allLogText();
const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => `${b.text}${b.style ? ` [${b.style}]` : ''}`));

// An open task with a description; the bot has seen it once, so later changes are news.
async function startScenario(t, world) {
  const w = await startWorld(world);
  t.after(() => w.close());
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: TITLE, description: 'Phone remote for agents.', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.pollOnce();
  return { w, bot, issue };
}

// The agent's side of one task: a comment, a status change and a question, each followed by a poll.
function story(w, bot, issue) {
  return {
    async review() {
      w.pc.addComment(issue.id, { body: 'Ready for review: the bot has the new layout.' });
      w.pc.setStatus(issue.id, 'in_review');
      await bot.pollOnce();
    },
    async questionAndComment() {
      w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });
      w.pc.addComment(issue.id, { body: 'Merge is waiting for your answer.' });
      await bot.pollOnce();
    },
    async lastComment() {
      w.pc.addComment(issue.id, { body: 'Done. The change is merged.' });
      await bot.pollOnce();
    },
    async done() {
      w.pc.setStatus(issue.id, 'done');
      await bot.pollOnce();
    },
  };
}

test('replay in a forum group: each thing is said once, the topic is closed and never renamed', async (t) => {
  const { w, bot, issue } = await startScenario(t, { telegram: { chatId: GROUP_ID, forum: true }, config: { topics: 'auto' } });
  const steps = story(w, bot, issue);
  await steps.review();
  await steps.questionAndComment();
  const card = w.tg.findMessage('<b>Question</b>');
  const cardRows = rowsOf(w, card.message_id);
  await bot.handleUpdate(w.tg.tapButton(card.message_id, 'Deploy'));
  await steps.lastComment();
  await steps.done();

  const thread = bot.state.topics.get(issue.id).thread;
  const messages = w.tg.inTopic(thread);
  assert.deepEqual(
    messages.map((m) => m.text),
    [
      `<b><a href="${TASK_URL}">TST-1</a></b> ${TITLE}\nIn review · Dev · updated just now\n<blockquote>Phone remote for agents.</blockquote>`,
      '<b>In review</b>\n<blockquote>Ready for review: the bot has the new layout.</blockquote>',
      '<b>Question</b>\nDeploy the change?\n\nConfirmed',
      '<b>Dev</b>\n<blockquote>Merge is waiting for your answer.</blockquote>',
      '<b>Dev</b>\n<blockquote>Done. The change is merged.</blockquote>',
      '<b>Done</b>',
    ],
  );
  assert.deepEqual(messages.map((m) => rowsOf(w, m.message_id)), [[['Done [success]', 'More']], [], [], [], [], []]);
  assert.deepEqual(cardRows, [['Deploy [success]', 'Hold [danger]']], 'the card has its two answer buttons and no Open task');
  assert.deepEqual(messages[0].pinned, { silent: true });

  assert.equal(w.tg.callsTo('createForumTopic').length, 1);
  assert.equal(w.tg.callsTo('editForumTopic').length, 0, 'the topic is never renamed');
  assert.equal(w.tg.callsTo('closeForumTopic').length, 1);
  assert.equal(w.tg.topics.get(thread).name, `TST-1 ${TITLE}`);
  assert.equal(w.tg.topics.get(thread).closed, true);
  assert.equal(w.tg.sent().filter((m) => m.thread !== thread).length, 0, 'nothing went to General');
  assert.ok(!w.tg.sent().some((m) => m.text.includes('Open in Paperclip')));
});

test('replay in General with topics off: line 1 names and links the task, every task message has Open task', async (t) => {
  const { w, bot, issue } = await startScenario(t, {});
  await bot.handleUpdate(w.tg.message('/task TST-1'));
  const view = w.tg.lastMessage();
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'More'));
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Follow'));
  assert.ok(bot.state.isFollowing(issue.id));
  assert.deepEqual(rowsOf(w, view.message_id), [['Done [success]', 'More']]);

  const steps = story(w, bot, issue);
  await steps.review();
  await steps.questionAndComment();
  const card = w.tg.findMessage('<b>Question</b>');
  const cardRows = rowsOf(w, card.message_id);
  await bot.handleUpdate(w.tg.tapButton(card.message_id, 'Deploy'));
  await steps.lastComment();
  await steps.done();

  const head = `<a href="${TASK_URL}">TST-1</a> ${TITLE}`;
  const messages = w.tg.sent().slice(1);
  assert.deepEqual(
    messages.map((m) => m.text),
    [
      `<b>In review</b> · ${head}\n<blockquote>Ready for review: the bot has the new layout.</blockquote>`,
      `<b>Question</b> · <a href="${TASK_URL}#interaction-${w.pc.interactions.keys().next().value}">TST-1</a> ${TITLE}\nDeploy the change?\n\nConfirmed`,
      `<b>Dev</b> · ${head}\n<blockquote>Merge is waiting for your answer.</blockquote>`,
      `<b>Dev</b> · ${head}\n<blockquote>Done. The change is merged.</blockquote>`,
      `<b>Done</b> · ${head}`,
    ],
  );
  assert.deepEqual(cardRows, [['Deploy [success]', 'Hold [danger]'], ['Open task']]);
  assert.deepEqual(messages.map((m) => rowsOf(w, m.message_id).at(-1)), [['Open task'], undefined, ['Open task'], ['Open task'], ['Open task']]);
  assert.equal(w.tg.callsTo('createForumTopic').length, 0);
  assert.ok(!w.tg.sent().some((m) => m.text.includes('Open in Paperclip')));
});

test('a done message keeps its quote when that comment was not shown before', async (t) => {
  const { w, bot, issue } = await startScenario(t, { telegram: { chatId: GROUP_ID, forum: true } });
  w.pc.addComment(issue.id, { body: 'Finished: all checks pass.' });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  const thread = bot.state.topics.get(issue.id).thread;
  const texts = w.tg.inTopic(thread).map((m) => m.text);
  assert.equal(texts.at(-1), '<b>Done</b>\n<blockquote>Finished: all checks pass.</blockquote>');
  assert.equal(texts.filter((text) => text.includes('Finished')).length, 1, 'the follow message for that comment is skipped');
  assert.ok(bot.state.hasShown(w.pc.comments.at(-1).id));
});

test('the shown comments survive a restart and are cleared when the chat changes', async (t) => {
  const { w, bot, issue } = await startScenario(t, {});
  await bot.handleUpdate(w.tg.message('/task TST-1'));
  const comment = w.pc.addComment(issue.id, { body: 'Shown in the view' });
  await bot.handleUpdate(w.tg.message('/task TST-1'));
  assert.match(w.tg.lastMessage().text, /<b>Dev<\/b>\n<blockquote>Shown in the view<\/blockquote>/);
  assert.ok(bot.state.hasShown(comment.id));
  bot.state.save();

  const restarted = w.makeBot();
  assert.ok(restarted.state.hasShown(comment.id), 'the memory is in the state file');
  w.pc.setStatus(issue.id, 'done');
  await restarted.pollOnce();
  assert.equal(w.tg.lastMessage().text, `<b>Done</b> · <a href="${TASK_URL}">TST-1</a> ${TITLE}`, 'no quote for a comment the chat already showed');

  w.tg.switchChat({ chatId: GROUP_ID, forum: false });
  w.config.telegramChatId = GROUP_ID;
  const moved = w.makeBot();
  assert.equal(moved.state.hasShown(comment.id), false, 'a new chat starts with an empty memory');
  assert.deepEqual(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).shownComments, []);
});

test('a state file without the memory loads with an empty one, and the memory keeps the newest 500', async (t) => {
  const w = await startWorld();
  t.after(() => w.close());
  const bot = await w.primedBot();
  const saved = JSON.parse(fs.readFileSync(w.statePath, 'utf8'));
  delete saved.shownComments;
  fs.writeFileSync(w.statePath, JSON.stringify(saved));
  const old = w.makeBot();
  assert.equal(old.state.shownComments.size, 0);

  for (let i = 0; i < 600; i += 1) bot.state.noteShown(`comment-${i}`);
  assert.equal(bot.state.shownComments.size, 500);
  assert.equal(bot.state.hasShown('comment-99'), false, 'the oldest go first');
  assert.equal(bot.state.hasShown('comment-100'), true);
  bot.state.noteShown('comment-100');
  bot.state.noteShown('comment-600');
  assert.equal(bot.state.hasShown('comment-100'), true, 'a comment shown again counts as new');
});

test('the topic the bot creates is announced to it, and that message is dropped without a log line', async (t) => {
  const { w, bot, issue } = await startScenario(t, { telegram: { chatId: GROUP_ID, forum: true } });
  w.pc.addComment(issue.id, { body: 'Ready.' });
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  const thread = bot.state.topics.get(issue.id).thread;

  const before = logText(w);
  const requests = w.pc.requests.length;
  const calls = w.tg.calls.length;
  await bot.handleUpdate(w.tg.topicCreated(thread));
  await bot.handleUpdate(w.tg.message('written by the bot itself', { thread, from: w.tg.botId, bot: true }));
  await bot.handleUpdate(w.tg.message(undefined, { thread, from: 2002, extra: { forum_topic_closed: {} } }));
  assert.equal(logText(w), before);
  assert.ok(!logText(w).includes('unauthorized sender'));
  assert.equal(w.pc.requests.length, requests);
  assert.equal(w.tg.calls.length, calls);

  await bot.handleUpdate(w.tg.message('from a stranger', { thread, from: 2002 }));
  assert.match(logText(w), /ignored an update from an unauthorized sender/, 'other senders are still logged');
});

test('a closed topic is reopened without a rename, and an old status suffix is restored', async (t) => {
  const { w, bot, issue } = await startScenario(t, { telegram: { chatId: GROUP_ID, forum: true } });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  const thread = bot.state.topics.get(issue.id).thread;
  assert.equal(w.tg.topics.get(thread).closed, true);

  w.pc.setStatus(issue.id, 'in_progress');
  await bot.pollOnce();
  assert.equal(w.tg.topics.get(thread).closed, false);
  assert.equal(w.tg.callsTo('editForumTopic').length, 0, 'a topic that was never renamed is not renamed on reopening');

  // A topic closed earlier carries the suffix, and its state entry has no flag for it.
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  w.tg.topics.get(thread).name = `TST-1 ${TITLE} (done)`;
  const entry = bot.state.topics.get(issue.id);
  delete entry.suffixed;
  bot.state.save();
  const restarted = w.makeBot();
  assert.equal(restarted.state.topics.get(issue.id).suffixed, true, 'a closed topic from an old state is taken to carry the suffix');

  w.pc.setStatus(issue.id, 'todo');
  await restarted.pollOnce();
  assert.equal(w.tg.topics.get(thread).closed, false);
  assert.equal(w.tg.topics.get(thread).name, `TST-1 ${TITLE}`);
  assert.equal(w.tg.callsTo('editForumTopic').length, 1);
  assert.equal(restarted.state.topics.get(issue.id).suffixed, false);
});
