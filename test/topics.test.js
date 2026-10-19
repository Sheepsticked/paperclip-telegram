import assert from 'node:assert/strict';
import test from 'node:test';
import { ICON_COLORS, iconColor, topicName } from '../src/topics.js';
import { startWorld } from './helpers.js';

const GROUP_ID = -1001234567890;
const NO_PIN = { can_manage_topics: true, can_pin_messages: false };
const THREAD_GONE = { ok: false, error_code: 400, description: 'Bad Request: message thread not found' };

async function setup(t, { telegram, config } = {}) {
  const w = await startWorld({ telegram: { chatId: GROUP_ID, forum: true, ...telegram }, config });
  t.after(() => w.close());
  const bot = await w.primedBot();
  return { w, bot };
}

const logText = (w) => w.allLogText();
const topicOf = (w, part) => w.tg.topicNamed(part);
const posts = (w, suffix) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));
const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));

// An open task whose topic exists, plus a poll that has already seen it.
async function taskWithTopic(w, bot, fields = {}) {
  const issue = w.pc.addIssue({ title: 'Plan the launch', status: 'in_progress', ...fields });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  const entry = bot.state.topics.get(issue.id);
  assert.ok(entry, 'the in-review message created the topic');
  return { issue, thread: entry.thread };
}

test('topics turn on in a forum group where the bot may manage topics', async (t) => {
  const { w, bot } = await setup(t);
  await bot.topicsReady();
  assert.equal(bot.topics.on, true);
  assert.equal(bot.topics.canPin, true);
  assert.match(logText(w), /^info topics on$/m);
});

const OFF_CASES = [
  ['the chat is not a forum', { telegram: { forum: false } }, 'topics off: not a forum'],
  ['the bot is not an admin', { telegram: { botRights: null } }, 'topics off: the bot is not an admin'],
  ['the bot may not manage topics', { telegram: { botRights: { can_manage_topics: false, can_pin_messages: true } } }, 'topics off: the bot lacks the Manage topics right'],
  ['the config says off', { config: { topics: 'off' } }, 'topics off: off in the config'],
];

for (const [name, options, line] of OFF_CASES) {
  test(`topics stay off and say why when ${name}`, async (t) => {
    const { w, bot } = await setup(t, options);
    await bot.topicsReady();
    assert.equal(bot.topics.on, false);
    assert.ok(logText(w).includes(`info ${line}\n`), logText(w));
    assert.equal(logText(w).split('topics o').length - 1, 1, 'exactly one topics line');
  });
}

test('topics stay off when the chat cannot be read', async (t) => {
  const { w, bot } = await setup(t);
  w.tg.failNext('getChat', 400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
  await bot.topicsReady();
  assert.equal(bot.topics.on, false);
  assert.match(logText(w), /^info topics off: the chat cannot be read$/m);
});

test('a failed topic check is tried again instead of being remembered', async (t) => {
  const { w, bot } = await setup(t);
  w.tg.failNext('getChat', 500, { ok: false, error_code: 500, description: 'Internal Server Error' }, Infinity);
  await assert.rejects(bot.topicsReady());
  w.tg.clearFailures();
  await bot.topicsReady();
  assert.equal(bot.topics.on, true);
});

test('without the pin right topics work but nothing is pinned, with one warning', async (t) => {
  const { w, bot } = await setup(t, { telegram: { botRights: NO_PIN } });
  await taskWithTopic(w, bot);
  assert.equal(bot.topics.on, true);
  assert.equal(bot.topics.canPin, false);
  assert.equal(w.tg.callsTo('pinChatMessage').length, 0);
  assert.equal(logText(w).split('Pin messages').length - 1, 1);
});

test('an update from another chat is logged once with its id and type, never its text', async (t) => {
  const { w, bot } = await setup(t);
  await bot.topicsReady();
  const requests = w.pc.requests.length;
  const calls = w.tg.calls.length;
  await bot.handleUpdate(w.tg.message('secret-text', { chat: -777, chatType: 'supergroup' }));
  await bot.handleUpdate(w.tg.message('more secret-text', { chat: -777, chatType: 'supergroup' }));
  await bot.handleUpdate(w.tg.message('/new secret-text', { chat: -888, chatType: 'group' }));

  const lines = logText(w).split('\n').filter((line) => line.includes('ignored an update from chat'));
  assert.deepEqual(lines, ['info ignored an update from chat -777 (supergroup)', 'info ignored an update from chat -888 (group)']);
  assert.ok(!logText(w).includes('secret-text'));
  assert.equal(w.pc.requests.length, requests);
  assert.equal(w.tg.calls.length, calls);
});

test('service messages, bots and other senders are ignored before any Paperclip call', async (t) => {
  const { w, bot } = await setup(t);
  const { thread } = await taskWithTopic(w, bot);
  const requests = w.pc.requests.length;
  const calls = w.tg.calls.length;
  const ignored = [
    w.tg.message(undefined, { thread, extra: { forum_topic_edited: { name: 'x' } } }),
    w.tg.message(undefined, { thread, extra: { pinned_message: { message_id: 1 } } }),
    w.tg.message(undefined, { extra: { new_chat_members: [{ id: 5, is_bot: false }] } }),
    w.tg.message('written by a bot', { thread, bot: true }),
    w.tg.message('written by someone else', { thread, from: 2002 }),
    w.tg.message('written in another group', { thread, chat: -42, chatType: 'supergroup' }),
  ];
  for (const update of ignored) await bot.handleUpdate(update);
  assert.equal(w.pc.requests.length, requests, 'no Paperclip call');
  assert.equal(w.tg.calls.length, calls, 'no Telegram call');
});

test('the first message about a task creates its topic with a name, a colour and a pinned view', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Website' });
  const { issue, thread } = await taskWithTopic(w, bot, { projectId: project.id });

  const topic = w.tg.topics.get(thread);
  assert.equal(topic.name, 'TST-1 Plan the launch');
  assert.equal(topic.icon_color, iconColor(project.id));
  const [view, notice] = w.tg.inTopic(thread);
  assert.equal(view.text.split('\n')[0], '<b>Task</b> · TST-1', 'the task view names only the id inside its own topic');
  assert.deepEqual(rowsOf(w, view.message_id).at(-1), ['Unfollow'], 'the view already shows that the task is followed');
  assert.deepEqual(view.pinned, { silent: true });
  assert.match(notice.text, /^<b>In review<\/b> · TST-1$/m);
  assert.equal(w.tg.callsTo('createForumTopic').length, 1);
  assert.deepEqual(bot.state.topics.get(issue.id), { thread, identifier: 'TST-1', title: 'Plan the launch', closed: null });
  assert.ok(bot.state.isFollowing(issue.id), 'a task with a topic is followed');

  w.pc.addComment(issue.id, { body: 'Agent update' });
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('createForumTopic').length, 1, 'the topic is reused');
  assert.match(w.tg.inTopic(thread).at(-1).text, /^<b>Comment<\/b> · TST-1$/m);
});

test('the topic mapping survives a restart', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, thread } = await taskWithTopic(w, bot);
  const restarted = w.makeBot();
  assert.equal(restarted.state.topics.get(issue.id).thread, thread);
  assert.equal(restarted.state.rootForThread(thread), issue.id);
});

test('a subtask event goes to the topic of its top-level task, with its own id and title', async (t) => {
  const { w, bot } = await setup(t);
  const parent = w.pc.addIssue({ title: 'Big job', status: 'in_progress' });
  const child = w.pc.addIssue({ title: 'Small step', status: 'in_progress', parentId: parent.id });
  const grandchild = w.pc.addIssue({ title: 'Tiny step', status: 'in_progress', parentId: child.id });
  await bot.pollOnce();
  w.pc.setStatus(grandchild.id, 'in_review');
  await bot.pollOnce();

  assert.equal(w.tg.callsTo('createForumTopic').length, 1);
  assert.deepEqual([...bot.state.topics.keys()], [parent.id]);
  const thread = bot.state.topics.get(parent.id).thread;
  const notice = w.tg.inTopic(thread).find((m) => m.text.includes('In review'));
  assert.match(notice.text, /^<b>In review<\/b> · TST-3 Tiny step$/m);
  assert.equal(bot.state.issueForMessage(notice.message_id).id, grandchild.id);
});

test('the walk to the top-level task is bounded and remembered', async (t) => {
  const { w, bot } = await setup(t);
  let parentId = null;
  const chain = [];
  for (let i = 0; i < 14; i += 1) {
    const issue = w.pc.addIssue({ title: `Level ${i}`, status: 'in_progress', parentId });
    chain.push(issue);
    parentId = issue.id;
  }
  await bot.pollOnce();
  w.pc.setStatus(chain.at(-1).id, 'in_review');
  const before = w.pc.requests.length;
  await bot.pollOnce();
  const lookups = w.pc.requests.slice(before).filter((r) => r.method === 'GET' && /\/api\/issues\/[^/]+$/.test(r.path));
  assert.ok(lookups.length <= 10, `${lookups.length} parent lookups`);
  assert.ok(bot.state.roots.size > 0);
});

test('a plain message in a task topic is a comment on the task and gets a reaction', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, thread } = await taskWithTopic(w, bot);
  const update = w.tg.message('Please use the blue logo', { thread });
  const sent = w.tg.sent().length;
  await bot.handleUpdate(update);

  const [comment] = posts(w, '/comments');
  assert.match(comment.path, new RegExp(`/api/issues/${issue.id}/comments$`));
  assert.deepEqual(comment.body, { body: 'Please use the blue logo' });
  assert.deepEqual(w.tg.reactions, [{ messageId: update.message.message_id, emoji: ['\u{1F44D}'] }]);
  assert.equal(w.tg.sent().length, sent, 'no extra message for a posted comment');
});

test('a failed comment in a topic is answered in that topic with the error', async (t) => {
  const { w, bot } = await setup(t);
  const { thread } = await taskWithTopic(w, bot);
  w.pc.failRequests('POST', /\/comments$/, 500, 1);
  const update = w.tg.message('This will fail', { thread });
  await bot.handleUpdate(update);
  const answer = w.tg.lastMessage();
  assert.equal(answer.thread, thread);
  assert.equal(answer.replyTo, update.message.message_id);
  assert.deepEqual(w.tg.reactions, []);
});

test('a reply to a subtask message in the parent topic comments on the subtask', async (t) => {
  const { w, bot } = await setup(t);
  const parent = w.pc.addIssue({ title: 'Big job', status: 'in_progress' });
  const child = w.pc.addIssue({ title: 'Small step', status: 'in_progress', parentId: parent.id });
  await bot.pollOnce();
  w.pc.setStatus(child.id, 'in_review');
  await bot.pollOnce();
  const thread = bot.state.topics.get(parent.id).thread;
  const notice = w.tg.inTopic(thread).find((m) => m.text.includes('Small step'));

  await bot.handleUpdate(w.tg.message('About the small step', { thread, replyTo: notice.message_id }));
  const [comment] = posts(w, '/comments');
  assert.match(comment.path, new RegExp(`/api/issues/${child.id}/comments$`));
  assert.deepEqual(comment.body, { body: 'About the small step' });
});

test('/task without an argument in a topic shows that topic\'s task', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, thread } = await taskWithTopic(w, bot);
  await bot.handleUpdate(w.tg.message('/task', { thread }));
  const view = w.tg.lastMessage();
  assert.equal(view.thread, thread);
  assert.match(view.text, /^<b>Task<\/b> · TST-1$/m);
  assert.equal(bot.state.issueForMessage(view.message_id).id, issue.id);
});

test('buttons on the pinned view work in place and keep the title out of the topic', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, thread } = await taskWithTopic(w, bot);
  const view = w.tg.inTopic(thread).find((m) => m.pinned);

  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Refresh'));
  assert.equal(w.tg.messages.get(view.message_id).text.split('\n')[0], '<b>Task</b> · TST-1');

  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Comment'));
  const prompt = w.tg.lastMessage();
  assert.equal(prompt.thread, thread, 'the comment prompt is in the topic');
  const answer = w.tg.message('From the prompt', { thread, replyTo: prompt.message_id });
  await bot.handleUpdate(answer);
  assert.match(posts(w, '/comments')[0].path, new RegExp(`/api/issues/${issue.id}/comments$`));
  assert.equal(w.tg.reactions.at(-1).messageId, answer.message.message_id);

  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Done'));
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Tap again'));
  assert.equal(w.pc.issues.get(issue.id).status, 'done');
  await bot.pollOnce();
  assert.equal(w.tg.topics.get(thread).name, 'TST-1 Plan the launch (done)');
  assert.equal(w.tg.topics.get(thread).closed, true);
});

test('command replies, lists and settings go to General', async (t) => {
  const { w, bot } = await setup(t);
  await taskWithTopic(w, bot);
  for (const command of ['/status', '/tasks', '/agents', '/settings', '/help']) {
    await bot.handleUpdate(w.tg.message(command));
    assert.equal(w.tg.lastMessage().thread, null, `${command} replied outside a topic`);
  }
});

test('a plain message in an unknown topic offers a task; creating it links and renames the topic', async (t) => {
  const { w, bot } = await setup(t);
  const thread = w.tg.ownerTopic('Ideas');
  await bot.handleUpdate(w.tg.message('Build a paper robot', { thread }));
  const offer = w.tg.lastMessage();
  assert.equal(offer.thread, thread, 'the offer is in the same topic');
  assert.deepEqual(rowsOf(w, offer.message_id)[0].slice(-1), ['Cancel']);
  assert.equal(w.pc.issues.size, 0);

  await bot.handleUpdate(w.tg.tapButton(offer.message_id, 'For Lead'));
  assert.equal(w.pc.issues.size, 1);
  const issue = [...w.pc.issues.values()][0];
  assert.equal(w.tg.topics.get(thread).name, `${issue.identifier} Build a paper robot`);
  assert.equal(bot.state.topics.get(issue.id).thread, thread);
  assert.equal(w.tg.callsTo('createForumTopic').length, 0, 'no second topic was made');
  const view = w.tg.inTopic(thread).find((m) => m.pinned);
  assert.match(view.text, new RegExp(`^<b>Created</b> · ${issue.identifier}$`, 'm'));
  assert.ok(bot.state.isFollowing(issue.id));

  await bot.handleUpdate(w.tg.message('Add a tail', { thread }));
  assert.equal(posts(w, '/comments').length, 1, 'later messages in the topic are comments');
});

test('cancelling the offer in an unknown topic links nothing', async (t) => {
  const { w, bot } = await setup(t);
  const thread = w.tg.ownerTopic('Ideas');
  await bot.handleUpdate(w.tg.message('Build a paper robot', { thread }));
  const offer = w.tg.lastMessage();
  await bot.handleUpdate(w.tg.tapButton(offer.message_id, 'Cancel'));
  assert.equal(w.pc.issues.size, 0);
  assert.equal(bot.state.topics.size, 0);
  assert.equal(w.tg.topics.get(thread).name, 'Ideas');
  assert.equal(w.tg.callsTo('editForumTopic').length, 0);
});

test('/new in General makes a task with its own topic', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/new Write the docs'));
  const issue = [...w.pc.issues.values()][0];
  const thread = bot.state.topics.get(issue.id).thread;
  assert.equal(w.tg.topics.get(thread).name, `${issue.identifier} Write the docs`);
  assert.ok(w.tg.inTopic(thread).some((m) => m.pinned));
  const confirmation = w.tg.lastMessage();
  assert.equal(confirmation.thread, null, 'General gets a short confirmation');
  assert.match(confirmation.text, new RegExp(`^<b>Created</b> · ${issue.identifier} Write the docs$`, 'm'));
});

test('a finished task renames and closes its topic, and reopening restores it', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, thread } = await taskWithTopic(w, bot);
  const topic = w.tg.topics.get(thread);

  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  assert.equal(topic.name, 'TST-1 Plan the launch (done)');
  assert.equal(topic.closed, true);
  assert.equal(bot.state.topics.get(issue.id).closed, 'done');

  w.pc.setStatus(issue.id, 'in_progress');
  await bot.pollOnce();
  assert.equal(topic.name, 'TST-1 Plan the launch');
  assert.equal(topic.closed, false);
  assert.equal(bot.state.topics.get(issue.id).closed, null);

  w.pc.setStatus(issue.id, 'cancelled');
  await bot.pollOnce();
  assert.equal(topic.name, 'TST-1 Plan the launch (cancelled)');
  assert.equal(topic.closed, true);
  assert.equal(w.tg.topics.size, 1);
});

test('a topic that could not be closed is closed by a later poll', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, thread } = await taskWithTopic(w, bot);
  w.tg.failNext('closeForumTopic', 500, { ok: false, error_code: 500, description: 'Internal Server Error' }, 2);
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  await bot.pollOnce();
  assert.equal(w.tg.topics.get(thread).closed, false, 'still open after two failures');
  await bot.pollOnce();
  assert.equal(w.tg.topics.get(thread).closed, true, 'a later poll closed it');
  assert.equal(bot.state.topics.get(issue.id).closed, 'done');
});

test('a deleted topic is made again once and the message is resent there', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, thread } = await taskWithTopic(w, bot);
  w.tg.deleteTopic(thread);
  w.pc.addComment(issue.id, { body: 'Update after the delete' });
  await bot.pollOnce();

  assert.equal(w.tg.callsTo('createForumTopic').length, 2);
  const fresh = bot.state.topics.get(issue.id).thread;
  assert.notEqual(fresh, thread);
  assert.ok(w.tg.inTopic(fresh).some((m) => m.text.includes('Update after the delete')), 'the comment arrived in the new topic');
  assert.ok(w.tg.inTopic(fresh).some((m) => m.pinned), 'the view was pinned again');
});

test('a topic that keeps vanishing is made again only once per message', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, thread } = await taskWithTopic(w, bot);
  w.tg.deleteTopic(thread);
  w.tg.failNext('sendMessage', 400, THREAD_GONE, Infinity);
  w.pc.addComment(issue.id, { body: 'Doomed' });
  await assert.rejects(bot.pollOnce(), /message thread not found/);
  assert.ok(w.tg.callsTo('createForumTopic').length <= 2, 'no creation loop');
  assert.ok(w.tg.callsTo('sendMessage').length <= 8, 'no send loop');
});

test('when a topic cannot be created the message goes to General, with one warning an hour', async (t) => {
  const { w, bot } = await setup(t);
  w.tg.failNext('createForumTopic', 400, { ok: false, error_code: 400, description: 'Bad Request: not enough rights to create a topic' }, Infinity);
  const first = w.pc.addIssue({ title: 'First job', status: 'in_progress' });
  const second = w.pc.addIssue({ title: 'Second job', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(first.id, 'in_review');
  w.pc.setStatus(second.id, 'in_review');
  await bot.pollOnce();

  const notices = w.tg.sent().filter((m) => m.text.includes('In review'));
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    assert.equal(notice.thread, null);
    assert.match(notice.text, /^<b>In review<\/b> · TST-\d (First|Second) job$/m, 'outside a topic the title stays');
  }
  assert.equal(bot.state.topics.size, 0);
  assert.equal(logText(w).split('could not create a topic').length - 1, 1);
});

test('with topics off in the config everything stays in one chat', async (t) => {
  const { w, bot } = await setup(t, { config: { topics: 'off' } });
  const issue = w.pc.addIssue({ title: 'Plan the launch', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  await bot.handleUpdate(w.tg.message('/task TST-1'));
  await bot.handleUpdate(w.tg.message('Written inside a topic', { thread: 777 }));

  for (const name of ['createForumTopic', 'editForumTopic', 'closeForumTopic', 'pinChatMessage', 'setMessageReaction']) {
    assert.equal(w.tg.callsTo(name).length, 0, name);
  }
  for (const message of w.tg.sent()) assert.equal(message.thread, null);
  assert.match(w.tg.findMessage('In review').text, /^<b>In review<\/b> · TST-1 Plan the launch$/m);
  assert.equal(bot.state.topics.size, 0);
});

test('in a private chat the topic calls are never made', async (t) => {
  const w = await startWorld();
  t.after(() => w.close());
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Plan the launch', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  assert.match(logText(w), /^info topics off: not a forum$/m);
  assert.match(w.tg.findMessage('Done').text, /^<b>Done<\/b> · TST-1 Plan the launch$/m);
  assert.equal(w.tg.callsTo('createForumTopic').length, 0);
  assert.deepEqual(w.tg.reactions, []);
});

test('a card for a subtask is sent into the topic of its top-level task', async (t) => {
  const { w, bot } = await setup(t);
  const parent = w.pc.addIssue({ title: 'Big job', status: 'in_progress' });
  const child = w.pc.addIssue({ title: 'Small step', status: 'in_review', parentId: parent.id });
  await bot.pollOnce();
  w.pc.addInteraction(child.id, { kind: 'request_confirmation', payload: { version: 1, prompt: 'Ship it?', acceptLabel: 'Ship', rejectLabel: 'Hold' } });
  await bot.pollOnce();
  const thread = bot.state.topics.get(parent.id).thread;
  const card = w.tg.inTopic(thread).find((m) => m.text.includes('Ship it?'));
  assert.ok(card, 'the card is in the parent topic');
  assert.match(card.text, /^<b>Approval<\/b> · TST-2 Small step$/m);
});

test('topic names are cut to Telegram\'s limit, suffix included', () => {
  const long = 'x'.repeat(300);
  assert.equal(topicName('TST-1', long).length, 128);
  assert.ok(topicName('TST-1', long, ' (cancelled)').endsWith(' (cancelled)'));
  assert.equal(topicName('TST-1', long, ' (cancelled)').length, 128);
  assert.equal(topicName('TST-1', 'A  title\nwith   gaps'), 'TST-1 A title with gaps');
  assert.equal(topicName('TST-1', ''), 'TST-1');
});

test('the icon colour is stable, one of the six allowed values, and the first without a project', () => {
  assert.equal(iconColor(null), ICON_COLORS[0]);
  assert.equal(iconColor('project-a'), iconColor('project-a'));
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const colour = iconColor(`project-${i}`);
    assert.ok(ICON_COLORS.includes(colour));
    seen.add(colour);
  }
  assert.ok(seen.size >= 5, 'projects spread over the colours');
});
