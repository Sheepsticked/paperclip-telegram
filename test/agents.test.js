import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTelegramHtml } from './fakes/telegram.js';
import { startWorld, waitFor } from './helpers.js';

async function setup(t, options, botOptions) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const bot = await w.primedBot(botOptions);
  return { w, bot };
}

const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const posts = (w, suffix) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));
const tap = (w, bot, message, label, options) => bot.handleUpdate(w.tg.tapButton(message.message_id, label, options));

async function openAgent(w, bot, name = 'Dev') {
  await bot.handleUpdate(w.tg.message('/agents'));
  const list = w.tg.lastMessage();
  const before = w.tg.sent().length;
  await tap(w, bot, list, name);
  assert.equal(w.tg.sent().length, before + 1, 'the agent view is a new message');
  return w.tg.lastMessage();
}

test('the agent view shows the role, status, last run and the tasks in progress as buttons', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.agents[0].title = 'Backend <engineer>';
  w.pc.addIssue({ title: 'Build the API', status: 'in_progress', assigneeAgentId: 'agent-1' });
  w.pc.addIssue({ title: 'Not started', status: 'todo', assigneeAgentId: 'agent-1' });
  w.pc.addIssue({ title: 'Someone else', status: 'in_progress', assigneeAgentId: 'agent-lead' });
  w.pc.addRun({ agentId: 'agent-1', status: 'succeeded' });

  const view = await openAgent(w, bot);
  const lines = view.text.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['<b>Agent</b> · Dev', 'Backend &lt;engineer&gt;', 'Status: Idle']);
  assert.match(lines[3], /^Last run: Succeeded just now$/);
  assert.equal(lines[4], 'In progress: 1');
  assert.equal(validateTelegramHtml(view.text), null);
  assert.deepEqual(rowsOf(w, view.message_id), [['Pause (stops its current run)', 'Run now', 'Refresh'], ['TST-1 · Build the API']]);
  assert.equal(w.tg.buttons(view.message_id).at(-1).callback_data, `T:v:${w.pc.issues.values().next().value.id}`);

  await tap(w, bot, view, 'TST-1 · Build the API');
  assert.ok(w.tg.lastMessage().text.startsWith('<b>Task</b> · TST-1 Build the API'));
});

test('an agent without a title shows its role and one without runs says so', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot, 'Lead');
  assert.deepEqual(view.text.split('\n'), ['<b>Agent</b> · Lead', 'ceo', 'Status: Idle', 'Last run: none yet', 'In progress: 0']);
});

test('a paused agent shows the reason and offers Resume instead of Pause and Run now', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addAgent({ name: 'Sleeper', status: 'paused', pauseReason: 'manual' });
  const view = await openAgent(w, bot, 'Sleeper');
  assert.ok(view.text.includes('Status: Paused (manual)'));
  assert.deepEqual(rowsOf(w, view.message_id), [['Resume', 'Refresh']]);
});

test('Pause needs a second tap, then pauses the agent and shows Resume', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Long job', status: 'in_progress', assigneeAgentId: 'agent-1' });
  const run = w.pc.addRun({ agentId: 'agent-1', issueId: issue.id, status: 'running' });
  const view = await openAgent(w, bot);

  await tap(w, bot, view, 'Pause');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Tap again to confirm');
  assert.deepEqual(rowsOf(w, view.message_id)[0], ['Tap again to confirm', 'Run now', 'Refresh']);
  assert.equal(posts(w, '/pause').length, 0);
  assert.equal(w.pc.agents[0].status, 'idle');

  await tap(w, bot, view, 'Tap again to confirm');
  assert.equal(posts(w, '/pause').length, 1);
  assert.equal(posts(w, '/pause')[0].path, '/api/agents/agent-1/pause');
  assert.equal(w.pc.agents[0].status, 'paused');
  assert.equal(w.pc.runs.find((r) => r.id === run.id).status, 'cancelled');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Paused');
  assert.ok(w.tg.messages.get(view.message_id).text.includes('Status: Paused (manual)'));
  assert.deepEqual(rowsOf(w, view.message_id)[0], ['Resume', 'Refresh']);
});

test('the Pause confirmation goes back to normal when the window ends', async (t) => {
  const { w, bot } = await setup(t, undefined, { confirmMs: 300 });
  const view = await openAgent(w, bot);
  await tap(w, bot, view, 'Pause');
  await waitFor(() => rowsOf(w, view.message_id)[0][0].startsWith('Pause'), { label: 'button reset' });
  await tap(w, bot, view, 'Pause');
  assert.equal(posts(w, '/pause').length, 0, 'a late tap arms the button again');
});

test('Resume resumes the agent at once', async (t) => {
  const { w, bot } = await setup(t);
  const agent = w.pc.addAgent({ name: 'Sleeper', status: 'paused', pauseReason: 'manual' });
  const view = await openAgent(w, bot, 'Sleeper');
  await tap(w, bot, view, 'Resume');
  assert.equal(posts(w, '/resume').length, 1);
  assert.equal(posts(w, '/resume')[0].path, `/api/agents/${agent.id}/resume`);
  assert.equal(agent.status, 'idle');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Resumed');
  assert.ok(w.tg.messages.get(view.message_id).text.includes('Status: Idle'));
  assert.deepEqual(rowsOf(w, view.message_id)[0], ['Pause (stops its current run)', 'Run now', 'Refresh']);
});

test('Run now starts a run with an empty body and shows it as the last run', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  await tap(w, bot, view, 'Run now');
  assert.equal(posts(w, '/heartbeat/invoke').length, 1);
  assert.equal(posts(w, '/heartbeat/invoke')[0].path, '/api/agents/agent-1/heartbeat/invoke');
  assert.deepEqual(posts(w, '/heartbeat/invoke')[0].body, {});
  assert.equal(w.pc.runs.length, 1);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Run started');
  assert.match(w.tg.messages.get(view.message_id).text, /Last run: Queued just now/);
});

test('Run now on an agent that was paused meanwhile says nothing was started', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  w.pc.agents[0].status = 'paused';
  await tap(w, bot, view, 'Run now');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Nothing was started');
  assert.equal(w.pc.runs.length, 0);
  assert.ok(w.tg.messages.get(view.message_id).text.includes('Status: Paused'));
});

test('Refresh re-reads the agent and edits the same message', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  w.pc.addIssue({ title: 'New work', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await tap(w, bot, view, 'Refresh');
  assert.ok(w.tg.messages.get(view.message_id).text.includes('In progress: 1'));
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['TST-1 · New work']);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Refreshed');
});

test('a terminated agent has only Refresh', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addAgent({ name: 'Gone', status: 'terminated' });
  const view = await openAgent(w, bot, 'Gone');
  assert.deepEqual(rowsOf(w, view.message_id), [['Refresh']]);
});

test('a rejected or failed agent action is answered and leaves the view alone', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  const text = w.tg.messages.get(view.message_id).text;
  w.pc.failRequests('POST', /\/heartbeat\/invoke$/, 409, 1, 'Cannot run this agent right now');
  await tap(w, bot, view, 'Run now');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Cannot run this agent right now');
  assert.equal(w.tg.callbackAnswers.at(-1).alert, true);
  assert.equal(w.tg.messages.get(view.message_id).text, text);

  w.pc.agents.splice(0, 1);
  await tap(w, bot, view, 'Refresh');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Agent not found');
});

test('agent buttons from another user or chat change nothing', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  const requests = w.pc.requests.length;
  await tap(w, bot, view, 'Run now', { from: 2002 });
  await tap(w, bot, view, 'Pause', { chat: 9999 });
  await bot.handleUpdate(w.tg.tap(view.message_id, 'G:v:agent-1', { from: 2002 }));
  assert.equal(w.pc.requests.length, requests);
  assert.equal(bot.armedOps(view.message_id).size, 0);
});

test('unknown agent buttons are answered without calling Paperclip', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  const requests = w.pc.requests.length;
  await bot.handleUpdate(w.tg.tap(view.message_id, 'G:z:agent-1'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await bot.handleUpdate(w.tg.tap(view.message_id, 'G:v'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  assert.equal(w.pc.requests.length, requests);
});

test('every agent callback stays within 64 bytes, even for a UUID agent id', async (t) => {
  const { w, bot } = await setup(t);
  const agent = w.pc.addAgent({ name: 'Long id' });
  agent.id = '123e4567-e89b-12d3-a456-426614174000';
  await bot.handleUpdate(w.tg.message('/agents'));
  const list = w.tg.lastMessage();
  const data = w.tg.buttons(list.message_id).map((b) => b.callback_data);
  assert.ok(data.includes(`G:v:${agent.id}`));
  await bot.handleUpdate(w.tg.tapButton(list.message_id, 'Long id'));
  const view = w.tg.lastMessage();
  const all = [...data, ...w.tg.buttons(view.message_id).map((b) => b.callback_data)];
  assert.ok(all.length >= 6);
  for (const item of all) assert.ok(Buffer.byteLength(item) <= 64, item);
});

// A task with an agent run that holds its execution lock.
function runningTask(w, fields = {}) {
  const issue = w.pc.addIssue({ title: 'Long job', status: 'in_progress', assigneeAgentId: 'agent-1', ...fields });
  const run = w.pc.addRun({ agentId: 'agent-1', issueId: issue.id, status: 'running' });
  return { issue, run };
}

async function openTask(w, bot, issue) {
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  return w.tg.lastMessage();
}

test('a task with an active run shows who is running it and a Stop run button', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, run } = runningTask(w);
  const view = await openTask(w, bot, issue);
  const lines = view.text.split('\n');
  assert.ok(lines.includes('Running: Dev'));
  assert.ok(lines.indexOf('Running: Dev') < lines.indexOf('Assignee: Dev'));
  assert.deepEqual(rowsOf(w, view.message_id).at(-1), ['Stop run']);
  assert.equal(w.tg.buttons(view.message_id).at(-1).callback_data, `T:s:${issue.id}:${run.id.slice(0, 8)}`);
  assert.equal(validateTelegramHtml(view.text), null);
});

test('a task without an active run has no Running line and no Stop run button', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Quiet', status: 'in_progress', assigneeAgentId: 'agent-1' });
  w.pc.addRun({ agentId: 'agent-1', issueId: issue.id, status: 'succeeded' });
  const view = await openTask(w, bot, issue);
  assert.ok(!view.text.includes('Running:'));
  assert.ok(!rowsOf(w, view.message_id).flat().includes('Stop run'));
});

test('a running task without an assignee names the agent from the run', async (t) => {
  const { w, bot } = await setup(t);
  const { issue } = runningTask(w, { assigneeAgentId: null });
  const view = await openTask(w, bot, issue);
  assert.ok(view.text.split('\n').includes('Running: Dev'));
});

test('the Running line names the agent that holds the run, not the assignee', async (t) => {
  const { w, bot } = await setup(t);
  const { issue } = runningTask(w, { assigneeAgentId: 'agent-lead' });
  const view = await openTask(w, bot, issue);
  const lines = view.text.split('\n');
  assert.ok(lines.includes('Running: Dev'));
  assert.ok(lines.includes('Assignee: Lead'));
});

test('the Running line says an agent when the run holder is unknown', async (t) => {
  const { w, bot } = await setup(t);
  const { issue } = runningTask(w);
  w.pc.issues.get(issue.id).executionAgentNameKey = 'someone-removed';
  const view = await openTask(w, bot, issue);
  assert.ok(view.text.split('\n').includes('Running: An agent'));
});

test('Stop run needs a second tap, then cancels the run and redraws the view', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, run } = runningTask(w);
  const view = await openTask(w, bot, issue);

  await tap(w, bot, view, 'Stop run');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Tap again to confirm');
  assert.deepEqual(rowsOf(w, view.message_id).at(-1), ['Tap again to confirm']);
  assert.equal(posts(w, '/cancel').length, 0);
  assert.equal(w.pc.runs[0].status, 'running');

  await tap(w, bot, view, 'Tap again to confirm');
  assert.equal(posts(w, '/cancel').length, 1);
  assert.equal(posts(w, '/cancel')[0].path, `/api/heartbeat-runs/${run.id}/cancel`);
  assert.equal(w.pc.runs[0].status, 'cancelled');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Run stopped');
  assert.ok(!w.tg.messages.get(view.message_id).text.includes('Running:'));
  assert.ok(!rowsOf(w, view.message_id).flat().includes('Stop run'));
});

test('Stop run does nothing when the run ended or another run took over', async (t) => {
  const { w, bot } = await setup(t);
  const { issue, run } = runningTask(w);
  const view = await openTask(w, bot, issue);
  await tap(w, bot, view, 'Stop run');

  // The shown run ends and a new one starts before the confirming tap.
  const next = w.pc.addRun({ agentId: 'agent-1', issueId: issue.id, status: 'running' });
  await tap(w, bot, view, 'Tap again to confirm');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'The run already ended');
  assert.equal(posts(w, '/cancel').length, 0);
  assert.equal(w.pc.runs.find((r) => r.id === next.id).status, 'running');
  assert.notEqual(run.id, next.id);
  assert.deepEqual(rowsOf(w, view.message_id).at(-1), ['Stop run']);
});

test('Stop run from another user changes nothing', async (t) => {
  const { w, bot } = await setup(t);
  const { issue } = runningTask(w);
  const view = await openTask(w, bot, issue);
  await tap(w, bot, view, 'Stop run', { from: 2002 });
  await tap(w, bot, view, 'Stop run', { from: 2002 });
  assert.equal(posts(w, '/cancel').length, 0);
});
