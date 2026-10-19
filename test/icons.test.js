import assert from 'node:assert/strict';
import test from 'node:test';
import { startWorld } from './helpers.js';

const GROUP_ID = -1001234567890;
const HOUR = 60 * 60 * 1000;
const BLANK = ' ';
const FOLDER = '\u{1F4C1}';
const LAPTOP = '\u{1F4BB}';
const MEMO = '\u{1F4DD}';
const BOLT = '⚡';
const BOOKS = '\u{1F4DA}';
const PUZZLE = '\u{1F9E9}';

const sticker = (emoji, index) => ({ file_id: `f${index}`, file_unique_id: `u${index}`, type: 'custom_emoji', width: 512, height: 512, is_animated: false, is_video: false, emoji, custom_emoji_id: `set-${index}` });
const stickers = (list) => list.map(sticker);

async function setup(t, { telegram, config, now, prime = true } = {}) {
  const w = await startWorld({ telegram: { chatId: GROUP_ID, forum: true, ...telegram }, config });
  t.after(() => w.close());
  const bot = prime ? await w.primedBot(now ? { now } : undefined) : w.makeBot(now ? { now } : undefined);
  return { w, bot };
}

const idOf = (w, emoji) => w.tg.iconStickers.find((s) => s.emoji.replaceAll('️', '') === emoji).custom_emoji_id;
const creations = (w) => w.tg.callsTo('createForumTopic').map((c) => c.params);
const iconEdits = (w) => w.tg.callsTo('editForumTopic').filter((c) => c.params.icon_custom_emoji_id !== undefined);
const logText = (w) => w.allLogText();

// A task of a project that has an open topic (the in-review message creates it).
async function taskIn(w, bot, project, title = 'A job') {
  const issue = w.pc.addIssue({ title, status: 'in_progress', projectId: project?.id ?? null });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  assert.ok(bot.state.topics.get(issue.id), 'the topic exists');
  return issue;
}

test('a project takes the first preferred icon that is in the set and unused, ignoring U+FE0F; none left means none', async (t) => {
  const set = stickers(['\u{1F4F0}', `${BOLT}️`, '\u{1F4AC}', BOOKS, PUZZLE]);
  const { w, bot } = await setup(t, { telegram: { iconStickers: set } });
  const projects = ['One', 'Two', 'Three', 'Four'].map((name) => w.pc.addProject({ name }));
  for (const project of projects) await taskIn(w, bot, project, `Job of ${project.name}`);

  assert.deepEqual(
    creations(w).map((params) => params.icon_custom_emoji_id),
    ['set-1', 'set-3', 'set-4', undefined],
    'bolt (written with U+FE0F), books and puzzle in the preferred order; the fourth project has none left',
  );
  assert.deepEqual([...bot.state.projectIcons], projects.map((p, i) => [p.id, ['set-1', 'set-3', 'set-4', ''][i]]));
  assert.equal(new Set(creations(w).map((p) => p.icon_custom_emoji_id).filter(Boolean)).size, 3, 'no two projects share an icon');
  for (const params of creations(w)) assert.ok(ICON_COLORS_OK.includes(params.icon_color), 'the topic colour is kept');
});
const ICON_COLORS_OK = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];

test('the default is the first of the preferred list that Telegram has', async (t) => {
  const { w, bot } = await setup(t);
  const [one, two, three] = ['One', 'Two', 'Three'].map((name) => w.pc.addProject({ name }));
  await taskIn(w, bot, one);
  await taskIn(w, bot, two);
  await taskIn(w, bot, three);
  assert.deepEqual(
    creations(w).map((params) => params.icon_custom_emoji_id),
    [idOf(w, FOLDER), idOf(w, LAPTOP), idOf(w, MEMO)],
  );
});

test('a task without a project gets a topic without an icon', async (t) => {
  const { w, bot } = await setup(t);
  await taskIn(w, bot, null);
  assert.equal(creations(w)[0].icon_custom_emoji_id, undefined);
  assert.equal(bot.state.topics.values().next().value.iconId, '');
  assert.equal(bot.state.projectIcons.size, 0);
});

test('the icons are read once when topics come on', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'One' });
  await taskIn(w, bot, project);
  await taskIn(w, bot, project);
  assert.equal(w.tg.callsTo('getForumTopicIconStickers').length, 1);
});

test('a chosen icon is kept for the project and a restart keeps it', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'One' });
  await taskIn(w, bot, project);
  const restarted = w.makeBot();
  assert.equal(restarted.state.projectIcons.get(project.id), idOf(w, FOLDER));
  await restarted.pollOnce();
  assert.equal(iconEdits(w).length, 0, 'nothing to change after a restart');
});

test('without the icon list topics are made without icons; the list is read again at most once an hour', async (t) => {
  let clock = Date.now();
  const { w, bot } = await setup(t, { now: () => clock, prime: false });
  w.tg.failNext('getForumTopicIconStickers', 500, { ok: false, error_code: 500, description: 'Internal Server Error' }, Infinity);
  await bot.pollOnce();
  const project = w.pc.addProject({ name: 'One' });
  const issue = await taskIn(w, bot, project);
  assert.equal(creations(w)[0].icon_custom_emoji_id, undefined);
  assert.equal(bot.state.projectIcons.size, 0, 'nothing is remembered without the list');
  assert.match(logText(w), /warn could not read the topic icons/);
  assert.equal(w.tg.callsTo('getForumTopicIconStickers').length, 1, 'tried once so far');

  clock += HOUR - 1000;
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('getForumTopicIconStickers').length, 1, 'not within the hour');
  clock += 2000;
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('getForumTopicIconStickers').length, 2, 'again after an hour');

  w.tg.clearFailures();
  clock += HOUR + 1;
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('getForumTopicIconStickers').length, 3);
  assert.equal(bot.state.projectIcons.get(project.id), idOf(w, FOLDER));
  assert.equal(iconEdits(w).length, 1, 'the open topic gets its icon once the list is there');
  assert.equal(iconEdits(w)[0].params.message_thread_id, bot.state.topics.get(issue.id).thread);
  await bot.pollOnce();
  assert.equal(iconEdits(w).length, 1);
});

test('a refused icon does not keep a task out of its topic', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'One' });
  w.tg.failNext('createForumTopic', 400, { ok: false, error_code: 400, description: 'Bad Request: DOCUMENT_INVALID' }, 1);
  await taskIn(w, bot, project);
  assert.equal(creations(w).length, 2);
  assert.equal(creations(w)[0].icon_custom_emoji_id, idOf(w, FOLDER));
  assert.equal(creations(w)[1].icon_custom_emoji_id, undefined, 'tried again without the icon');
  assert.equal(bot.state.topics.size, 1);
});

test('moving a task to another project changes its topic icon exactly once', async (t) => {
  const { w, bot } = await setup(t);
  const [one, two] = ['One', 'Two'].map((name) => w.pc.addProject({ name }));
  const issue = await taskIn(w, bot, one);
  const thread = bot.state.topics.get(issue.id).thread;
  assert.equal(iconEdits(w).length, 0, 'a new topic is made with its icon, not edited');

  w.pc.setProject(issue.id, two.id);
  await bot.pollOnce();
  await bot.pollOnce();
  assert.equal(iconEdits(w).length, 1);
  assert.deepEqual(iconEdits(w)[0].params, { chat_id: GROUP_ID, message_thread_id: thread, icon_custom_emoji_id: bot.state.projectIcons.get(two.id) });
  assert.equal(w.tg.topics.get(thread).iconId, idOf(w, LAPTOP));
  assert.equal(bot.state.topics.get(issue.id).projectId, two.id);

  w.pc.setProject(issue.id, null);
  await bot.pollOnce();
  assert.equal(iconEdits(w).length, 2);
  assert.equal(iconEdits(w)[1].params.icon_custom_emoji_id, '', 'no project removes the icon');
  assert.equal(w.tg.topics.get(thread).iconId, '');
  await bot.pollOnce();
  assert.equal(iconEdits(w).length, 2);
});

test('a task that moves to a project with the same icon is not edited, and a closed topic never is', async (t) => {
  const { w, bot } = await setup(t);
  const [one, two] = ['One', 'Two'].map((name) => w.pc.addProject({ name }));
  bot.state.projectIcons.set(one.id, '');
  bot.state.projectIcons.set(two.id, '');
  const issue = await taskIn(w, bot, one);
  w.pc.setProject(issue.id, two.id);
  await bot.pollOnce();
  assert.equal(iconEdits(w).length, 0, 'both have no icon');

  const finished = await taskIn(w, bot, w.pc.addProject({ name: 'Three' }), 'Finished');
  w.pc.setStatus(finished.id, 'done');
  await bot.pollOnce();
  assert.equal(bot.state.topics.get(finished.id).closed, 'done');
  w.pc.setProject(finished.id, one.id);
  bot.state.projectIcons.set(one.id, idOf(w, MEMO));
  await bot.pollOnce();
  assert.equal(iconEdits(w).length, 0, 'closed topics keep the icon they had');
});

// A project list with one open task, the project opened, and the message that shows it.
async function openProject(w, bot, project) {
  await bot.handleUpdate(w.tg.message('/projects'));
  await bot.handleUpdate(w.tg.tapButton(w.tg.lastMessage().message_id, project.name));
  return w.tg.lastMessage();
}

const labels = (w, id) => w.tg.buttons(id).map((b) => b.text);
const pickerButtons = (w, id) => w.tg.buttons(id).filter((b) => b.callback_data.startsWith('L:s:') && !b.callback_data.includes(':n:'));
const tapData = (w, bot, id, data) => bot.handleUpdate(w.tg.tap(id, data));

test('the Icon button sits next to All projects in a project list, and only when topics are on', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  w.pc.addIssue({ title: 'Task', status: 'todo', projectId: project.id });
  const view = await openProject(w, bot, project);
  const rows = w.tg.messages.get(view.message_id).markup.inline_keyboard.map((row) => row.map((b) => b.text));
  assert.deepEqual(rows.at(-1), ['All projects', 'Icon']);

  const off = await setup(t, { telegram: { forum: false, chatId: undefined } });
  const other = off.w.pc.addProject({ name: 'Alpha' });
  const plainView = await openProject(off.w, off.bot, other);
  assert.deepEqual(labels(off.w, plainView.message_id).slice(-1), ['All projects']);
});

test('the picker shows the icons themselves on the buttons, 8 to a row, with the current one blue, No icon and Back', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const view = await openProject(w, bot, project);
  await tapData(w, bot, view.message_id, w.tg.buttons(view.message_id).find((b) => b.text === 'Icon').callback_data);

  const message = w.tg.messages.get(view.message_id);
  assert.equal(message.text, '<b>Icon</b> · Alpha');
  const rows = message.markup.inline_keyboard;
  const grid = rows.slice(0, -1);
  assert.deepEqual(grid.map((row) => row.length), [8, 8, 2], '18 icons in rows of 8');
  for (const [index, button] of grid.flat().entries()) {
    assert.equal(button.text, BLANK);
    assert.equal(button.icon_custom_emoji_id, w.tg.iconStickers[index].custom_emoji_id);
    assert.equal(button.callback_data, `L:s:a:${index}:${project.id}`);
  }
  assert.deepEqual(rows.at(-1).map((b) => b.text), ['No icon', 'Back']);
  assert.equal(rows.at(-1)[1].callback_data, `L:t:a:0:${project.id}`);
  assert.deepEqual(
    grid.flat().filter((b) => b.style === 'primary').map((b) => b.icon_custom_emoji_id),
    [bot.state.projectIcons.get(project.id)],
    'the project icon is blue',
  );
  assert.match(logText(w), /^info icon picker: buttons show the topic icons$/m);
  assert.equal(logText(w).split('icon picker:').length - 1, 1);
  assert.equal(w.tg.callsTo('editMessageText').filter((c) => c.params.message_id === view.message_id).length, 1, 'the picker is one edit of the list');
});

test('without Premium the same grid comes again with emoji labels until the bot restarts', async (t) => {
  const { w, bot } = await setup(t, { telegram: { ownerPremium: false } });
  const project = w.pc.addProject({ name: 'Alpha' });
  const view = await openProject(w, bot, project);
  const opener = w.tg.buttons(view.message_id).find((b) => b.text === 'Icon').callback_data;
  const editsOf = () => w.tg.callsTo('editMessageText').filter((c) => c.params.message_id === view.message_id);
  const before = editsOf().length;
  await tapData(w, bot, view.message_id, opener);

  const tries = editsOf().slice(before);
  assert.equal(tries.length, 2, 'refused once, then the plain grid');
  assert.ok(tries[0].params.reply_markup.inline_keyboard.flat().some((b) => b.icon_custom_emoji_id));
  assert.ok(!tries[1].params.reply_markup.inline_keyboard.flat().some((b) => b.icon_custom_emoji_id !== undefined));
  assert.deepEqual(tries[1].params.reply_markup.inline_keyboard.map((row) => row.length), [8, 8, 2, 2]);
  assert.deepEqual(
    pickerButtons(w, view.message_id).map((b) => b.text),
    w.tg.iconStickers.map((s) => s.emoji),
    'the labels are the emoji of the icons',
  );
  assert.ok(!w.tg.callbackAnswers.at(-1).text, 'the tap was answered quietly');
  assert.match(logText(w), /^info icon picker: Telegram refused buttons with icons, so they carry emoji labels until the bot restarts$/m);
  assert.equal(logText(w).split('icon picker:').length - 1, 1, 'one info line');

  // Back and open again: no new attempt with icons.
  await tapData(w, bot, view.message_id, w.tg.buttons(view.message_id).find((b) => b.text === 'Back').callback_data);
  const afterBack = editsOf().length;
  await tapData(w, bot, view.message_id, opener);
  const again = editsOf().slice(afterBack);
  assert.equal(again.length, 1, 'one edit for the picker, no retry');
  assert.ok(!again.some((c) => c.params.reply_markup.inline_keyboard.flat().some((b) => b.icon_custom_emoji_id !== undefined)));

  // After a restart the buttons try the icons again.
  w.tg.setOwnerPremium(true);
  const restarted = w.makeBot();
  await restarted.pollOnce();
  await restarted.handleUpdate(w.tg.tap(view.message_id, `L:i:a:0:${project.id}`));
  assert.ok(w.tg.buttons(view.message_id).some((b) => b.icon_custom_emoji_id));
});

test('when both keyboards fail the buttons keep trying icons first', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const view = await openProject(w, bot, project);
  const opener = w.tg.buttons(view.message_id).find((b) => b.text === 'Icon').callback_data;
  w.tg.deleteMessage(view.message_id);
  await tapData(w, bot, view.message_id, opener);
  assert.equal(bot.icons.plainLabels, false, 'the message was the problem, not the icons');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Something went wrong, try again');
  assert.ok(!logText(w).includes('icon picker: Telegram refused'));
});

test('a pick saves the icon, changes the open topics of the project once, and returns to the list', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const other = w.pc.addProject({ name: 'Beta' });
  const mine = await taskIn(w, bot, project, 'In Alpha');
  const finished = await taskIn(w, bot, project, 'Finished in Alpha');
  const elsewhere = await taskIn(w, bot, other, 'In Beta');
  w.pc.setStatus(finished.id, 'done');
  await bot.pollOnce();
  const closedThread = bot.state.topics.get(finished.id).thread;

  const view = await openProject(w, bot, project);
  await tapData(w, bot, view.message_id, w.tg.buttons(view.message_id).find((b) => b.text === 'Icon').callback_data);
  const target = pickerButtons(w, view.message_id).find((b) => b.callback_data.includes(`:${w.tg.iconStickers.findIndex((s) => s.emoji === '\u{1F525}')}:`));
  await tapData(w, bot, view.message_id, target.callback_data);

  const fire = idOf(w, '\u{1F525}');
  assert.equal(bot.state.projectIcons.get(project.id), fire);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Icon set');
  assert.deepEqual(iconEdits(w).map((c) => [c.params.message_thread_id, c.params.icon_custom_emoji_id]), [[bot.state.topics.get(mine.id).thread, fire]]);
  assert.equal(w.tg.topics.get(bot.state.topics.get(mine.id).thread).iconId, fire);
  assert.equal(w.tg.topics.get(closedThread).iconId, idOf(w, FOLDER), 'a closed topic is not touched');
  assert.equal(w.tg.topics.get(bot.state.topics.get(elsewhere.id).thread).iconId, idOf(w, LAPTOP), 'neither is another project');
  assert.match(w.tg.messages.get(view.message_id).text, /^<b>Open tasks<\/b> · All open · Alpha · page 1$/, 'back in the task list');
  assert.deepEqual(labels(w, view.message_id).slice(-2), ['All projects', 'Icon']);

  await bot.pollOnce();
  assert.equal(iconEdits(w).length, 1, 'the next poll finds nothing to change');

  // A new topic of the project is made with the new icon.
  await taskIn(w, bot, project, 'Second in Alpha');
  assert.equal(creations(w).at(-1).icon_custom_emoji_id, fire);
});

test('No icon saves an empty icon and removes it from the open topics', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const issue = await taskIn(w, bot, project);
  const view = await openProject(w, bot, project);
  await tapData(w, bot, view.message_id, w.tg.buttons(view.message_id).find((b) => b.text === 'Icon').callback_data);
  const noIcon = w.tg.buttons(view.message_id).find((b) => b.text === 'No icon');
  assert.equal(noIcon.style, undefined, 'a project with an icon does not mark No icon');
  await tapData(w, bot, view.message_id, noIcon.callback_data);

  assert.equal(bot.state.projectIcons.get(project.id), '');
  assert.equal(iconEdits(w).at(-1).params.icon_custom_emoji_id, '');
  assert.equal(w.tg.topics.get(bot.state.topics.get(issue.id).thread).iconId, '');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Icon set');

  // Opened again, only No icon is blue.
  await tapData(w, bot, view.message_id, w.tg.buttons(view.message_id).find((b) => b.text === 'Icon').callback_data);
  assert.equal(w.tg.buttons(view.message_id).find((b) => b.text === 'No icon').style, 'primary');
  assert.equal(w.tg.buttons(view.message_id).filter((b) => b.style === 'primary').length, 1);
  await bot.pollOnce();
  assert.equal(w.tg.topics.get(bot.state.topics.get(issue.id).thread).iconId, '', 'the default is not applied again');
});

test('past 48 icons the picker pages with the arrows and every callback stays within 64 bytes', async (t) => {
  const many = stickers(Array.from({ length: 60 }, (_, i) => ['\u{1F4C1}', '\u{1F4BB}', '\u{1F4DD}', '\u{1F4A1}'][i % 4]));
  const { w, bot } = await setup(t, { telegram: { iconStickers: many } });
  const project = w.pc.addProject({ name: 'A project with a rather long name that is cut for the picker heading because it is long' });
  const view = await openProject(w, bot, { name: 'A project with a rather' });
  await tapData(w, bot, view.message_id, w.tg.buttons(view.message_id).find((b) => b.text === 'Icon').callback_data);

  const shape = () => w.tg.messages.get(view.message_id).markup.inline_keyboard.map((row) => row.length);
  assert.deepEqual(shape(), [...Array(6).fill(8), 1, 2], 'six rows, the next arrow, No icon and Back');
  assert.deepEqual(w.tg.buttons(view.message_id).filter((b) => b.text === '▶' || b.text === '◀').map((b) => b.text), ['▶']);
  await tapData(w, bot, view.message_id, w.tg.buttons(view.message_id).find((b) => b.text === '▶').callback_data);
  assert.deepEqual(shape(), [8, 4, 1, 2], 'the other twelve and the previous arrow');
  assert.equal(w.tg.buttons(view.message_id).find((b) => b.text === '◀').callback_data, `L:i:a:0:${project.id}`);
  for (const button of w.tg.buttons(view.message_id)) assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);

  const last = pickerButtons(w, view.message_id).at(-1);
  assert.equal(last.callback_data, `L:s:a:59:${project.id}`);
  await tapData(w, bot, view.message_id, last.callback_data);
  assert.equal(bot.state.projectIcons.get(project.id), 'set-59');
});

test('a stale or invalid picker button is answered and changes nothing', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const view = await openProject(w, bot, project);
  const before = [...bot.state.projectIcons];
  await tapData(w, bot, view.message_id, `L:s:a:999:${project.id}`);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await tapData(w, bot, view.message_id, `L:s:a:x:${project.id}`);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await tapData(w, bot, view.message_id, `L:i:a:x:${project.id}`);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Icons are not available, try again later');
  assert.deepEqual([...bot.state.projectIcons], before);
});

test('the picker says so when there are no icons', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Alpha' });
  const view = await openProject(w, bot, project);
  const opener = w.tg.buttons(view.message_id).find((b) => b.text === 'Icon').callback_data;
  bot.icons.list = [];
  await tapData(w, bot, view.message_id, opener);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Icons are not available, try again later');
  assert.match(w.tg.messages.get(view.message_id).text, /^<b>Open tasks<\/b>/);
});
