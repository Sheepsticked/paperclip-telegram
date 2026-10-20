import assert from 'node:assert/strict';
import test from 'node:test';
import { CALLBACK_DATA_LIMIT } from '../src/format.js';
import { startWorld } from './helpers.js';

const GROUP_ID = -1001234567890;
const COMMANDS = ['tasks', 'status', 'agents', 'projects', 'following', 'settings'];
const LABELS = [['Tasks', 'Status', 'Agents'], ['Projects', 'Following', 'Settings']];

async function setup(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const project = w.pc.addProject({ name: 'Web' });
  w.pc.addIssue({ title: 'Plan the launch', status: 'in_progress', assigneeAgentId: 'agent-1', projectId: project.id });
  w.pc.addIssue({ title: 'Fix the footer', status: 'in_review', assigneeAgentId: 'agent-lead' });
  const bot = await w.primedBot();
  return { w, bot };
}

const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
// What a command sent: text, buttons and topic of every new message, without the id it replies to.
const sentSince = (w, count) => w.tg.sent().slice(count).map((m) => ({ text: m.text, markup: m.markup, thread: m.thread ?? null }));

test('/help keeps a short text with one line on the model and carries the six buttons', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/help'));
  const help = w.tg.lastMessage();
  const lines = help.text.split('\n');
  assert.ok(lines.includes("Model and reasoning: on a new task's offer, under More on a task, or in an agent's view."));
  assert.ok(!help.text.includes('Model and Reasoning buttons'), 'the long sentence about the buttons is gone');
  assert.equal(lines.filter((line) => /model/i.test(line)).length, 1);
  assert.deepEqual(rowsOf(w, help.message_id), LABELS);
  assert.deepEqual(w.tg.buttons(help.message_id).map((b) => b.callback_data), COMMANDS.map((name) => `H:${name}`));
  assert.ok(w.tg.buttons(help.message_id).every((b) => b.style === undefined && Buffer.byteLength(b.callback_data) <= CALLBACK_DATA_LIMIT));
});

test('/start shows the same help with its buttons', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/start'));
  assert.deepEqual(rowsOf(w, w.tg.lastMessage().message_id), LABELS);
});

for (const name of COMMANDS) {
  test(`the ${name} button sends the reply of /${name} without a toast, and the help stays as it is`, async (t) => {
    const { w, bot } = await setup(t);
    const start = w.tg.sent().length;
    await bot.handleUpdate(w.tg.message(`/${name}`));
    const typed = sentSince(w, start);
    assert.ok(typed.length > 0);

    await bot.handleUpdate(w.tg.message('/help'));
    const help = w.tg.lastMessage();
    const before = { text: help.text, markup: JSON.stringify(help.markup) };
    const count = w.tg.sent().length;
    await bot.handleUpdate(w.tg.tapButton(help.message_id, name[0].toUpperCase() + name.slice(1)));

    assert.deepEqual(sentSince(w, count), typed);
    assert.equal(w.tg.callbackAnswers.at(-1).text, '');
    assert.equal(w.tg.callbackAnswers.at(-1).alert, false);
    assert.deepEqual({ text: help.text, markup: JSON.stringify(help.markup) }, before, 'the help message is not edited');
    assert.equal(w.tg.sent().slice(count).every((m) => m.replyTo === undefined || m.replyTo === null), true, 'the reply does not quote the help');
  });
}

test('a button runs the command in the topic of the help, and a plain chat gets General', async (t) => {
  const w = await startWorld({ telegram: { chatId: GROUP_ID, forum: true } });
  t.after(() => w.close());
  const issue = w.pc.addIssue({ title: 'Plan the launch', status: 'in_progress' });
  const bot = await w.primedBot();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  const { thread } = bot.state.topics.get(issue.id);

  await bot.handleUpdate(w.tg.message('/help', { thread }));
  const help = w.tg.lastMessage();
  assert.equal(help.thread, thread);
  const count = w.tg.sent().length;
  await bot.handleUpdate(w.tg.tapButton(help.message_id, 'Projects'));
  const reply = w.tg.sent().slice(count);
  assert.equal(reply.length, 1);
  assert.equal(reply[0].thread, thread);
  assert.ok(reply[0].text.startsWith('<b>Projects</b>'));

  await bot.handleUpdate(w.tg.message('/help'));
  const general = w.tg.lastMessage();
  const next = w.tg.sent().length;
  await bot.handleUpdate(w.tg.tapButton(general.message_id, 'Settings'));
  assert.equal(w.tg.sent().slice(next).length, 1);
  assert.equal(w.tg.sent().at(-1).thread ?? null, null);
});

test('a button reports a Paperclip failure the way the typed command does', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.failRequests('GET', /\/issues/, 500);
  const start = w.tg.sent().length;
  await bot.handleUpdate(w.tg.message('/tasks'));
  const typed = sentSince(w, start);
  await bot.handleUpdate(w.tg.message('/help'));
  const help = w.tg.lastMessage();
  const count = w.tg.sent().length;
  await bot.handleUpdate(w.tg.tapButton(help.message_id, 'Tasks'));
  assert.deepEqual(sentSince(w, count), typed);
  assert.match(typed[0].text, /Paperclip/);
});

test('only the owner can use the help buttons, and an unknown one is answered', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/help'));
  const help = w.tg.lastMessage();
  const count = w.tg.sent().length;
  await bot.handleUpdate(w.tg.tapButton(help.message_id, 'Tasks', { from: 2002 }));
  await bot.handleUpdate(w.tg.tapButton(help.message_id, 'Tasks', { chat: 9999 }));
  assert.equal(w.tg.sent().length, count);

  await bot.handleUpdate(w.tg.tap(help.message_id, 'H:new'));
  await bot.handleUpdate(w.tg.tap(help.message_id, 'H:'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  assert.equal(w.tg.sent().length, count);
});
