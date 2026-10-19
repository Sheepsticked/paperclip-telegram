import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTelegramHtml } from './fakes/telegram.js';
import { LEAD_AGENT_ID, UI_BASE_URL, startWorld, waitFor } from './helpers.js';

async function setup(t, options, botOptions) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const bot = await w.primedBot(botOptions);
  return { w, bot };
}

const patches = (w) => w.pc.requests.filter((r) => r.method === 'PATCH');
const posts = (w, suffix) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));
const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
// Rows with the colour of each button after its label: "Done [success]".
const styledRows = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => (b.style ? `${b.text} [${b.style}]` : b.text)));
const textOf = (w, id) => w.tg.messages.get(id).text;

async function openTask(w, bot, ref, issue) {
  await bot.handleUpdate(w.tg.message(`/task ${ref ?? issue.identifier}`));
  return w.tg.lastMessage();
}

const tap = (w, bot, message, label) => bot.handleUpdate(w.tg.tapButton(message.message_id, label));
const GROUP = { telegram: { chatId: -1001234567890, forum: true }, config: { topics: 'auto' } };
const TASK_URL = `${UI_BASE_URL}/TST/issues/TST-1`;
const line1 = (title = 'Fix &lt;login&gt; page') => `<b><a href="${TASK_URL}">TST-1</a></b> ${title}`;

test('/task shows the linked id, one status line, the description, the last comment and two buttons', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Website' });
  const issue = w.pc.addIssue({
    title: 'Fix <login> page',
    description: 'Users see a blank screen & cannot sign in.',
    status: 'in_progress',
    assigneeAgentId: 'agent-1',
    projectId: project.id,
  });
  for (let i = 1; i <= 4; i += 1) w.pc.addComment(issue.id, { body: `Agent note ${i}` });
  w.pc.addComment(issue.id, { body: 'My answer', authorType: 'user' });

  const update = w.tg.message('/task TST-1');
  await bot.handleUpdate(update);
  const view = w.tg.lastMessage();

  assert.equal(view.replyTo, update.message.message_id);
  assert.equal(
    view.text,
    [
      line1(),
      'In progress · Dev · Website · updated just now',
      '<blockquote>Users see a blank screen &amp; cannot sign in.</blockquote>',
      '<b>You</b>',
      '<blockquote>My answer</blockquote>',
    ].join('\n'),
  );
  assert.ok(!view.text.includes('Open in Paperclip'));
  assert.ok(!view.text.includes('Agent note'), 'only the last comment is shown');
  assert.equal(validateTelegramHtml(view.text), null);
  assert.deepEqual(styledRows(w, view.message_id), [['Done [success]', 'More']]);
  assert.ok(w.pc.requests.some((r) => r.method === 'GET' && r.path === '/api/issues/TST-1'));
  assert.equal(bot.state.hasShown(w.pc.comments.at(-1).id), false, 'a view never marks its comment as shown');
});

test('the status line has only the parts that apply: no project, an owner assignee, a high priority', async (t) => {
  const { w, bot } = await setup(t);
  const plain = w.pc.addIssue({ title: 'Plain', status: 'todo' });
  const mine = Object.assign(w.pc.addIssue({ title: 'Mine', status: 'in_review', assigneeUserId: 'board-user-1' }), { priority: 'high' });
  const urgent = Object.assign(w.pc.addIssue({ title: 'Urgent', status: 'blocked', assigneeAgentId: 'agent-1' }), { priority: 'critical' });
  const medium = w.pc.addIssue({ title: 'Medium', status: 'todo', assigneeAgentId: 'agent-1' });
  const second = async (issue) => (await openTask(w, bot, null, issue)).text.split('\n')[1];
  assert.equal(await second(plain), 'To do · Unassigned · updated just now');
  assert.equal(await second(mine), 'In review · You · updated just now · high priority');
  assert.equal(await second(urgent), 'Blocked · Dev · updated just now · critical priority');
  assert.equal(await second(medium), 'To do · Dev · updated just now');
});

test('a task without a description or a comment is two lines, and an empty description is left out', async (t) => {
  const { w, bot } = await setup(t);
  const bare = w.pc.addIssue({ title: 'Bare', status: 'todo', description: '   ' });
  const view = await openTask(w, bot, null, bare);
  assert.equal(view.text, `${line1('Bare')}\nTo do · Unassigned · updated just now`);
});

test('the view shows only the last comment, cut to 200 characters and quoted with the author', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Chatty', status: 'in_progress', assigneeAgentId: 'agent-1' });
  w.pc.addComment(issue.id, { body: 'Older note' });
  w.pc.addComment(issue.id, { body: 'y'.repeat(500) });
  const view = await openTask(w, bot, null, issue);
  assert.equal(view.text.split('\n').slice(2).join('\n'), `<b>Dev</b>\n<blockquote>${'y'.repeat(199)}…</blockquote>`);
  assert.ok(!view.text.includes('Older note'));
});

test('a description is cut to 300 characters and a long one is a plain quote, not a folded one', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Long text', status: 'todo', description: 'x'.repeat(500) });
  const view = await openTask(w, bot, null, issue);
  assert.equal(view.text.split('\n')[2], `<blockquote>${'x'.repeat(299)}…</blockquote>`);
});

test('in its own topic the view has no comment, and the second keyboard has no Comment or Follow', async (t) => {
  const { w, bot } = await setup(t, GROUP);
  const parent = w.pc.addIssue({ title: 'Parent', status: 'in_progress', assigneeAgentId: 'agent-1' });
  const child = w.pc.addIssue({ title: 'Child', status: 'todo', parentId: parent.id });
  w.pc.addComment(parent.id, { body: 'Parent note' });
  const childNote = w.pc.addComment(child.id, { body: 'Child note' });
  w.pc.setStatus(parent.id, 'in_review');
  await bot.pollOnce();
  const thread = bot.state.topics.get(parent.id).thread;

  const fresh = w.pc.addComment(parent.id, { body: 'Fresh note' });
  await bot.handleUpdate(w.tg.message('/task TST-1', { thread }));
  const own = w.tg.lastMessage();
  assert.equal(own.thread, thread);
  assert.equal(own.text, `${line1('Parent')}\nIn review · Dev · updated just now`);
  assert.equal(bot.state.hasShown(fresh.id), false, 'a view without a comment shows none');
  await tap(w, bot, own, 'More');
  assert.deepEqual(rowsOf(w, own.message_id), [['Assign', 'Project'], ['To do', 'Cancel task'], ['Refresh', '◀ Back']]);

  await bot.handleUpdate(w.tg.message('/task TST-2', { thread }));
  const sub = w.tg.lastMessage();
  assert.equal(sub.text, `<b><a href="${UI_BASE_URL}/TST/issues/TST-2">TST-2</a></b> Child\nTo do · Unassigned · updated just now\n<b>Dev</b>\n<blockquote>Child note</blockquote>`);
  assert.ok(sub.text.includes('Child note'), 'a subtask is not the topic task, so its view shows the comment');
  assert.equal(bot.state.hasShown(childNote.id), false);
  await tap(w, bot, sub, 'More');
  assert.deepEqual(rowsOf(w, sub.message_id), [['Assign', 'Project'], ['Cancel task'], ['Follow'], ['Comment'], ['Refresh', '◀ Back']]);
});

test('a comment the view showed is still sent as a followed comment', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Followed', status: 'in_progress', assigneeAgentId: 'agent-1' });
  const view = await openTask(w, bot, null, issue);
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Follow');

  const seen = w.pc.addComment(issue.id, { body: 'Shown first' });
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Refresh');
  assert.ok(textOf(w, view.message_id).includes('Shown first'), 'the view shows it');
  assert.equal(bot.state.hasShown(seen.id), false);
  const later = w.pc.addComment(issue.id, { body: 'Also in the follow message' });
  const before = w.tg.sent().length;
  await bot.pollOnce();

  const news = w.tg.sent().slice(before);
  assert.equal(news.length, 2);
  assert.match(news[0].text, /Shown first/);
  assert.match(news[1].text, /Also in the follow message/);
  assert.equal(bot.state.following.get(issue.id).lastSeenCommentId, later.id);
});

test('/task accepts a lowercase identifier and a bare number', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addIssue({ title: 'First' });
  w.pc.addIssue({ title: 'Second' });

  const firstLine = () => w.tg.lastMessage().text.split('\n')[0];
  await bot.handleUpdate(w.tg.message('/task tst-2'));
  assert.equal(firstLine(), `<b><a href="${UI_BASE_URL}/TST/issues/TST-2">TST-2</a></b> Second`);
  await bot.handleUpdate(w.tg.message('/task 1'));
  assert.equal(firstLine(), line1('First'));
  await bot.handleUpdate(w.tg.message('/task #2'));
  assert.equal(firstLine(), `<b><a href="${UI_BASE_URL}/TST/issues/TST-2">TST-2</a></b> Second`);
});

test('/task without a valid reference or for a missing task says so', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/task'));
  assert.match(w.tg.lastMessage().text, /^Usage: \/task &lt;ID&gt;/);
  await bot.handleUpdate(w.tg.message('/task not-a-task'));
  assert.match(w.tg.lastMessage().text, /^Usage: \/task/);
  await bot.handleUpdate(w.tg.message('/task TST-99'));
  assert.equal(w.tg.lastMessage().text, 'No task TST-99');
});

test('the first keyboard is Done and More, or Reopen and More for a finished task', async (t) => {
  const { w, bot } = await setup(t);
  const first = async (status) => styledRows(w, (await openTask(w, bot, null, w.pc.addIssue({ title: status, status }))).message_id);
  assert.deepEqual(await first('todo'), [['Done [success]', 'More']]);
  assert.deepEqual(await first('in_review'), [['Done [success]', 'More']]);
  assert.deepEqual(await first('done'), [['Reopen [primary]', 'More']]);
  assert.deepEqual(await first('cancelled'), [['Reopen [primary]', 'More']]);
});

test('More opens the second keyboard in place and Back returns to the first one', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Many actions', status: 'in_progress' });
  const view = await openTask(w, bot, null, issue);
  const text = textOf(w, view.message_id);
  const requests = w.pc.requests.length;
  const sent = w.tg.sent().length;

  await tap(w, bot, view, 'More');
  assert.deepEqual(styledRows(w, view.message_id), [
    ['Assign', 'Project'],
    ['To do', 'Cancel task [danger]'],
    ['Follow'],
    ['Comment'],
    ['Refresh', '◀ Back'],
  ]);
  assert.equal(textOf(w, view.message_id), text, 'the text stays');
  assert.equal(w.tg.sent().length, sent, 'More edits the message instead of sending one');
  assert.equal(w.pc.requests.length - requests, 1, 'More reads the task once to build the keyboard');
  assert.equal(patches(w).length, 0);

  await tap(w, bot, view, 'Back');
  assert.deepEqual(styledRows(w, view.message_id), [['Done [success]', 'More']]);
  assert.equal(textOf(w, view.message_id), text);
});

test('the second keyboard drops the moves that do not apply', async (t) => {
  const { w, bot } = await setup(t);
  const moves = async (status) => {
    const view = await openTask(w, bot, null, w.pc.addIssue({ title: status, status }));
    await tap(w, bot, view, 'More');
    return styledRows(w, view.message_id)[1];
  };
  assert.deepEqual(await moves('todo'), ['Cancel task [danger]']);
  assert.deepEqual(await moves('done'), ['To do', 'Cancel task [danger]']);
  assert.deepEqual(await moves('cancelled'), ['To do']);
});

test('long titles, descriptions and comments still fit one valid message', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: '<T>'.repeat(300), description: '&D<'.repeat(2000), status: 'in_progress' });
  for (let i = 0; i < 3; i += 1) w.pc.addComment(issue.id, { body: `<c${i}> `.repeat(1500) });
  const view = await openTask(w, bot, null, issue);
  assert.ok(view.text.length <= 4096);
  assert.equal(validateTelegramHtml(view.text), null);
  assert.ok(view.text.startsWith(`<b><a href="${TASK_URL}">TST-1</a></b> `));
});

test('Refresh re-reads the task and edits the same message', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Watch me', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  await tap(w, bot, view, 'More');
  w.pc.setStatus(issue.id, 'in_review');
  w.pc.addComment(issue.id, { body: 'Ready for you' });
  const before = w.tg.sent().length;

  await tap(w, bot, view, 'Refresh');
  assert.equal(w.tg.sent().length, before, 'no new message');
  assert.equal(
    textOf(w, view.message_id),
    `${line1('Watch me')}\nIn review · Unassigned · updated just now\n<b>Dev</b>\n<blockquote>Ready for you</blockquote>`,
  );
  assert.deepEqual(styledRows(w, view.message_id), [['Done [success]', 'More']], 'the first keyboard is back');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Refreshed');
});

test('Done needs a second tap, then sends a bare status change and redraws the view', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Ship it', status: 'in_progress' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'Done');
  assert.equal(patches(w).length, 0, 'the first tap only arms the button');
  assert.deepEqual(styledRows(w, view.message_id), [['Tap again to confirm [success]', 'More']]);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Tap again to confirm');

  await tap(w, bot, view, 'Tap again');
  assert.deepEqual(patches(w).map((r) => r.body), [{ status: 'done' }]);
  assert.match(patches(w)[0].path, new RegExp(`/api/issues/${issue.id}$`));
  assert.equal(w.pc.issues.get(issue.id).status, 'done');
  assert.match(textOf(w, view.message_id).split('\n')[1], /^Done · /);
  assert.deepEqual(styledRows(w, view.message_id), [['Reopen [primary]', 'More']]);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Done');
});

test('Cancel task is on the second keyboard, needs a second tap and leaves the first keyboard on Reopen', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Drop it', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  await tap(w, bot, view, 'More');

  await tap(w, bot, view, 'Cancel task');
  assert.equal(patches(w).length, 0);
  assert.deepEqual(styledRows(w, view.message_id)[1], ['Tap again to confirm [danger]']);
  assert.equal(styledRows(w, view.message_id).length, 5, 'the second keyboard stays open while armed');
  await tap(w, bot, view, 'Tap again');
  assert.deepEqual(patches(w).map((r) => r.body), [{ status: 'cancelled' }]);
  assert.match(textOf(w, view.message_id).split('\n')[1], /^Cancelled · /);
  assert.deepEqual(styledRows(w, view.message_id), [['Reopen [primary]', 'More']]);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Cancelled');
});

test('an armed button goes back to normal when the confirm window ends', async (t) => {
  const { w, bot } = await setup(t, undefined, { confirmMs: 300 });
  const issue = w.pc.addIssue({ title: 'Careful', status: 'todo' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'Done');
  assert.ok(rowsOf(w, view.message_id)[0].includes('Tap again to confirm'));
  await waitFor(() => rowsOf(w, view.message_id)[0].includes('Done'), { label: 'button reset' });

  // A tap after the window arms the button again instead of changing the task.
  await tap(w, bot, view, 'Done');
  assert.equal(patches(w).length, 0);
  assert.ok(rowsOf(w, view.message_id)[0].includes('Tap again to confirm'));
});

test('an armed Cancel task goes back to normal on the second keyboard when the window ends', async (t) => {
  const { w, bot } = await setup(t, undefined, { confirmMs: 300 });
  const issue = w.pc.addIssue({ title: 'Careful', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Cancel task');
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Tap again to confirm']);
  await waitFor(() => rowsOf(w, view.message_id)[1]?.includes('Cancel task'), { label: 'button reset' });
  assert.equal(patches(w).length, 0);
});

test('the timer of a pending Done does not redraw over an open picker or the documents list', async (t) => {
  const { w, bot } = await setup(t, undefined, { confirmMs: 100 });
  w.pc.addProject({ name: 'Website' });
  const issue = w.pc.addIssue({ title: 'Careful', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: 'Step one' });
  const view = await openTask(w, bot, null, issue);
  for (const opener of ['Assign', 'Project', 'Docs']) {
    await tap(w, bot, view, 'Done');
    await tap(w, bot, view, 'More');
    await tap(w, bot, view, opener);
    const open = rowsOf(w, view.message_id);
    assert.ok(open.flat().includes('◀ Back'), `${opener} is open`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(rowsOf(w, view.message_id), open, `${opener} stays open after the window`);
    await tap(w, bot, view, 'Back');
    assert.deepEqual(rowsOf(w, view.message_id), [['Done', 'More']]);
  }
  assert.equal(patches(w).length, 0);
});

test('opening More puts a pending Done away, whether it ends with Refresh or Back', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Careful', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  await tap(w, bot, view, 'Done');
  assert.deepEqual(rowsOf(w, view.message_id), [['Tap again to confirm', 'More']]);
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Refresh');
  assert.deepEqual(rowsOf(w, view.message_id), [['Done', 'More']], 'the first keyboard comes back unarmed');
  await tap(w, bot, view, 'Done');
  assert.equal(patches(w).length, 0, 'the next tap arms again instead of changing the task');

  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Back');
  assert.deepEqual(rowsOf(w, view.message_id), [['Done', 'More']], 'Back disarms');
  await tap(w, bot, view, 'Done');
  assert.equal(patches(w).length, 0);
});

test('Reopen moves a finished task to To do with a bare status change', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Again', status: 'done' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'Reopen');
  assert.deepEqual(patches(w).map((r) => r.body), [{ status: 'todo' }]);
  assert.match(textOf(w, view.message_id).split('\n')[1], /^To do · /);
  assert.deepEqual(styledRows(w, view.message_id), [['Done [success]', 'More']]);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'To do');
});

test('To do on the second keyboard moves an open task back with a bare status change', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Back to the queue', status: 'in_review' });
  const view = await openTask(w, bot, null, issue);
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'To do');
  assert.deepEqual(patches(w).map((r) => r.body), [{ status: 'todo' }]);
  assert.match(textOf(w, view.message_id).split('\n')[1], /^To do · /);
});

test('a rejected change shows the server text as an alert and leaves the view alone', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Stuck', status: 'in_review' });
  const view = await openTask(w, bot, null, issue);
  await tap(w, bot, view, 'More');
  const text = textOf(w, view.message_id);
  const edits = w.tg.messages.get(view.message_id).edits;

  w.pc.failRequests('PATCH', /\/api\/issues\//, 422, 1, 'Review policy: a reviewer must approve this first');
  await tap(w, bot, view, 'To do');
  const answer = w.tg.callbackAnswers.at(-1);
  assert.deepEqual({ text: answer.text, alert: answer.alert }, { text: 'Review policy: a reviewer must approve this first', alert: true });
  assert.equal(textOf(w, view.message_id), text);
  assert.equal(w.tg.messages.get(view.message_id).edits, edits);

  w.pc.failRequests('PATCH', /\/api\/issues\//, 409, 1, 'x'.repeat(500));
  await tap(w, bot, view, 'To do');
  assert.ok(w.tg.callbackAnswers.at(-1).text.length <= 200);
  assert.equal(w.tg.callbackAnswers.at(-1).alert, true);
});

test('a failed confirmation keeps the button armed so a retry works', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Flaky', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  await tap(w, bot, view, 'Done');

  w.pc.failRequests('PATCH', /\/api\/issues\//, 500, 1);
  await tap(w, bot, view, 'Tap again');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Paperclip error: 500');
  assert.ok(rowsOf(w, view.message_id)[0].includes('Tap again to confirm'));
  assert.equal(w.pc.issues.get(issue.id).status, 'todo');

  await tap(w, bot, view, 'Tap again');
  assert.equal(w.pc.issues.get(issue.id).status, 'done');
});

test('an unreachable Paperclip and a vanished task get short answers', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Gone soon', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  await tap(w, bot, view, 'More');

  w.pc.setDropConnections(true);
  await tap(w, bot, view, 'Refresh');
  w.pc.setDropConnections(false);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Paperclip unreachable, try again');

  w.pc.issues.delete(issue.id);
  await tap(w, bot, view, 'Refresh');
  assert.deepEqual({ text: w.tg.callbackAnswers.at(-1).text, alert: w.tg.callbackAnswers.at(-1).alert }, { text: 'Task not found', alert: true });
});

test('Assign turns the keyboard into an agent picker and assigns the chosen agent', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addAgent({ name: 'Retired', status: 'terminated' });
  const issue = w.pc.addIssue({ title: 'Who does it', status: 'todo', assigneeAgentId: 'agent-1' });
  const view = await openTask(w, bot, null, issue);
  const text = textOf(w, view.message_id);
  assert.equal(text.split('\n')[1], 'To do · Dev · updated just now');

  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Assign');
  assert.deepEqual(rowsOf(w, view.message_id), [['Dev'], ['Lead'], ['◀ Back']]);
  assert.equal(textOf(w, view.message_id), text, 'the text stays while the picker is open');

  await tap(w, bot, view, 'Back');
  assert.deepEqual(rowsOf(w, view.message_id), [['Done', 'More']]);
  assert.equal(patches(w).length, 0);

  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Assign');
  await tap(w, bot, view, 'Lead');
  assert.deepEqual(patches(w).map((r) => r.body), [{ assigneeAgentId: LEAD_AGENT_ID, assigneeUserId: null }]);
  assert.equal(textOf(w, view.message_id).split('\n')[1], 'To do · Lead · updated just now');
  assert.deepEqual(rowsOf(w, view.message_id), [['Done', 'More']], 'the first buttons are back');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Assigned to Lead');
});

test('assigning a task that is assigned to the owner clears the owner assignee', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Mine', status: 'todo', assigneeUserId: 'board-user-1' });
  const view = await openTask(w, bot, null, issue);
  assert.equal(view.text.split('\n')[1], 'To do · You · updated just now');
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Assign');
  await tap(w, bot, view, 'Dev');
  assert.equal(w.pc.issues.get(issue.id).assigneeAgentId, 'agent-1');
  assert.equal(w.pc.issues.get(issue.id).assigneeUserId, null);
});

test('the project picker pages through projects and sets or clears the project', async (t) => {
  const { w, bot } = await setup(t);
  for (let i = 1; i <= 10; i += 1) w.pc.addProject({ name: `Project ${String(i).padStart(2, '0')}` });
  w.pc.addProject({ name: 'Old project', archived: true });
  const issue = w.pc.addIssue({ title: 'Needs a home', status: 'todo' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Project');
  let rows = rowsOf(w, view.message_id);
  assert.deepEqual(rows.slice(0, 8).flat(), Array.from({ length: 8 }, (_, i) => `Project ${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(rows[8], ['1/2', '▶']);
  assert.deepEqual(rows[9], ['No project', '◀ Back']);

  await tap(w, bot, view, '▶');
  rows = rowsOf(w, view.message_id);
  assert.deepEqual(rows.slice(0, 2).flat(), ['Project 09', 'Project 10']);
  assert.deepEqual(rows[2], ['◀', '2/2']);
  assert.ok(!rows.flat().includes('Old project'));

  await tap(w, bot, view, 'Project 10');
  const chosen = w.pc.projects.find((p) => p.name === 'Project 10');
  assert.deepEqual(patches(w).map((r) => r.body), [{ projectId: chosen.id }]);
  assert.equal(textOf(w, view.message_id).split('\n')[1], 'To do · Unassigned · Project 10 · updated just now');

  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Project');
  await tap(w, bot, view, 'No project');
  assert.deepEqual(patches(w).at(-1).body, { projectId: null });
  assert.equal(textOf(w, view.message_id).split('\n')[1], 'To do · Unassigned · updated just now');
});

test('Follow and Unfollow switch following and the button', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Keep an eye', status: 'in_progress' });
  const old = w.pc.addComment(issue.id, { body: 'Old comment' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Follow');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Following');
  assert.deepEqual(rowsOf(w, view.message_id), [['Done', 'More']], 'the first keyboard is back');
  assert.equal(bot.state.following.get(issue.id).lastSeenCommentId, old.id, 'following starts after the newest comment');
  await tap(w, bot, view, 'More');
  assert.deepEqual(rowsOf(w, view.message_id)[2], ['Unfollow']);

  await tap(w, bot, view, 'Unfollow');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unfollowed');
  await tap(w, bot, view, 'More');
  assert.deepEqual(rowsOf(w, view.message_id)[2], ['Follow']);
  assert.equal(bot.state.following.size, 0);
});

test('Comment asks for a reply and the reply becomes a comment on the task', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Talk to me', status: 'in_progress' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Comment');
  const prompt = w.tg.lastMessage();
  assert.equal(prompt.replyTo, view.message_id);
  assert.deepEqual(prompt.markup, { force_reply: true, input_field_placeholder: 'Comment' });
  assert.match(prompt.text, /TST-1/);

  await bot.handleUpdate(w.tg.message('Looks good, ship it', { replyTo: prompt.message_id }));
  const [comment] = posts(w, '/comments');
  assert.deepEqual(comment.body, { body: 'Looks good, ship it' });
  assert.match(comment.path, new RegExp(`/api/issues/${issue.id}/comments$`));
  assert.equal(w.tg.lastMessage().text, `<b>Comment posted</b> · <a href="${TASK_URL}">TST-1</a>`);
});

test('a plain reply to the task view becomes a comment', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Reply here', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  await bot.handleUpdate(w.tg.message('Quick note', { replyTo: view.message_id }));
  assert.deepEqual(posts(w, '/comments').map((r) => r.body), [{ body: 'Quick note' }]);
});

test('a rejected comment is reported and nothing else changes', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'No comments please', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  w.pc.failRequests('POST', /\/comments$/, 422, 1, 'Comments are closed');
  await bot.handleUpdate(w.tg.message('Hello', { replyTo: view.message_id }));
  assert.equal(w.tg.lastMessage().text, 'Paperclip error: 422 Comments are closed');
  assert.equal(w.pc.comments.length, 0);
});

test('the task button on a v1 message sends the task view', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Finished work', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  const done = w.tg.findMessage('Done');
  assert.deepEqual(rowsOf(w, done.message_id), [['Open task']]);

  await tap(w, bot, done, 'Open task');
  const view = w.tg.lastMessage();
  assert.notEqual(view.message_id, done.message_id);
  assert.equal(view.text, `${line1('Finished work')}\nDone · Unassigned · updated just now`);
  assert.deepEqual(styledRows(w, view.message_id), [['Reopen [primary]', 'More']]);

  await bot.handleUpdate(w.tg.message('One more thing', { replyTo: view.message_id }));
  assert.equal(posts(w, '/comments').length, 1);
});

test('unknown task buttons are answered without calling Paperclip', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Anything', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  const requests = w.pc.requests.length;
  await bot.handleUpdate(w.tg.tap(view.message_id, `T:zz:${issue.id}`));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await bot.handleUpdate(w.tg.tap(view.message_id, 'Q:x:y'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await bot.handleUpdate(w.tg.tap(view.message_id, 'T:v'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  assert.equal(w.pc.requests.length, requests);
});

test('task buttons from another user change nothing', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Mine only', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  const requests = w.pc.requests.length;
  await bot.handleUpdate(w.tg.tap(view.message_id, `T:t:${issue.id}`, { from: 2002 }));
  await bot.handleUpdate(w.tg.tap(view.message_id, `T:d:${issue.id}`, { chat: 9999 }));
  assert.equal(w.pc.requests.length, requests);
  assert.equal(patches(w).length, 0);
});

test('in-review and failed-run messages carry the task button, a run without a task does not', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Long job', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  w.pc.addFailedRun({ issueId: issue.id, errorCode: 'adapter_failed', error: 'boom' });
  w.pc.addFailedRun({ agentId: 'agent-1', errorCode: 'timeout', error: 'too slow' });
  await bot.pollOnce();

  const review = w.tg.findMessage('In review');
  const failed = w.tg.findMessage('adapter_failed');
  const orphan = w.tg.findMessage('timeout');
  assert.deepEqual(rowsOf(w, review.message_id), [['Open task']]);
  assert.deepEqual(rowsOf(w, failed.message_id), [['Open task']]);
  assert.deepEqual(rowsOf(w, orphan.message_id), []);
  assert.equal(w.tg.buttons(failed.message_id)[0].callback_data, `T:v:${issue.id}`);
  assert.match(failed.text, new RegExp(`^<b><a href="${UI_BASE_URL}/TST/agents/agent-1/runs/[^"]+">Run failed</a></b> · TST-1 Long job\\n`), 'the kind word links to the run');
  assert.ok(!failed.text.includes('Open in Paperclip'));

  await tap(w, bot, failed, 'Open task');
  assert.equal(w.tg.lastMessage().text.split('\n')[0], line1('Long job'));
});
