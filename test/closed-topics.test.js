import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { startWorld } from './helpers.js';

const GROUP_ID = -1001234567890;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NO_DELETE = { can_manage_topics: true, can_pin_messages: true, can_delete_messages: false };
const WARNING = 'the bot lacks the Delete messages right, so finished topics are kept';

async function setup(t, { telegram, config } = {}) {
  const w = await startWorld({ telegram: { chatId: GROUP_ID, forum: true, ...telegram }, config });
  t.after(() => w.close());
  const clock = { at: Date.now() };
  const bot = await w.primedBot({ now: () => clock.at });
  return { w, bot, clock };
}

const deletes = (w) => w.tg.callsTo('deleteForumTopic');
const warnings = (w, text) => w.allLogText().split(text).length - 1;
// The bot asks for the changes since its last poll; after a jump of the test clock that window must be set back.
const rewind = (bot) => {
  bot.state.lastPollAt = new Date(Date.now() - 60_000).toISOString();
};

// A task that finished: its topic exists and is closed.
async function finishedTask(w, bot, title = 'Finished work') {
  const issue = w.pc.addIssue({ title, status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  const topic = bot.state.topics.get(issue.id);
  assert.equal(topic.closed, 'done');
  return { issue, topic };
}

test('closing a topic stores when, and reopening clears it', async (t) => {
  const { w, bot, clock } = await setup(t);
  const { issue, topic } = await finishedTask(w, bot);
  assert.equal(topic.closedAt, clock.at);

  clock.at += HOUR;
  rewind(bot);
  w.pc.setStatus(issue.id, 'in_progress');
  await bot.pollOnce();
  assert.equal(w.tg.topics.get(topic.thread).closed, false);
  assert.equal(topic.closed, null);
  assert.equal(topic.closedAt, null);

  clock.at += HOUR;
  rewind(bot);
  w.pc.setStatus(issue.id, 'cancelled');
  await bot.pollOnce();
  assert.equal(topic.closedAt, clock.at, 'closed again, counted from then');
});

test('a finished topic is deleted after 7 days and not before', async (t) => {
  const { w, bot, clock } = await setup(t);
  const { issue, topic } = await finishedTask(w, bot);
  const closedAt = clock.at;

  clock.at = closedAt + 7 * DAY - HOUR;
  await bot.pollOnce();
  assert.equal(deletes(w).length, 0);
  assert.ok(bot.state.topics.has(issue.id));

  clock.at = closedAt + 7 * DAY + HOUR;
  await bot.pollOnce();
  assert.equal(deletes(w).length, 1);
  assert.deepEqual(deletes(w)[0].params, { chat_id: GROUP_ID, message_thread_id: topic.thread });
  assert.equal(w.tg.topics.get(topic.thread).deleted, true);
  assert.equal(bot.state.topics.has(issue.id), false);
  assert.equal(bot.state.rootForThread(topic.thread), null);
  assert.equal(warnings(w, 'warn'), 0);

  clock.at += 2 * HOUR;
  await bot.pollOnce();
  assert.equal(deletes(w).length, 1, 'nothing left to delete');
});

test('the sweep runs at most once an hour', async (t) => {
  const { w, bot, clock } = await setup(t, { telegram: { botRights: NO_DELETE } });
  await finishedTask(w, bot);
  clock.at += 8 * DAY;
  await bot.pollOnce();
  await bot.pollOnce();
  clock.at += 30 * 60 * 1000;
  await bot.pollOnce();
  assert.equal(deletes(w).length, 1, 'one attempt in that hour');
  clock.at += 31 * 60 * 1000;
  await bot.pollOnce();
  assert.equal(deletes(w).length, 2);
});

test('closedTopicDays sets the limit and 0 never deletes', async (t) => {
  const one = await setup(t, { config: { closedTopicDays: 1 } });
  const { topic } = await finishedTask(one.w, one.bot);
  one.clock.at += DAY + HOUR;
  await one.bot.pollOnce();
  assert.equal(one.w.tg.topics.get(topic.thread).deleted, true);

  const never = await setup(t, { config: { closedTopicDays: 0 } });
  const kept = await finishedTask(never.w, never.bot);
  never.clock.at += 3650 * DAY;
  await never.bot.pollOnce();
  assert.equal(deletes(never.w).length, 0);
  assert.ok(never.bot.state.topics.has(kept.issue.id));
  assert.equal(warnings(never.w, WARNING), 0, 'no warning when the bot would not delete anyway');
});

test('a topic that is already gone is dropped', async (t) => {
  const { w, bot, clock } = await setup(t);
  const { issue, topic } = await finishedTask(w, bot);
  w.tg.deleteTopic(topic.thread);
  clock.at += 8 * DAY;
  await bot.pollOnce();
  assert.equal(deletes(w).length, 1);
  assert.equal(bot.state.topics.has(issue.id), false);
  assert.equal(warnings(w, 'warn'), 0);
});

test('without the Delete messages right the topic is kept, with one warning an hour', async (t) => {
  const { w, bot, clock } = await setup(t, { telegram: { botRights: NO_DELETE } });
  assert.equal(warnings(w, WARNING), 1, 'said once at start');
  assert.equal(bot.topics.canDelete, false);
  const { issue, topic } = await finishedTask(w, bot);
  await bot.pollOnce();
  assert.equal(warnings(w, WARNING), 1, 'not again before anything is due');

  clock.at += 8 * DAY;
  await bot.pollOnce();
  assert.equal(deletes(w).length, 1, 'the bot still tries, the right may have been given since');
  assert.ok(bot.state.topics.has(issue.id));
  assert.equal(w.tg.topics.get(topic.thread).deleted, false);
  assert.equal(warnings(w, WARNING), 2);
  clock.at += 10 * 60 * 1000;
  await bot.pollOnce();
  await bot.pollOnce();
  assert.equal(warnings(w, WARNING), 2, 'once an hour at most');

  clock.at += HOUR;
  await bot.pollOnce();
  assert.equal(warnings(w, WARNING), 3);
  assert.ok(bot.state.topics.has(issue.id));

  w.tg.setBotRights({ can_manage_topics: true, can_pin_messages: true, can_delete_messages: true });
  clock.at += HOUR;
  await bot.pollOnce();
  assert.equal(w.tg.topics.get(topic.thread).deleted, true, 'deleted at the next sweep once the right is there');
  assert.equal(bot.state.topics.has(issue.id), false);
  assert.equal(warnings(w, WARNING), 3);
});

test('another error keeps the topic, warns and tries again at the next sweep', async (t) => {
  const { w, bot, clock } = await setup(t);
  const { issue, topic } = await finishedTask(w, bot);
  w.tg.failNext('deleteForumTopic', 400, { ok: false, error_code: 400, description: 'Bad Request: something odd' });
  clock.at += 8 * DAY;
  await bot.pollOnce();
  assert.ok(bot.state.topics.has(issue.id));
  assert.match(w.allLogText(), /warn could not delete a finished topic; trying again at the next sweep/);
  assert.equal(warnings(w, WARNING), 0, 'not blamed on the right');

  clock.at += HOUR + 1;
  await bot.pollOnce();
  assert.equal(w.tg.topics.get(topic.thread).deleted, true);
  assert.equal(bot.state.topics.has(issue.id), false);
});

test('a Telegram outage during the sweep keeps every topic for the next one', async (t) => {
  const { w, bot, clock } = await setup(t);
  const first = await finishedTask(w, bot, 'First');
  const second = await finishedTask(w, bot, 'Second');
  w.tg.failNext('deleteForumTopic', 500, { ok: false, error_code: 500, description: 'Internal Server Error' }, Infinity);
  clock.at += 8 * DAY;
  await bot.pollOnce();
  assert.equal(deletes(w).length, 1, 'the sweep stopped at the first failure');
  assert.ok(bot.state.topics.has(first.issue.id) && bot.state.topics.has(second.issue.id));

  w.tg.clearFailures();
  clock.at += HOUR + 1;
  await bot.pollOnce();
  assert.equal(bot.state.topics.size, 0);
});

test('a new event for a task whose topic was deleted makes a new topic', async (t) => {
  const { w, bot, clock } = await setup(t);
  const { issue, topic } = await finishedTask(w, bot);
  clock.at += 8 * DAY;
  await bot.pollOnce();
  assert.equal(bot.state.topics.has(issue.id), false);

  rewind(bot);
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  const fresh = bot.state.topics.get(issue.id);
  assert.ok(fresh, 'a new topic');
  assert.notEqual(fresh.thread, topic.thread);
  assert.equal(fresh.closed, null);
  assert.equal(w.tg.callsTo('createForumTopic').length, 2);
  assert.ok(w.tg.inTopic(fresh.thread).some((m) => m.text.includes('In review')));
  assert.ok(w.tg.inTopic(fresh.thread)[0].text.includes(`${issue.identifier}</a></b> Finished work`), 'with the pinned view');
});

test('the sweep deletes only topics in state: not General, not a topic the owner started', async (t) => {
  const { w, bot, clock } = await setup(t);
  const side = w.tg.ownerTopic('Side topic');
  const { topic } = await finishedTask(w, bot);
  bot.state.topics.set('general-task', { thread: 1, identifier: 'TST-99', title: 'In General', closed: 'done', suffixed: true, closedAt: clock.at - 30 * DAY, projectId: null, iconId: '' });
  clock.at += 8 * DAY;
  await bot.pollOnce();

  assert.deepEqual(deletes(w).map((c) => c.params.message_thread_id), [topic.thread]);
  assert.equal(w.tg.topics.get(side).deleted, false);
  assert.ok(bot.state.topics.has('general-task'));
});

test('an open topic is never deleted, however old', async (t) => {
  const { w, bot, clock } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Long running', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  clock.at += 400 * DAY;
  await bot.pollOnce();
  assert.equal(deletes(w).length, 0);
  assert.ok(bot.state.topics.has(issue.id));
});

test('deleting a topic drops the offers made in it and keeps the others', async (t) => {
  const { w, bot, clock } = await setup(t);
  const { topic } = await finishedTask(w, bot);
  clock.at += 8 * DAY;
  const inside = bot.state.addOffer('Task idea', 1, 2, clock.at, topic.thread);
  const elsewhere = bot.state.addOffer('Another idea', 3, 4, clock.at, topic.thread + 1);
  const general = bot.state.addOffer('General idea', 5, 6, clock.at);
  await bot.pollOnce();
  assert.equal(bot.state.offers.has(inside), false);
  assert.equal(bot.state.offers.has(elsewhere), true);
  assert.equal(bot.state.offers.has(general), true);
});

test('the deletion survives a restart: the closing time is saved', async (t) => {
  const { w, bot, clock } = await setup(t);
  const { issue, topic } = await finishedTask(w, bot);
  const restarted = w.makeBot({ now: () => clock.at });
  assert.equal(restarted.state.topics.get(issue.id).closedAt, topic.closedAt);
  clock.at += 8 * DAY;
  await restarted.pollOnce();
  assert.equal(restarted.state.topics.has(issue.id), false);
});

test('a state file of the previous version with open and closed topics upgrades cleanly', async (t) => {
  const { w, bot, clock } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const open = w.pc.addIssue({ title: 'Open one', status: 'in_progress', projectId: project.id });
  const closed = w.pc.addIssue({ title: 'Closed one', status: 'in_progress', projectId: project.id });
  const bare = w.pc.addIssue({ title: 'No project', status: 'in_progress' });
  await bot.pollOnce();
  for (const issue of [open, closed, bare]) w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  w.pc.setStatus(closed.id, 'done');
  await bot.pollOnce();
  bot.stop();
  const editsBefore = w.tg.callsTo('editForumTopic').length;

  // Takes out what the new version added, as the old version wrote the file.
  const saved = JSON.parse(fs.readFileSync(w.statePath, 'utf8'));
  for (const topic of Object.values(saved.topics)) for (const key of ['closedAt', 'projectId', 'iconId']) delete topic[key];
  for (const key of ['projectIcons', 'boardMessageId', 'boardHash']) delete saved[key];
  assert.equal(saved.topics[closed.id].closed, 'done');
  fs.writeFileSync(w.statePath, JSON.stringify(saved));
  // The topics of the previous version had no icons.
  for (const topic of Object.values(saved.topics)) w.tg.topics.get(topic.thread).iconId = '';
  clock.at += 30 * DAY;

  const upgraded = w.makeBot({ now: () => clock.at });
  assert.equal(upgraded.state.topics.get(closed.id).closedAt, clock.at, 'a closed topic counts from the first start');
  assert.equal(upgraded.state.topics.get(open.id).closedAt, null);
  await upgraded.pollOnce();
  await upgraded.pollOnce();

  assert.equal(upgraded.state.topics.get(open.id).projectId, project.id);
  assert.equal(upgraded.state.topics.get(bare.id).projectId, null);
  const edits = w.tg.callsTo('editForumTopic').slice(editsBefore);
  assert.deepEqual(
    edits.map((c) => [c.params.message_thread_id, c.params.icon_custom_emoji_id]),
    [[saved.topics[open.id].thread, upgraded.state.projectIcons.get(project.id)]],
    'the open topic of a project gets its icon once; the closed one and the one without a project are left alone',
  );
  assert.ok(upgraded.state.projectIcons.get(project.id));
  assert.equal(deletes(w).length, 0, 'nothing is deleted on the first start');
  assert.equal(upgraded.state.topics.has(closed.id), true);

  clock.at += 7 * DAY + HOUR;
  await upgraded.pollOnce();
  assert.equal(upgraded.state.topics.has(closed.id), false);
  assert.ok(upgraded.state.topics.has(open.id));
});
