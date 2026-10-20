import assert from 'node:assert/strict';
import test from 'node:test';
import { UI_BASE_URL, outcomePattern, startWorld } from './helpers.js';

async function setup(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const bot = await w.primedBot();
  return { w, bot };
}

const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
// Rows with the colour of each button after its label: "Running [primary]".
const styledRows = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => (b.style ? `${b.text} [${b.style}]` : b.text)));
const issueCalls = (w) => w.pc.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/issues'));
const creates = (w) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/issues'));
const tap = (w, bot, message, label) => bot.handleUpdate(w.tg.tapButton(message.message_id, label));
const OFFER = 'Create a task from this?';
// The offer message once the task exists: its original text, then the outcome that links the new task.
const created = (w, forWho, before = OFFER) => {
  const { identifier } = [...w.pc.issues.values()].at(-1);
  return outcomePattern('Created', `<a href="${UI_BASE_URL}/TST/issues/${identifier}">${identifier}</a> ${forWho}`, { before: `${before}\n\n` });
};

// Three projects with open tasks (the last one touched is the most recent), one with only a finished task, one archived.
function threeProjects(w) {
  const alpha = w.pc.addProject({ name: 'Alpha' });
  const beta = w.pc.addProject({ name: 'Beta' });
  const gamma = w.pc.addProject({ name: 'Gamma' });
  const idle = w.pc.addProject({ name: 'Aardvark' });
  w.pc.addProject({ name: 'Retired', archived: true });
  w.pc.addIssue({ title: 'Alpha one', status: 'todo', projectId: alpha.id });
  w.pc.addIssue({ title: 'Alpha two', status: 'in_progress', projectId: alpha.id });
  w.pc.addIssue({ title: 'Beta one', status: 'blocked', projectId: beta.id });
  w.pc.addIssue({ title: 'Gamma one', status: 'in_review', projectId: gamma.id });
  w.pc.addIssue({ title: 'Gamma two', status: 'todo', projectId: gamma.id });
  w.pc.addIssue({ title: 'Gamma three', status: 'todo', projectId: gamma.id });
  w.pc.addIssue({ title: 'Aardvark done', status: 'done', projectId: idle.id });
  w.pc.addIssue({ title: 'No project', status: 'todo' });
  return { alpha, beta, gamma, idle };
}

test('/projects lists projects with their open task counts, most recently active first', async (t) => {
  const { w, bot } = await setup(t);
  threeProjects(w);
  await bot.handleUpdate(w.tg.message('/projects'));
  const list = w.tg.lastMessage();
  assert.equal(list.text, '<b>Projects</b> (4)');
  assert.deepEqual(rowsOf(w, list.message_id), [['Gamma · 3 open'], ['Beta · 1 open'], ['Alpha · 2 open'], ['Aardvark · 0 open']]);
});

test('/projects counts with one issues call that asks for the open statuses only', async (t) => {
  const { w, bot } = await setup(t);
  threeProjects(w);
  const before = issueCalls(w).length;
  await bot.handleUpdate(w.tg.message('/projects'));
  const calls = issueCalls(w).slice(before);
  assert.equal(calls.length, 1);
  const query = new URLSearchParams(calls[0].query);
  assert.equal(query.get('status'), 'todo,in_progress,in_review,blocked');
  assert.equal(query.get('limit'), '1000');
});

test('/projects with no projects says so', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/projects'));
  assert.equal(w.tg.lastMessage().text, '<b>Projects</b> (0)\nNo projects.');
});

test('a project button opens the open tasks of that project with an All projects button', async (t) => {
  const { w, bot } = await setup(t);
  const { alpha } = threeProjects(w);
  await bot.handleUpdate(w.tg.message('/projects'));
  await tap(w, bot, w.tg.lastMessage(), 'Alpha');

  const view = w.tg.lastMessage();
  assert.equal(view.text, '<b>Open tasks</b> · All open · Alpha · page 1');
  assert.deepEqual(styledRows(w, view.message_id), [
    ['TST-2 · Alpha two'],
    ['TST-1 · Alpha one'],
    ['All open [primary]', 'Running', 'Review'],
    ['Blocked', 'Done'],
    ['All projects'],
  ]);
  const query = new URLSearchParams(issueCalls(w).at(-1).query);
  assert.equal(query.get('projectId'), alpha.id);
  assert.equal(query.get('status'), 'todo,in_progress,in_review,blocked');
});

test('the filter row keeps the project and All projects drops it', async (t) => {
  const { w, bot } = await setup(t);
  const { alpha } = threeProjects(w);
  await bot.handleUpdate(w.tg.message('/projects'));
  await tap(w, bot, w.tg.lastMessage(), 'Alpha');
  const view = w.tg.lastMessage();

  await tap(w, bot, view, 'Running');
  assert.equal(w.tg.messages.get(view.message_id).text, '<b>Open tasks</b> · Running · Alpha · page 1');
  assert.deepEqual(rowsOf(w, view.message_id).slice(0, 1), [['TST-2 · Alpha two']]);
  assert.deepEqual(styledRows(w, view.message_id).slice(1), [['All open', 'Running [primary]', 'Review'], ['Blocked', 'Done'], ['All projects']], 'the active filter is blue inside a project');
  assert.equal(new URLSearchParams(issueCalls(w).at(-1).query).get('projectId'), alpha.id);

  await tap(w, bot, view, 'All projects');
  assert.equal(w.tg.messages.get(view.message_id).text, '<b>Open tasks</b> · Running · page 1');
  assert.equal(new URLSearchParams(issueCalls(w).at(-1).query).get('projectId'), null);
  assert.ok(!rowsOf(w, view.message_id).flat().includes('All projects'));
  assert.ok(rowsOf(w, view.message_id).flat().length > 3, 'tasks of other projects are listed again');
  assert.ok(styledRows(w, view.message_id).at(-2).includes('Running [primary]'), 'the filter stays active');
});

test('paging inside a project keeps the project', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Busy' });
  for (let i = 0; i < 12; i += 1) w.pc.addIssue({ title: `Task ${i}`, status: 'todo', projectId: project.id });
  w.pc.addIssue({ title: 'Elsewhere', status: 'todo' });
  await bot.handleUpdate(w.tg.message('/projects'));
  await tap(w, bot, w.tg.lastMessage(), 'Busy');
  const view = w.tg.lastMessage();
  assert.deepEqual(rowsOf(w, view.message_id).at(-4), ['▶']);
  assert.equal(w.tg.buttons(view.message_id).find((b) => b.text === '▶').callback_data, `L:t:a:1:${project.id}`);

  await tap(w, bot, view, '▶');
  assert.equal(w.tg.messages.get(view.message_id).text, '<b>Open tasks</b> · All open · Busy · page 2');
  const rows = rowsOf(w, view.message_id);
  assert.equal(rows.filter((row) => row[0].startsWith('TST-')).length, 2);
  assert.ok(rows.flat().includes('All projects'));
});

test('many projects are paged ten at a time', async (t) => {
  const { w, bot } = await setup(t);
  for (let i = 0; i < 12; i += 1) w.pc.addProject({ name: `Project ${String(i).padStart(2, '0')}` });
  await bot.handleUpdate(w.tg.message('/projects'));
  const list = w.tg.lastMessage();
  const rows = rowsOf(w, list.message_id);
  assert.equal(rows.length, 11);
  assert.deepEqual(rows.at(-1), ['1/2', '▶']);
  await tap(w, bot, list, '▶');
  const next = rowsOf(w, list.message_id);
  assert.deepEqual(next.map((row) => row[0]), ['Project 10 · 0 open', 'Project 11 · 0 open', '◀']);
  assert.deepEqual(next.at(-1), ['◀', '2/2']);
});

test('project buttons from another user change nothing and unknown ones are answered', async (t) => {
  const { w, bot } = await setup(t);
  threeProjects(w);
  await bot.handleUpdate(w.tg.message('/projects'));
  const list = w.tg.lastMessage();
  const requests = w.pc.requests.length;
  await bot.handleUpdate(w.tg.tapButton(list.message_id, 'Alpha', { from: 2002 }));
  await bot.handleUpdate(w.tg.tapButton(list.message_id, 'Alpha', { chat: 9999 }));
  assert.equal(w.pc.requests.length, requests);
  await bot.handleUpdate(w.tg.tap(list.message_id, 'L:p:not-a-uuid'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await bot.handleUpdate(w.tg.tap(list.message_id, 'L:t:a:0:not-a-uuid'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await bot.handleUpdate(w.tg.tap(list.message_id, 'L:j:-1'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  assert.equal(w.pc.requests.length, requests);
});

test('every callback of the project views stays within 64 bytes', async (t) => {
  const { w, bot } = await setup(t);
  threeProjects(w);
  await bot.handleUpdate(w.tg.message('/projects'));
  const list = w.tg.lastMessage();
  await tap(w, bot, list, 'Alpha');
  const view = w.tg.lastMessage();
  const all = [...w.tg.buttons(list.message_id), ...w.tg.buttons(view.message_id)];
  assert.ok(all.length >= 10);
  for (const b of all) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
});

test('/new without #project asks which project, then creates with the chosen one', async (t) => {
  const { w, bot } = await setup(t);
  const { gamma } = threeProjects(w);
  const update = w.tg.message('/new Write the docs\nAll of them.');
  await bot.handleUpdate(update);

  const question = w.tg.lastMessage();
  assert.equal(question.text, 'Which project?');
  assert.equal(question.replyTo, update.message.message_id);
  assert.deepEqual(rowsOf(w, question.message_id), [['Gamma'], ['Beta'], ['Alpha'], ['Aardvark'], ['No project', 'Cancel']]);
  assert.equal(creates(w).length, 0);

  await tap(w, bot, question, 'Gamma');
  assert.equal(creates(w).length, 1);
  assert.deepEqual(
    { title: creates(w)[0].body.title, description: creates(w)[0].body.description, projectId: creates(w)[0].body.projectId, assigneeAgentId: creates(w)[0].body.assigneeAgentId },
    { title: 'Write the docs', description: 'Write the docs\nAll of them.', projectId: gamma.id, assigneeAgentId: 'agent-lead' },
  );
  assert.equal(creates(w)[0].body.idempotencyKey, `telegram-update-${update.update_id}`);
  assert.match(w.tg.messages.get(question.message_id).text, created(w, 'for Lead in Gamma', 'Which project?'));
  assert.deepEqual(rowsOf(w, question.message_id), []);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Created');
  const view = w.tg.lastMessage();
  const { identifier } = [...w.pc.issues.values()].at(-1);
  assert.equal(
    view.text,
    `<b><a href="${UI_BASE_URL}/TST/issues/${identifier}">${identifier}</a></b> Write the docs\nTo do · Lead · Gamma · updated just now\n<blockquote>Write the docs\nAll of them.</blockquote>`,
    'the new task is shown as a task view',
  );
  assert.deepEqual(rowsOf(w, view.message_id), [['Done', 'More']]);
  assert.equal(bot.state.offers.size, 0);
});

test('No project creates the task without a project', async (t) => {
  const { w, bot } = await setup(t);
  threeProjects(w);
  await bot.handleUpdate(w.tg.message('/new Loose task'));
  const question = w.tg.lastMessage();
  await tap(w, bot, question, 'No project');
  assert.equal(creates(w).length, 1);
  assert.equal('projectId' in creates(w)[0].body, false);
  assert.match(w.tg.messages.get(question.message_id).text, created(w, 'for Lead', 'Which project?'));
});

test('/new @agent without #project keeps the agent through the project question', async (t) => {
  const { w, bot } = await setup(t);
  const { beta } = threeProjects(w);
  await bot.handleUpdate(w.tg.message('/new @dev Fix the bug'));
  const question = w.tg.lastMessage();
  assert.equal(question.text, 'Which project?');
  await tap(w, bot, question, 'Beta');
  assert.equal(creates(w)[0].body.assigneeAgentId, 'agent-1');
  assert.equal(creates(w)[0].body.projectId, beta.id);
  assert.equal(creates(w)[0].body.title, 'Fix the bug');
  assert.match(w.tg.messages.get(question.message_id).text, created(w, 'for Dev in Beta', 'Which project?'));
});

test('/new #project skips the question', async (t) => {
  const { w, bot } = await setup(t);
  const { alpha } = threeProjects(w);
  await bot.handleUpdate(w.tg.message('/new #alpha Direct task'));
  assert.equal(creates(w).length, 1);
  assert.equal(creates(w)[0].body.projectId, alpha.id);
  assert.ok(!w.tg.sent().some((m) => m.text === 'Which project?'));
});

test('/new does not ask when the config names a project or there is none to pick', async (t) => {
  const configured = await setup(t, { config: { newTaskProjectId: 'project-default' } });
  threeProjects(configured.w);
  await configured.bot.handleUpdate(configured.w.tg.message('/new Configured'));
  assert.equal(creates(configured.w).length, 1);
  assert.equal(creates(configured.w)[0].body.projectId, 'project-default');
  assert.ok(!configured.w.tg.sent().some((m) => m.text === 'Which project?'));

  const none = await setup(t);
  await none.bot.handleUpdate(none.w.tg.message('/new No projects exist'));
  assert.equal(creates(none.w).length, 1);
  assert.equal('projectId' in creates(none.w)[0].body, false);
});

test('the project question is paged eight at a time', async (t) => {
  const { w, bot } = await setup(t);
  for (let i = 0; i < 10; i += 1) w.pc.addProject({ name: `Project ${String(i).padStart(2, '0')}` });
  await bot.handleUpdate(w.tg.message('/new Pick one'));
  const question = w.tg.lastMessage();
  const rows = rowsOf(w, question.message_id);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.slice(-2), [['1/2', '▶'], ['No project', 'Cancel']]);

  await tap(w, bot, question, '▶');
  const next = rowsOf(w, question.message_id);
  assert.deepEqual(next.map((row) => row[0]), ['Project 08', 'Project 09', '◀', 'No project']);
  await tap(w, bot, question, 'Project 09');
  assert.equal(creates(w)[0].body.projectId, [...w.pc.projects].find((p) => p.name === 'Project 09').id);
});

test('cancelling the project question creates nothing', async (t) => {
  const { w, bot } = await setup(t);
  threeProjects(w);
  await bot.handleUpdate(w.tg.message('/new Never mind'));
  const question = w.tg.lastMessage();
  await tap(w, bot, question, 'Cancel');
  assert.equal(creates(w).length, 0);
  assert.match(w.tg.messages.get(question.message_id).text, outcomePattern('Cancelled', null, { before: 'Which project?\n\n' }));
  assert.equal(bot.state.offers.size, 0);
});

test('the pending text survives a restart and expires after 24 hours', async (t) => {
  const { w, bot } = await setup(t);
  threeProjects(w);
  await bot.handleUpdate(w.tg.message('/new Remember me'));
  const question = w.tg.lastMessage();
  assert.equal(bot.state.offers.size, 1);

  const restarted = w.makeBot();
  await restarted.handleUpdate(w.tg.tapButton(question.message_id, 'Alpha'));
  assert.equal(creates(w)[0].body.title, 'Remember me');

  await bot.handleUpdate(w.tg.message('/new Too late'));
  const late = w.tg.lastMessage();
  const [, saved] = [...bot.state.offers].at(-1);
  saved.at -= 25 * 60 * 60 * 1000;
  await tap(w, bot, late, 'Alpha');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This offer has expired');
  assert.equal(creates(w).length, 1);
});

test('plain text goes agent choice, then project, then create', async (t) => {
  const { w, bot } = await setup(t);
  const { beta } = threeProjects(w);
  const update = w.tg.message('Plan the migration');
  await bot.handleUpdate(update);
  const offer = w.tg.lastMessage();
  assert.equal(offer.text, 'Create a task from this?');

  await tap(w, bot, offer, 'Other agent');
  await tap(w, bot, offer, 'Dev');
  await tap(w, bot, offer, 'For Dev');
  assert.equal(creates(w).length, 0);
  assert.equal(w.tg.messages.get(offer.message_id).text, `${OFFER}\n\nWhich project?`);
  assert.deepEqual(rowsOf(w, offer.message_id).at(-1), ['No project', 'Cancel']);

  await tap(w, bot, offer, 'Beta');
  assert.equal(creates(w).length, 1);
  assert.equal(creates(w)[0].body.assigneeAgentId, 'agent-1');
  assert.equal(creates(w)[0].body.projectId, beta.id);
  assert.equal(creates(w)[0].body.title, 'Plan the migration');
  assert.match(w.tg.messages.get(offer.message_id).text, created(w, 'for Dev in Beta'));
});

test('For Lead goes straight to the project question and a project is optional', async (t) => {
  const { w, bot } = await setup(t);
  threeProjects(w);
  await bot.handleUpdate(w.tg.message('Another idea'));
  const offer = w.tg.lastMessage();
  await tap(w, bot, offer, 'For Lead');
  assert.equal(w.tg.messages.get(offer.message_id).text, `${OFFER}\n\nWhich project?`);
  await tap(w, bot, offer, 'No project');
  assert.equal(creates(w).length, 1);
  assert.equal('projectId' in creates(w)[0].body, false);
  assert.equal(creates(w)[0].body.assigneeAgentId, 'agent-lead');
});

test('the plain-text offer skips the project question when there is nothing to choose', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('Only idea'));
  await tap(w, bot, w.tg.lastMessage(), 'For Lead');
  assert.equal(creates(w).length, 1);
  assert.ok(!w.tg.sent().some((m) => m.text === 'Which project?'));
});

test('a failed creation keeps the project question so the tap can be repeated', async (t) => {
  const { w, bot } = await setup(t);
  threeProjects(w);
  await bot.handleUpdate(w.tg.message('/new Retry me'));
  const question = w.tg.lastMessage();
  w.pc.failRequests('POST', /\/issues$/, 500, 1);
  await tap(w, bot, question, 'Alpha');
  assert.equal(w.tg.messages.get(question.message_id).text, 'Which project?');
  assert.equal(bot.state.offers.size, 1);
  await tap(w, bot, question, 'Alpha');
  assert.match(w.tg.messages.get(question.message_id).text, created(w, 'for Lead in Alpha', 'Which project?'));
});

test('project question buttons from another user change nothing and every callback fits 64 bytes', async (t) => {
  const { w, bot } = await setup(t);
  threeProjects(w);
  await bot.handleUpdate(w.tg.message('/new Careful'));
  const question = w.tg.lastMessage();
  for (const b of w.tg.buttons(question.message_id)) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
  await bot.handleUpdate(w.tg.tapButton(question.message_id, 'Alpha', { from: 2002 }));
  await bot.handleUpdate(w.tg.tapButton(question.message_id, 'Alpha', { chat: 9999 }));
  assert.equal(creates(w).length, 0);
  assert.equal(bot.state.offers.size, 1);
});

test('/help and the command menu list /projects', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/help'));
  const help = w.tg.lastMessage().text.split('\n');
  const names = help.filter((line) => line.startsWith('/')).map((line) => line.split(' ')[0]);
  assert.deepEqual(names, ['/new', '/task', '/tasks', '/find', '/status', '/following', '/agents', '/projects', '/settings', '/help']);
  assert.ok(help.includes('/projects — projects and their open tasks'));
});
