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
const textOf = (w, id) => w.tg.messages.get(id).text;

async function openTask(w, bot, ref, issue) {
  await bot.handleUpdate(w.tg.message(`/task ${ref ?? issue.identifier}`));
  return w.tg.lastMessage();
}

const tap = (w, bot, message, label) => bot.handleUpdate(w.tg.tapButton(message.message_id, label));

test('/task shows the details, the last three comments and the buttons', async (t) => {
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
  assert.match(view.text, /^<b>TST-1<\/b> Fix &lt;login&gt; page$/m);
  assert.match(view.text, /^Status: 🔄 In progress$/m);
  assert.match(view.text, /^Assignee: Dev$/m);
  assert.match(view.text, /^Project: Website$/m);
  assert.match(view.text, /^Priority: medium$/m);
  assert.match(view.text, /^Updated (just now|\d+ min ago)$/m);
  assert.ok(view.text.includes('Users see a blank screen &amp; cannot sign in.'));
  assert.ok(view.text.includes('• <b>Dev</b>: Agent note 3'));
  assert.ok(view.text.includes('• <b>Dev</b>: Agent note 4'));
  assert.ok(view.text.includes('• <b>You</b>: My answer'));
  assert.ok(!view.text.includes('Agent note 2'), 'only the last three comments are shown');
  assert.ok(view.text.includes(`<a href="${UI_BASE_URL}/TST/issues/TST-1">Open in Paperclip</a>`));
  assert.equal(validateTelegramHtml(view.text), null);
  assert.deepEqual(rowsOf(w, view.message_id), [
    ['💬 Comment', '🔄 Refresh'],
    ['✅ Done', '▶ To do', '⛔ Cancel'],
    ['👤 Assign', '📁 Project'],
    ['🔔 Follow'],
  ]);
  assert.ok(w.pc.requests.some((r) => r.method === 'GET' && r.path === '/api/issues/TST-1'));
});

test('/task accepts a lowercase identifier and a bare number', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addIssue({ title: 'First' });
  w.pc.addIssue({ title: 'Second' });

  await bot.handleUpdate(w.tg.message('/task tst-2'));
  assert.match(w.tg.lastMessage().text, /<b>TST-2<\/b> Second/);
  await bot.handleUpdate(w.tg.message('/task 1'));
  assert.match(w.tg.lastMessage().text, /<b>TST-1<\/b> First/);
  await bot.handleUpdate(w.tg.message('/task #2'));
  assert.match(w.tg.lastMessage().text, /<b>TST-2<\/b> Second/);
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

test('the buttons offer only the moves that change the status', async (t) => {
  const { w, bot } = await setup(t);
  const todo = w.pc.addIssue({ title: 'Todo', status: 'todo' });
  const done = w.pc.addIssue({ title: 'Done', status: 'done' });
  const cancelled = w.pc.addIssue({ title: 'Cancelled', status: 'cancelled' });
  const moves = async (issue) => rowsOf(w, (await openTask(w, bot, null, issue)).message_id)[1];
  assert.deepEqual(await moves(todo), ['✅ Done', '⛔ Cancel']);
  assert.deepEqual(await moves(done), ['▶ To do', '⛔ Cancel']);
  assert.deepEqual(await moves(cancelled), ['✅ Done', '▶ To do']);
});

test('long titles, descriptions and comments still fit one valid message', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: '<T>'.repeat(300), description: '&D<'.repeat(2000), status: 'in_progress' });
  for (let i = 0; i < 3; i += 1) w.pc.addComment(issue.id, { body: `<c${i}> `.repeat(1500) });
  const view = await openTask(w, bot, null, issue);
  assert.ok(view.text.length <= 4096);
  assert.equal(validateTelegramHtml(view.text), null);
  assert.ok(view.text.includes('Open in Paperclip'));
});

test('Refresh re-reads the task and edits the same message', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Watch me', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  w.pc.setStatus(issue.id, 'in_review');
  w.pc.addComment(issue.id, { body: 'Ready for you' });
  const before = w.tg.sent().length;

  await tap(w, bot, view, 'Refresh');
  assert.equal(w.tg.sent().length, before, 'no new message');
  assert.match(textOf(w, view.message_id), /Status: 👀 In review/);
  assert.ok(textOf(w, view.message_id).includes('Ready for you'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Refreshed');
});

test('Done needs a second tap, then sends a bare status change and redraws the view', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Ship it', status: 'in_progress' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'Done');
  assert.equal(patches(w).length, 0, 'the first tap only arms the button');
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['✅ Tap again to confirm', '▶ To do', '⛔ Cancel']);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Tap again to confirm');

  await tap(w, bot, view, 'Tap again');
  assert.deepEqual(patches(w).map((r) => r.body), [{ status: 'done' }]);
  assert.match(patches(w)[0].path, new RegExp(`/api/issues/${issue.id}$`));
  assert.equal(w.pc.issues.get(issue.id).status, 'done');
  assert.match(textOf(w, view.message_id), /Status: ✅ Done/);
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['▶ To do', '⛔ Cancel']);
  assert.equal(w.tg.callbackAnswers.at(-1).text, '✅ Done');
});

test('Cancel needs a second tap too', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Drop it', status: 'todo' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'Cancel');
  assert.equal(patches(w).length, 0);
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['✅ Done', '⛔ Tap again to confirm']);
  await tap(w, bot, view, 'Tap again');
  assert.deepEqual(patches(w).map((r) => r.body), [{ status: 'cancelled' }]);
  assert.match(textOf(w, view.message_id), /Status: 🚫 Cancelled/);
});

test('an armed button goes back to normal when the confirm window ends', async (t) => {
  const { w, bot } = await setup(t, undefined, { confirmMs: 40 });
  const issue = w.pc.addIssue({ title: 'Careful', status: 'todo' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'Done');
  assert.ok(rowsOf(w, view.message_id)[1].includes('✅ Tap again to confirm'));
  await waitFor(() => rowsOf(w, view.message_id)[1].includes('✅ Done'), { label: 'button reset' });

  // A tap after the window arms the button again instead of changing the task.
  await tap(w, bot, view, 'Done');
  assert.equal(patches(w).length, 0);
  assert.ok(rowsOf(w, view.message_id)[1].includes('✅ Tap again to confirm'));
});

test('a refresh keeps an armed button armed', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Careful', status: 'todo' });
  const view = await openTask(w, bot, null, issue);
  await tap(w, bot, view, 'Done');
  await tap(w, bot, view, 'Refresh');
  assert.equal(patches(w).length, 0);
  assert.ok(rowsOf(w, view.message_id)[1].includes('✅ Tap again to confirm'), 'a refresh keeps the armed label');
});

test('To do reopens a finished task with a bare status change', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Again', status: 'done' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'To do');
  assert.deepEqual(patches(w).map((r) => r.body), [{ status: 'todo' }]);
  assert.match(textOf(w, view.message_id), /Status: ⏳ To do/);
  assert.equal(w.tg.callbackAnswers.at(-1).text, '⏳ To do');
});

test('a rejected change shows the server text as an alert and leaves the view alone', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Stuck', status: 'in_review' });
  const view = await openTask(w, bot, null, issue);
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
  assert.ok(rowsOf(w, view.message_id)[1].includes('✅ Tap again to confirm'));
  assert.equal(w.pc.issues.get(issue.id).status, 'todo');

  await tap(w, bot, view, 'Tap again');
  assert.equal(w.pc.issues.get(issue.id).status, 'done');
});

test('an unreachable Paperclip and a vanished task get short answers', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Gone soon', status: 'todo' });
  const view = await openTask(w, bot, null, issue);

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

  await tap(w, bot, view, 'Assign');
  assert.deepEqual(rowsOf(w, view.message_id), [['Dev'], ['Lead'], ['◀ Back']]);
  assert.match(textOf(w, view.message_id), /Assignee: Dev/, 'the text stays while the picker is open');

  await tap(w, bot, view, 'Back');
  assert.equal(rowsOf(w, view.message_id).length, 4);
  assert.equal(patches(w).length, 0);

  await tap(w, bot, view, 'Assign');
  await tap(w, bot, view, 'Lead');
  assert.deepEqual(patches(w).map((r) => r.body), [{ assigneeAgentId: LEAD_AGENT_ID, assigneeUserId: null }]);
  assert.match(textOf(w, view.message_id), /Assignee: Lead/);
  assert.equal(rowsOf(w, view.message_id).length, 4, 'the main buttons are back');
});

test('assigning a task that is assigned to the owner clears the owner assignee', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Mine', status: 'todo', assigneeUserId: 'board-user-1' });
  const view = await openTask(w, bot, null, issue);
  assert.match(view.text, /Assignee: You/);
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

  await tap(w, bot, view, 'Project');
  let rows = rowsOf(w, view.message_id);
  assert.deepEqual(rows.slice(0, 8).flat(), Array.from({ length: 8 }, (_, i) => `Project ${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(rows[8], ['1/2', '▶']);
  assert.deepEqual(rows[9], ['🚫 No project', '◀ Back']);

  await tap(w, bot, view, '▶');
  rows = rowsOf(w, view.message_id);
  assert.deepEqual(rows.slice(0, 2).flat(), ['Project 09', 'Project 10']);
  assert.deepEqual(rows[2], ['◀', '2/2']);
  assert.ok(!rows.flat().includes('Old project'));

  await tap(w, bot, view, 'Project 10');
  const chosen = w.pc.projects.find((p) => p.name === 'Project 10');
  assert.deepEqual(patches(w).map((r) => r.body), [{ projectId: chosen.id }]);
  assert.match(textOf(w, view.message_id), /^Project: Project 10$/m);

  await tap(w, bot, view, 'Project');
  await tap(w, bot, view, 'No project');
  assert.deepEqual(patches(w).at(-1).body, { projectId: null });
  assert.match(textOf(w, view.message_id), /^Project: None$/m);
});

test('Follow and Unfollow switch following and the button', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Keep an eye', status: 'in_progress' });
  const old = w.pc.addComment(issue.id, { body: 'Old comment' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'Follow');
  assert.equal(w.tg.callbackAnswers.at(-1).text, '🔔 Following');
  assert.deepEqual(rowsOf(w, view.message_id).at(-1), ['🔕 Unfollow']);
  assert.equal(bot.state.following.get(issue.id).lastSeenCommentId, old.id, 'following starts after the newest comment');

  await tap(w, bot, view, 'Unfollow');
  assert.equal(w.tg.callbackAnswers.at(-1).text, '🔕 Unfollowed');
  assert.deepEqual(rowsOf(w, view.message_id).at(-1), ['🔔 Follow']);
  assert.equal(bot.state.following.size, 0);
});

test('Comment asks for a reply and the reply becomes a comment on the task', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Talk to me', status: 'in_progress' });
  const view = await openTask(w, bot, null, issue);

  await tap(w, bot, view, 'Comment');
  const prompt = w.tg.lastMessage();
  assert.equal(prompt.replyTo, view.message_id);
  assert.deepEqual(prompt.markup, { force_reply: true, input_field_placeholder: 'Comment' });
  assert.match(prompt.text, /TST-1/);

  await bot.handleUpdate(w.tg.message('Looks good, ship it', { replyTo: prompt.message_id }));
  const [comment] = posts(w, '/comments');
  assert.deepEqual(comment.body, { body: 'Looks good, ship it' });
  assert.match(comment.path, new RegExp(`/api/issues/${issue.id}/comments$`));
  assert.match(w.tg.lastMessage().text, /^💬 Posted on /);
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
  assert.deepEqual(rowsOf(w, done.message_id), [['📋 Task']]);

  await tap(w, bot, done, 'Task');
  const view = w.tg.lastMessage();
  assert.notEqual(view.message_id, done.message_id);
  assert.match(view.text, /<b>TST-1<\/b> Finished work/);
  assert.ok(rowsOf(w, view.message_id).length >= 4);

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
  assert.deepEqual(rowsOf(w, review.message_id), [['📋 Task']]);
  assert.deepEqual(rowsOf(w, failed.message_id), [['📋 Task']]);
  assert.deepEqual(rowsOf(w, orphan.message_id), []);
  assert.equal(w.tg.buttons(failed.message_id)[0].callback_data, `T:v:${issue.id}`);
  assert.ok(failed.text.includes('Open run'), 'the text link stays');

  await tap(w, bot, failed, 'Task');
  assert.match(w.tg.lastMessage().text, /<b>TST-1<\/b> Long job/);
});
