import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { startWorld } from './helpers.js';
import { iconProblems } from './no-icons.js';
import { iconColor } from '../src/topics.js';

const GROUP_ID = -1001234567890;
const OLD_ICON = 'old-icon-1';

async function setup(t, { telegram, config } = {}) {
  const w = await startWorld({ telegram: { chatId: GROUP_ID, forum: true, ...telegram }, config });
  t.after(() => w.close());
  return { w, bot: await w.primedBot() };
}

const editsOf = (w) => w.tg.callsTo('editForumTopic').map((c) => c.params);
const logText = (w) => w.allLogText();

// A task of a project in review, which makes its topic.
async function taskIn(w, bot, project, title = 'A job') {
  const issue = w.pc.addIssue({ title, status: 'in_progress', projectId: project?.id ?? null });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  assert.ok(bot.state.topics.get(issue.id), 'the topic exists');
  return issue;
}

// The state file as a version with icons wrote it: `projectIcons` by project, `topicIcons` by task, and the icons
// shown in the fake chat.
function writeIconState(w, { projectIcons, topicIcons = {}, closed = [] }) {
  const saved = JSON.parse(fs.readFileSync(w.statePath, 'utf8'));
  saved.projectIcons = projectIcons;
  for (const [rootId, topic] of Object.entries(saved.topics)) {
    const iconId = topicIcons[rootId] ?? '';
    saved.topics[rootId] = { ...topic, projectId: null, iconId, ...(closed.includes(rootId) ? { closed: 'done', suffixed: false, closedAt: 1 } : {}) };
    w.tg.topics.get(topic.thread).iconId = iconId;
  }
  fs.writeFileSync(w.statePath, JSON.stringify(saved));
  return saved;
}

test('the icon check flags an icon anywhere but a bare removal edit', () => {
  const chat = { chat_id: GROUP_ID, message_thread_id: 7 };
  const call = (method, params) => ({ method, params });
  assert.deepEqual(iconProblems([call('editForumTopic', { ...chat, icon_custom_emoji_id: '' })]), [], 'a bare removal is allowed');
  assert.equal(iconProblems([call('editForumTopic', { ...chat, name: 'A', icon_custom_emoji_id: '' })]).length, 1, 'not together with a rename');
  assert.equal(iconProblems([call('editForumTopic', { ...chat, icon_custom_emoji_id: 'x' })]).length, 1);
  assert.equal(iconProblems([call('createForumTopic', { chat_id: GROUP_ID, name: 'A', icon_custom_emoji_id: '' })]).length, 1);
  assert.equal(iconProblems([call('sendMessage', { reply_markup: { inline_keyboard: [[{ text: 'A', icon_custom_emoji_id: 'x' }]] } })]).length, 1);
  assert.equal(iconProblems([call('getForumTopicIconStickers', {})]).length, 1);
  assert.deepEqual(iconProblems([call('createForumTopic', { chat_id: GROUP_ID, name: 'A', icon_color: 7322096 })]), []);
});

test('a new topic gets its project colour, a name and no icon', async (t) => {
  const { w, bot } = await setup(t);
  const [one, two] = ['One', 'Two'].map((name) => w.pc.addProject({ name }));
  await taskIn(w, bot, one);
  await taskIn(w, bot, two);
  await taskIn(w, bot, null, 'No project');
  const created = w.tg.callsTo('createForumTopic').map((c) => c.params);
  assert.equal(created.length, 3);
  assert.deepEqual(created.map((p) => p.icon_color), [iconColor(one.id), iconColor(two.id), iconColor(null)]);
  for (const params of created) assert.deepEqual(Object.keys(params).sort(), ['chat_id', 'icon_color', 'name']);
  assert.deepEqual(iconProblems(w.tg.calls), []);
  assert.deepEqual(w.tg.callsTo('getForumTopicIconStickers'), []);
});

test('moving a task to another project edits nothing', async (t) => {
  const { w, bot } = await setup(t);
  const [one, two] = ['One', 'Two'].map((name) => w.pc.addProject({ name }));
  const issue = await taskIn(w, bot, one);
  w.pc.setProject(issue.id, two.id);
  await bot.pollOnce();
  await bot.pollOnce();
  assert.deepEqual(editsOf(w), []);
});

test('a topic the owner started is renamed with the name alone', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const thread = w.tg.ownerTopic('Ideas');
  await bot.handleUpdate(w.tg.message('Build a paper robot', { thread }));
  await bot.handleUpdate(w.tg.tapButton(w.tg.lastMessage().message_id, 'For Lead'));
  await bot.handleUpdate(w.tg.tapButton(w.tg.lastMessage().message_id, project.name));
  const issue = [...w.pc.issues.values()][0];
  assert.equal(issue.projectId, project.id);
  assert.deepEqual(editsOf(w), [{ chat_id: GROUP_ID, message_thread_id: thread, name: `${issue.identifier} Build a paper robot` }]);
  assert.deepEqual(Object.keys(bot.state.topics.get(issue.id)).sort(), ['closed', 'closedAt', 'identifier', 'suffixed', 'thread', 'title']);
});

test('the project list shows All projects and no Icon, with topics on', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  w.pc.addIssue({ title: 'Task', status: 'todo', projectId: project.id });
  await bot.handleUpdate(w.tg.message('/projects'));
  await bot.handleUpdate(w.tg.tapButton(w.tg.lastMessage().message_id, project.name));
  const view = w.tg.lastMessage();
  const labels = w.tg.buttons(view.message_id).map((b) => b.text);
  assert.ok(labels.includes('All projects'));
  assert.ok(!labels.includes('Icon'));
  assert.ok(!w.tg.buttons(view.message_id).some((b) => /^L:[is]:/.test(b.callback_data)));

  // Buttons of a picker that was sent before the update: answered, nothing changes.
  const calls = w.tg.calls.length;
  for (const data of [`L:i:a:0:${project.id}`, `L:s:a:3:${project.id}`, `L:s:a:n:${project.id}`]) {
    await bot.handleUpdate(w.tg.tap(view.message_id, data));
    assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  }
  assert.equal(w.tg.calls.length, calls + 3, 'only the three answers');
  assert.equal(w.tg.messages.get(view.message_id).edits, 0);
  assert.doesNotMatch(logText(w), /error/i);
});

test('an upgrade from a state with icons removes the icon of each open topic once and drops the icon fields', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const iconed = await taskIn(w, bot, project, 'With an icon');
  const plain = await taskIn(w, bot, project, 'Without an icon');
  const finished = await taskIn(w, bot, project, 'Finished');
  bot.stop();
  const saved = writeIconState(w, { projectIcons: { [project.id]: OLD_ICON }, topicIcons: { [iconed.id]: OLD_ICON, [finished.id]: OLD_ICON }, closed: [finished.id] });
  const editsBefore = editsOf(w).length;

  const upgraded = w.makeBot();
  assert.equal(upgraded.state.topics.get(iconed.id).iconId, OLD_ICON, 'the icon is remembered until it is removed');
  assert.equal(upgraded.state.topics.get(finished.id).iconId, undefined, 'a closed topic is not touched');
  await upgraded.pollOnce();
  await upgraded.pollOnce();
  await upgraded.pollOnce();

  assert.deepEqual(editsOf(w).slice(editsBefore), [{ chat_id: GROUP_ID, message_thread_id: saved.topics[iconed.id].thread, icon_custom_emoji_id: '' }]);
  assert.equal(w.tg.topics.get(saved.topics[iconed.id].thread).iconId, '', 'the icon is gone');
  assert.equal(w.tg.topics.get(saved.topics[finished.id].thread).iconId, OLD_ICON, 'the closed topic keeps its icon');
  assert.equal(w.tg.topics.get(saved.topics[plain.id].thread).iconId, '');

  const after = JSON.parse(fs.readFileSync(w.statePath, 'utf8'));
  assert.equal('projectIcons' in after, false);
  for (const topic of Object.values(after.topics)) {
    assert.equal('iconId' in topic, false);
    assert.equal('projectId' in topic, false);
  }
  assert.equal(upgraded.state.projectIcons, undefined);
  assert.deepEqual(iconProblems(w.tg.calls), []);

  // A restart afterwards does not edit again.
  upgraded.stop();
  await w.makeBot().pollOnce();
  assert.equal(editsOf(w).length, editsBefore + 1);
});

test('a state file whose icons are all empty causes no edit and loses the icon fields on the next save', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const issue = await taskIn(w, bot, project);
  bot.stop();
  writeIconState(w, { projectIcons: { [project.id]: '' } });
  const editsBefore = editsOf(w).length;

  const upgraded = w.makeBot();
  await upgraded.pollOnce();
  await upgraded.pollOnce();
  upgraded.state.save();
  assert.equal(editsOf(w).length, editsBefore);
  const after = JSON.parse(fs.readFileSync(w.statePath, 'utf8'));
  assert.equal('projectIcons' in after, false);
  assert.equal('iconId' in after.topics[issue.id], false);
  assert.equal('projectId' in after.topics[issue.id], false);
});

test('a topic that is gone is dropped, and a refused removal is logged once and not tried again', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const gone = await taskIn(w, bot, project, 'Gone');
  const refused = await taskIn(w, bot, project, 'Refused');
  bot.stop();
  const saved = writeIconState(w, { projectIcons: { [project.id]: OLD_ICON }, topicIcons: { [gone.id]: OLD_ICON, [refused.id]: OLD_ICON } });
  w.tg.deleteTopic(saved.topics[gone.id].thread);
  w.tg.failNext('editForumTopic', 400, { ok: false, error_code: 400, description: 'Bad Request: not enough rights to manage topics' }, 1, (p) => p.message_thread_id === saved.topics[refused.id].thread);
  const editsBefore = editsOf(w).length;

  const upgraded = w.makeBot();
  await upgraded.pollOnce();
  await upgraded.pollOnce();
  assert.equal(upgraded.state.topics.has(gone.id), false);
  assert.equal(upgraded.state.topics.get(refused.id).iconId, undefined);
  assert.equal(editsOf(w).length - editsBefore, 2, 'one edit for each');
  assert.equal(logText(w).split('could not remove the icon of a topic').length - 1, 1);
});

test('a lost connection leaves the icon for the next poll', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const issue = await taskIn(w, bot, project);
  bot.stop();
  const saved = writeIconState(w, { projectIcons: { [project.id]: OLD_ICON }, topicIcons: { [issue.id]: OLD_ICON } });
  w.tg.failNext('editForumTopic', 502, { ok: false, error_code: 502, description: 'Bad Gateway' });

  const upgraded = w.makeBot();
  await upgraded.pollOnce();
  assert.equal(upgraded.state.topics.get(issue.id).iconId, OLD_ICON);
  assert.equal(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).topics[issue.id].iconId, OLD_ICON);
  assert.equal(w.tg.topics.get(saved.topics[issue.id].thread).iconId, OLD_ICON);
  await upgraded.pollOnce();
  assert.equal(upgraded.state.topics.get(issue.id).iconId, undefined);
  assert.equal(w.tg.topics.get(saved.topics[issue.id].thread).iconId, '');
});
