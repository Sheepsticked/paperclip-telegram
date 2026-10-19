import assert from 'node:assert/strict';
import test from 'node:test';
import { PaperclipError } from '../src/paperclip.js';
import { UI_BASE_URL, confirmPayload, startWorld } from './helpers.js';

const GROUP_ID = -1001234567890;
const HOUR = 60 * 60 * 1000;
const NOTHING = 'Nothing waiting or running.';

async function setup(t, { telegram, config, now } = {}) {
  const w = await startWorld({ telegram: { chatId: GROUP_ID, forum: true, ...telegram }, config });
  t.after(() => w.close());
  const bot = await w.primedBot(now ? { now } : undefined);
  return { w, bot };
}

const boardOf = (w, bot) => w.tg.messages.get(bot.state.boardMessageId);
const boardEdits = (w, bot) => w.tg.callsTo('editMessageText').filter((c) => c.params.message_id === bot.state.boardMessageId);
const taskUrl = (issue) => `${UI_BASE_URL}/TST/issues/${issue.identifier}`;
const topicUrl = (bot, issue) => `https://t.me/c/1234567890/${bot.state.topics.get(issue.id).thread}`;
const line = (url, issue, title = issue.title) => `<a href="${url}">${issue.identifier} ${title}</a>`;

test('the board is sent once to General, silently, and pinned', async (t) => {
  const { w, bot } = await setup(t);
  const board = boardOf(w, bot);
  assert.equal(board.text, NOTHING);
  assert.equal(board.thread, null);
  assert.equal(board.silent, true);
  assert.deepEqual(board.pinned, { silent: true });
  const call = w.tg.callsTo('sendMessage')[0].params;
  assert.deepEqual(call.link_preview_options, { is_disabled: true });
  assert.equal(call.reply_markup, undefined, 'no buttons');

  await bot.pollOnce();
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
  assert.equal(w.tg.callsTo('pinChatMessage').length, 1);
  assert.equal(w.tg.callsTo('editMessageText').length, 0);
});

test('the board keeps its message id across a restart and is not sent again', async (t) => {
  const { w, bot } = await setup(t);
  const id = bot.state.boardMessageId;
  const restarted = w.makeBot();
  assert.equal(restarted.state.boardMessageId, id);
  await restarted.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
  assert.equal(w.tg.callsTo('editMessageText').length, 0, 'the text did not change');
});

test('without the Pin messages right the board is sent unpinned', async (t) => {
  const { w, bot } = await setup(t, { telegram: { botRights: { can_manage_topics: true, can_pin_messages: false, can_delete_messages: true } } });
  assert.equal(boardOf(w, bot).text, NOTHING);
  assert.equal(boardOf(w, bot).pinned, null);
  assert.equal(w.tg.callsTo('pinChatMessage').length, 0);
});

test('a refused pin keeps the board and warns', async (t) => {
  const { w, bot } = await setup(t, { telegram: { botRights: { can_manage_topics: true, can_pin_messages: true } } });
  w.tg.setBotRights({ can_manage_topics: true, can_pin_messages: false, can_delete_messages: true });
  w.tg.deleteMessage(bot.state.boardMessageId);
  w.pc.addIssue({ title: 'Busy', status: 'in_progress' });
  await bot.pollOnce();
  assert.match(boardOf(w, bot).text, /Working/);
  assert.match(w.allLogText(), /warn could not pin the board/);
});

test('the sections come in order, each with a count and the newest task first, and an empty one is left out', async (t) => {
  const { w, bot } = await setup(t);
  const dev = w.pc.addAgent({ name: 'Dev' });
  const busy = w.pc.addIssue({ title: 'Build the thing', status: 'in_progress', assigneeAgentId: dev.id });
  const loose = w.pc.addIssue({ title: 'Nobody has it', status: 'in_progress' });
  const waiting = w.pc.addIssue({ title: 'Look at this', status: 'in_progress' });
  const asked = w.pc.addIssue({ title: 'Needs an answer', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(waiting.id, 'in_review');
  w.pc.setStatus(asked.id, 'in_review');
  w.pc.addInteraction(asked.id, { kind: 'request_confirmation', payload: confirmPayload() });
  await bot.pollOnce();

  assert.equal(
    boardOf(w, bot).text,
    [
      '<b>Needs you</b> (1)',
      line(topicUrl(bot, asked), asked),
      '',
      '<b>Working</b> (2)',
      `${line(taskUrl(loose), loose)} — unassigned`,
      `${line(taskUrl(busy), busy)} — Dev`,
      '',
      '<b>In review</b> (1)',
      line(topicUrl(bot, waiting), waiting),
    ].join('\n'),
  );
  assert.equal(boardOf(w, bot).silent, true);
});

test('the sections are the ones /status shows, and an item is in one section only', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Release', status: 'in_review' });
  w.pc.addApproval({ type: 'hire_agent', payload: { title: 'Hire a tester' } });
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });
  await bot.pollOnce();

  const text = boardOf(w, bot).text;
  assert.match(text, /^<b>Needs you<\/b> \(2\)\n/);
  assert.ok(!text.includes('<b>In review</b>'), 'a task with a card is not listed again under In review');
  assert.ok(text.includes('Hire a tester'), 'an item without a task is named by its title');

  await bot.handleUpdate(w.tg.message('/status'));
  const status = w.tg.lastMessage();
  assert.match(status.text, /Waiting for you/);
  assert.equal(w.tg.buttons(status.message_id).length, 2, 'the same two entries');
});

test('a line is cut to about one phone line and links to the topic or to Paperclip', async (t) => {
  const { w, bot } = await setup(t);
  const long = w.pc.addIssue({ title: 'W'.repeat(120), status: 'in_progress' });
  await bot.pollOnce();
  const label = boardOf(w, bot).text.match(/<a href="[^"]+">([^<]*)<\/a>/)[1];
  assert.equal(Array.from(label).length, 40);
  assert.ok(label.startsWith(`${long.identifier} WWW`) && label.endsWith('…'));
  assert.ok(boardOf(w, bot).text.includes(`<a href="${taskUrl(long)}">`), 'no topic yet, so the link is the task in Paperclip');

  w.pc.setStatus(long.id, 'in_review');
  await bot.pollOnce();
  assert.ok(boardOf(w, bot).text.includes(`<a href="${topicUrl(bot, long)}">`), 'once there is a topic the link is the topic');
});

test('a subtask line links to the topic of its top-level task', async (t) => {
  const { w, bot } = await setup(t);
  const parent = w.pc.addIssue({ title: 'Big job', status: 'in_progress' });
  const child = w.pc.addIssue({ title: 'Small step', status: 'in_progress', parentId: parent.id });
  await bot.pollOnce();
  w.pc.setStatus(parent.id, 'in_review');
  await bot.pollOnce();
  assert.ok(boardOf(w, bot).text.includes(`<a href="${topicUrl(bot, parent)}">${child.identifier} Small step</a>`));
});

test('a section shows ten lines and then how many more there are', async (t) => {
  const { w, bot } = await setup(t);
  for (let i = 0; i < 12; i += 1) w.pc.addIssue({ title: `Job ${i}`, status: 'in_progress' });
  await bot.pollOnce();
  const lines = boardOf(w, bot).text.split('\n');
  assert.equal(lines[0], '<b>Working</b> (12)');
  assert.equal(lines.length, 12, 'header, ten lines and the remainder');
  assert.equal(lines.at(-1), '+2 more');
});

test('the board is edited only when its text changes', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Busy', status: 'in_progress' });
  await bot.pollOnce();
  assert.equal(boardEdits(w, bot).length, 1);
  await bot.pollOnce();
  await bot.pollOnce();
  assert.equal(boardEdits(w, bot).length, 1, 'same text, no edit');

  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  assert.equal(boardEdits(w, bot).length, 2);
  assert.equal(boardOf(w, bot).text, NOTHING);
  assert.equal(w.tg.callsTo('sendMessage').filter((c) => c.params.text === NOTHING).length, 1, 'the board message is the same one');
});

test('"message is not modified" is not an error', async (t) => {
  const { w, bot } = await setup(t);
  bot.state.boardHash = null;
  await bot.pollOnce();
  assert.equal(boardEdits(w, bot).length, 1, 'the bot did not know the text was current and tried');
  assert.ok(!w.allLogText().includes('could not update the board'));
  assert.ok(bot.state.boardHash, 'and remembers it now');
  await bot.pollOnce();
  assert.equal(boardEdits(w, bot).length, 1);
});

test('a board the owner deleted is sent and pinned again', async (t) => {
  const { w, bot } = await setup(t);
  const first = bot.state.boardMessageId;
  w.tg.deleteMessage(first);
  w.pc.addIssue({ title: 'Busy', status: 'in_progress' });
  await bot.pollOnce();

  assert.notEqual(bot.state.boardMessageId, first);
  assert.match(boardOf(w, bot).text, /^<b>Working<\/b> \(1\)/);
  assert.deepEqual(boardOf(w, bot).pinned, { silent: true });
  assert.equal(w.tg.callsTo('pinChatMessage').length, 2);
  assert.ok(!w.allLogText().includes('could not update the board'));
});

test('there is no board when topics are off', async (t) => {
  const w = await startWorld();
  t.after(() => w.close());
  const bot = await w.primedBot();
  w.pc.addIssue({ title: 'Busy', status: 'in_progress' });
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 0);
  assert.equal(bot.state.boardMessageId, null);

  const off = await startWorld({ telegram: { chatId: GROUP_ID, forum: true }, config: { topics: 'off' } });
  t.after(() => off.close());
  const quiet = await off.primedBot();
  await quiet.pollOnce();
  assert.equal(off.tg.callsTo('sendMessage').length, 0);
  assert.equal(off.tg.callsTo('pinChatMessage').length, 0);
});

test('a board that cannot be updated warns once an hour and never stops the poll', async (t) => {
  let clock = Date.now();
  const { w, bot } = await setup(t, { now: () => clock });
  w.tg.failNext('editMessageText', 400, { ok: false, error_code: 400, description: 'Bad Request: something is wrong' }, Infinity, (params) => params.message_id === bot.state.boardMessageId);
  w.pc.addIssue({ title: 'Still going', status: 'in_progress' });
  const issue = w.pc.addIssue({ title: 'Finishing', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  assert.ok(w.tg.findMessage('Done'), 'the status message still went out');
  assert.equal(bot.state.lastPollAt !== null, true);
  const warnings = () => w.allLogText().split('could not update the board').length - 1;
  assert.equal(warnings(), 1);
  await bot.pollOnce();
  assert.equal(warnings(), 1, 'not again within the hour');
  clock += HOUR + 1;
  await bot.pollOnce();
  assert.equal(warnings(), 2);
});

test('a Paperclip error while reading the lists for the board does not stop the poll', async (t) => {
  const { w, bot } = await setup(t);
  const real = bot.pc.listIssues.bind(bot.pc);
  bot.pc.listIssues = async (companyId, query) => {
    if (query.status === 'in_progress' && query.sortDir === 'desc') throw new PaperclipError(500, 'Injected failure');
    return real(companyId, query);
  };
  const issue = w.pc.addIssue({ title: 'Finishing', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  assert.ok(w.tg.findMessage('Done'));
  assert.match(w.allLogText(), /warn could not update the board/);
});
