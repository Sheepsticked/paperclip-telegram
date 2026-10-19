import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTelegramHtml } from './fakes/telegram.js';
import { startWorld } from './helpers.js';

async function setup(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const bot = await w.primedBot();
  return { w, bot };
}

const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const issueListRequests = (w) => w.pc.requests.filter((r) => r.method === 'GET' && /\/issues$/.test(r.path));

function addOpenTasks(w, count, status = 'todo') {
  return Array.from({ length: count }, (_, i) => w.pc.addIssue({ title: `Task number ${i + 1}`, status }));
}

test('/tasks lists open tasks, newest update first, ten per page', async (t) => {
  const { w, bot } = await setup(t);
  const tasks = addOpenTasks(w, 25);
  w.pc.addIssue({ title: 'Finished', status: 'done' });
  w.pc.addIssue({ title: 'Dropped', status: 'cancelled' });
  w.pc.addIssue({ title: 'Parked', status: 'backlog' });

  const update = w.tg.message('/tasks');
  await bot.handleUpdate(update);
  const list = w.tg.lastMessage();
  assert.equal(list.replyTo, update.message.message_id);
  assert.match(list.text, /^<b>Open tasks<\/b> · All open · page 1$/);
  const rows = rowsOf(w, list.message_id);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[0], ['TST-25 · Task number 25']);
  assert.deepEqual(rows[9], ['TST-16 · Task number 16']);
  assert.deepEqual(rows[10], ['▶']);
  assert.deepEqual(rows[11], ['☑ All open', '☐ Running', '☐ Review', '☐ Blocked']);
  assert.deepEqual(w.tg.buttons(list.message_id)[0].callback_data, `T:v:${tasks[24].id}`);
  assert.equal(validateTelegramHtml(list.text), null);

  const request = issueListRequests(w).at(-1);
  assert.match(request.query, /status=todo(%2C|,)in_progress(%2C|,)in_review(%2C|,)blocked/);
});

test('paging and filtering edit the list message in place', async (t) => {
  const { w, bot } = await setup(t);
  addOpenTasks(w, 25);
  w.pc.addIssue({ title: 'Busy one', status: 'in_progress' });
  w.pc.addIssue({ title: 'Waiting one', status: 'in_review' });
  w.pc.addIssue({ title: 'Stuck one', status: 'blocked' });
  await bot.handleUpdate(w.tg.message('/tasks'));
  const list = w.tg.lastMessage();
  const sent = w.tg.sent().length;

  await bot.handleUpdate(w.tg.tapButton(list.message_id, '▶'));
  assert.match(w.tg.messages.get(list.message_id).text, /page 2$/);
  let rows = rowsOf(w, list.message_id);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows[10], ['◀', '▶']);

  await bot.handleUpdate(w.tg.tapButton(list.message_id, '▶'));
  rows = rowsOf(w, list.message_id);
  assert.equal(rows.length, 10, 'the last page holds the remaining eight tasks');
  assert.deepEqual(rows[8], ['◀']);

  await bot.handleUpdate(w.tg.tapButton(list.message_id, 'Running'));
  assert.match(w.tg.messages.get(list.message_id).text, /Open tasks<\/b> · Running · page 1$/);
  assert.deepEqual(rowsOf(w, list.message_id), [['TST-26 · Busy one'], ['☐ All open', '☑ Running', '☐ Review', '☐ Blocked']]);
  assert.match(issueListRequests(w).at(-1).query, /status=in_progress(&|$)/);

  await bot.handleUpdate(w.tg.tapButton(list.message_id, 'Review'));
  assert.deepEqual(rowsOf(w, list.message_id)[0], ['TST-27 · Waiting one']);
  await bot.handleUpdate(w.tg.tapButton(list.message_id, 'Blocked'));
  assert.deepEqual(rowsOf(w, list.message_id)[0], ['TST-28 · Stuck one']);
  assert.equal(w.tg.sent().length, sent, 'no new message was sent');
});

test('an empty list says so and keeps the filter row', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/tasks'));
  const list = w.tg.lastMessage();
  assert.match(list.text, /Nothing here\.$/);
  assert.deepEqual(rowsOf(w, list.message_id), [['☑ All open', '☐ Running', '☐ Review', '☐ Blocked']]);
});

test('list buttons open the task view', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addIssue({ title: 'Open me', status: 'todo' });
  await bot.handleUpdate(w.tg.message('/tasks'));
  const list = w.tg.lastMessage();
  await bot.handleUpdate(w.tg.tapButton(list.message_id, 'Open me'));
  const view = w.tg.lastMessage();
  assert.notEqual(view.message_id, list.message_id);
  assert.match(view.text, /^<b>Task<\/b> · TST-1 Open me$/m);
});

test('long titles are cut to fit a button and the callback data stays small', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addIssue({ title: 'W'.repeat(300), status: 'todo' });
  await bot.handleUpdate(w.tg.message('/tasks'));
  const [button] = w.tg.buttons(w.tg.lastMessage().message_id);
  assert.ok(button.text.length <= 60);
  assert.ok(button.text.endsWith('…'));
  assert.ok(Buffer.byteLength(button.callback_data) <= 64);
});

test('a list button for a stale page or a failing Paperclip is answered', async (t) => {
  const { w, bot } = await setup(t);
  addOpenTasks(w, 3);
  await bot.handleUpdate(w.tg.message('/tasks'));
  const list = w.tg.lastMessage();

  w.pc.setDropConnections(true);
  await bot.handleUpdate(w.tg.tapButton(list.message_id, 'Running'));
  w.pc.setDropConnections(false);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Paperclip unreachable, try again');
  assert.match(w.tg.messages.get(list.message_id).text, /All open/, 'the list is unchanged');

  await bot.handleUpdate(w.tg.tap(list.message_id, 'L:t:zzz:0'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await bot.handleUpdate(w.tg.tap(list.message_id, 'L:t:a:-1'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
});

test('/find searches with q and shows up to ten task buttons', async (t) => {
  const { w, bot } = await setup(t);
  for (let i = 0; i < 12; i += 1) w.pc.addIssue({ title: `Login bug ${i}`, status: i % 2 ? 'done' : 'todo' });
  w.pc.addIssue({ title: 'Something else' });
  const withComment = w.pc.addIssue({ title: 'Unrelated title' });
  w.pc.addComment(withComment.id, { body: 'mentions the login flow' });

  await bot.handleUpdate(w.tg.message('/find login'));
  const found = w.tg.lastMessage();
  assert.equal(found.text, '<b>Found 10</b> for “login”');
  const buttons = w.tg.buttons(found.message_id);
  assert.equal(buttons.length, 10);
  assert.ok(buttons.every((b) => b.callback_data.startsWith('T:v:')));
  const request = issueListRequests(w).at(-1);
  assert.match(request.query, /q=login/);
  assert.match(request.query, /limit=10(&|$)/);
});

test('/find escapes the query, handles no result and asks for text', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/find <b>&nothing'));
  const none = w.tg.lastMessage();
  assert.equal(none.text, 'Nothing found for “&lt;b&gt;&amp;nothing”');
  assert.equal(validateTelegramHtml(none.text), null);
  assert.equal(w.tg.buttons(none.message_id).length, 0);

  await bot.handleUpdate(w.tg.message('/find'));
  assert.equal(w.tg.lastMessage().text, 'Usage: /find &lt;text&gt;');
});

test('/status buttons open the task', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addIssue({ title: 'Running work', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.handleUpdate(w.tg.message('/status'));
  const running = w.tg.sent()[0];
  await bot.handleUpdate(w.tg.tapButton(running.message_id, 'Running work'));
  assert.match(w.tg.lastMessage().text, /^<b>Task<\/b> · TST-1 Running work$/m);
});

test('/following lists followed tasks as buttons', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/following'));
  assert.match(w.tg.lastMessage().text, /^You are not following any task\./);

  const first = w.pc.addIssue({ title: 'First followed', status: 'in_progress' });
  const second = w.pc.addIssue({ title: 'Second followed', status: 'todo' });
  for (const issue of [first, second]) {
    await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
    await bot.handleUpdate(w.tg.tapButton(w.tg.lastMessage().message_id, 'Follow'));
  }
  await bot.handleUpdate(w.tg.message('/following'));
  const list = w.tg.lastMessage();
  assert.equal(list.text, '<b>Following</b> (2)');
  assert.deepEqual(rowsOf(w, list.message_id), [['TST-2 · Second followed'], ['TST-1 · First followed']]);
});

test('/agents lists every agent as a button with its status and work', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addAgent({ name: 'Idle <Helper>', status: 'paused' });
  w.pc.addIssue({ title: 'Build the API', status: 'in_progress', assigneeAgentId: 'agent-1' });
  w.pc.addIssue({ title: 'Not running', status: 'todo', assigneeAgentId: 'agent-1' });

  await bot.handleUpdate(w.tg.message('/agents'));
  const reply = w.tg.lastMessage();
  assert.equal(reply.text, '<b>Agents</b> (3)');
  assert.deepEqual(rowsOf(w, reply.message_id), [['Dev · Idle · 1 in progress'], ['Idle <Helper> · Paused'], ['Lead · Idle']]);
  assert.deepEqual(w.tg.buttons(reply.message_id)[0].callback_data, 'G:v:agent-1');
  assert.equal(validateTelegramHtml(reply.text), null);
  // The agents route refuses query parameters, so the bot must not send any.
  const agentRequests = w.pc.requests.filter((r) => r.path.endsWith('/agents'));
  assert.ok(agentRequests.length > 0);
  assert.ok(agentRequests.every((r) => r.query === ''));
});
