import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMANDS } from '../src/bot.js';
import { validateTelegramHtml } from './fakes/telegram.js';
import { LEAD_AGENT_ID, UI_BASE_URL, confirmPayload, startWorld } from './helpers.js';

async function setup(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const bot = await w.primedBot();
  return { w, bot };
}

const posts = (w, suffix) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));

test('/new creates a task for the lead agent with the documented body', async (t) => {
  const { w, bot } = await setup(t);
  const update = w.tg.message('/new Fix the login page\nUsers see a blank screen after the redirect.');
  await bot.handleUpdate(update);

  const creates = posts(w, '/issues');
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].body, {
    title: 'Fix the login page',
    description: 'Fix the login page\nUsers see a blank screen after the redirect.',
    assigneeAgentId: LEAD_AGENT_ID,
    idempotencyKey: `telegram-update-${update.update_id}`,
  });
  const reply = w.tg.lastMessage();
  assert.match(reply.text, /^<b>Created<\/b> · TST-1 Fix the login page$/m);
  assert.ok(reply.text.includes(`<a href="${UI_BASE_URL}/TST/issues/TST-1">Open in Paperclip</a>`));
  assert.equal(reply.replyTo, update.message.message_id);
  assert.equal(w.pc.issues.size, 1);
});

test('/new includes the project when one is configured and cuts a long title', async (t) => {
  const { w, bot } = await setup(t, { config: { newTaskProjectId: 'project-9' } });
  const long = 'T'.repeat(150);
  await bot.handleUpdate(w.tg.message(`/new ${long}`));
  const [create] = posts(w, '/issues');
  assert.equal(create.body.projectId, 'project-9');
  assert.equal(Array.from(create.body.title).length, 100);
  assert.ok(create.body.title.endsWith('…'));
  assert.equal(create.body.description, long);
});

test('/new without text explains the usage and creates nothing', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/new'));
  assert.equal(posts(w, '/issues').length, 0);
  assert.match(w.tg.lastMessage().text, /Usage: \/new/);
});

test('/new delivered twice creates one task', async (t) => {
  const { w, bot } = await setup(t);
  const update = w.tg.message('/new Only once');
  await bot.handleUpdate(update);
  await bot.handleUpdate(update);
  assert.equal(w.pc.issues.size, 1);
  assert.match(w.tg.lastMessage().text, /^<b>Task<\/b> · TST-1 Only once\nAlready exists\n/);
});

test('/new accepts the command with a bot name suffix', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/new@my_paperclip_bot Suffix task'));
  assert.equal(posts(w, '/issues')[0].body.title, 'Suffix task');
});

test('/new reports a Paperclip failure instead of failing silently', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.setDropConnections(true);
  await bot.handleUpdate(w.tg.message('/new Unlucky'));
  w.pc.setDropConnections(false);
  assert.equal(w.tg.lastMessage().text, 'Paperclip unreachable, try again');
});

test('a reply to the /new confirmation becomes a comment on the new task', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/new Plan the launch'));
  const confirmation = w.tg.lastMessage();
  await bot.handleUpdate(w.tg.message('Please include a rollback plan', { replyTo: confirmation.message_id }));

  const [comment] = posts(w, '/comments');
  assert.deepEqual(comment.body, { body: 'Please include a rollback plan' });
  assert.match(comment.path, new RegExp(`/api/issues/${[...w.pc.issues.keys()][0]}/comments$`));
  assert.match(w.tg.lastMessage().text, /^<b>Comment<\/b> · TST-1\nPosted\n<a href="[^"]+">Open in Paperclip<\/a>$/);
});

test('a reply to a done message becomes a comment on that task', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Finished work', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  const done = w.tg.findMessage('Done');

  await bot.handleUpdate(w.tg.message('One more thing: please add tests', { replyTo: done.message_id }));
  const [comment] = posts(w, '/comments');
  assert.match(comment.path, new RegExp(`/api/issues/${issue.id}/comments$`));
  assert.deepEqual(comment.body, { body: 'One more thing: please add tests' });
  assert.equal(w.pc.comments.at(-1).authorType, 'user');
});

test('a reply to a message the bot cannot map to a task is declined', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('hello?', { replyTo: 424242 }));
  assert.equal(w.tg.lastMessage().text, "I don't know which task this is");
  assert.equal(posts(w, '/comments').length, 0);

  // Messages that are not about a task (a help text, for instance) are not mapped either.
  await bot.handleUpdate(w.tg.message('/help'));
  const help = w.tg.lastMessage();
  await bot.handleUpdate(w.tg.message('and this?', { replyTo: help.message_id }));
  assert.equal(w.tg.lastMessage().text, "I don't know which task this is");
  assert.equal(posts(w, '/comments').length, 0);
});

test('a reply without text is declined', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/new Photo task'));
  const confirmation = w.tg.lastMessage();
  await bot.handleUpdate(w.tg.message(undefined, { replyTo: confirmation.message_id, extra: { photo: [{ file_id: 'x' }] } }));
  assert.equal(w.tg.lastMessage().text, 'Only text replies are supported');
  assert.equal(posts(w, '/comments').length, 0);
});

test('a message without text and without a reply gets a hint', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message(undefined, { extra: { photo: [{ file_id: 'x' }] } }));
  assert.match(w.tg.lastMessage().text, /Send text to create a task, or reply to a task message/);
  assert.equal(w.pc.requests.filter((r) => r.method === 'POST').length, 0);
});

test('a reply to an open text question answers the question, not the task thread', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Needs details', status: 'in_review' });
  w.pc.addInteraction(issue.id, {
    kind: 'ask_user_questions',
    payload: {
      version: 1,
      questionSet: { schema: 'paperclip.question_set.v1', questions: [{ id: 'detail', prompt: 'What should I know?', answerMode: 'text', required: true }] },
      questions: [{ id: 'detail', prompt: 'What should I know?', selectionMode: 'single', required: true, options: [{ id: 'detail-other', label: 'Other', freeText: true }] }],
    },
  });
  await bot.pollOnce();
  const card = w.tg.findMessage('What should I know?');
  await bot.handleUpdate(w.tg.message('Use the staging cluster', { replyTo: card.message_id }));
  assert.equal(posts(w, '/respond').length, 1);
  assert.equal(posts(w, '/comments').length, 0);

  // Once the question is answered, a reply to the same message is an ordinary comment.
  await bot.handleUpdate(w.tg.message('Thanks for the answer', { replyTo: card.message_id }));
  assert.equal(posts(w, '/comments').length, 1);
});

test('/status lists running work and what waits for the owner as task buttons', async (t) => {
  const { w, bot } = await setup(t);
  const build = w.pc.addIssue({ title: 'Build the API', status: 'in_progress', assigneeAgentId: 'agent-1' });
  const plan = w.pc.addIssue({ title: 'Plan the roadmap', status: 'in_progress', assigneeAgentId: LEAD_AGENT_ID });
  w.pc.addIssue({ title: 'Already finished', status: 'done' });
  const review = w.pc.addIssue({ title: 'Check the draft', status: 'in_review' });
  const asked = w.pc.addIssue({ title: 'Pick a colour', status: 'in_review' });
  w.pc.addInteraction(asked.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'Use blue?' }), title: 'Colour choice' });
  await bot.pollOnce();
  w.tg.calls.length = 0;

  await bot.handleUpdate(w.tg.message('/status'));
  const [running, waiting] = w.tg.callsTo('sendMessage').map((c) => c.params);
  assert.equal(running.text, '<b>Running</b> (2)');
  // Most recently updated first, as the server lists them.
  assert.deepEqual(running.reply_markup.inline_keyboard.flat(), [
    { text: 'TST-2 · Plan the roadmap — Lead', callback_data: `T:v:${plan.id}` },
    { text: 'TST-1 · Build the API — Dev', callback_data: `T:v:${build.id}` },
  ]);
  assert.equal(waiting.text, '<b>Waiting for you</b> (2)');
  assert.deepEqual(
    waiting.reply_markup.inline_keyboard.flat().map((b) => b.text),
    ['TST-5 · Colour choice', `${review.identifier} · Check the draft`],
  );
  assert.ok(!JSON.stringify(waiting).includes('Pick a colour'), 'a review that already has a card is listed once, as the card');
  assert.ok(!JSON.stringify(running).includes('Already finished'));
  assert.equal(validateTelegramHtml(running.text), null);
});

test('/status with nothing to show says so', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/status'));
  const [running, waiting] = w.tg.sent().map((m) => m.text);
  assert.equal(running, '<b>Running</b> (0)\nNothing here.');
  assert.equal(waiting, '<b>Waiting for you</b> (0)\nNothing here.');
});

test('/status shows at most 15 buttons per section plus a remainder', async (t) => {
  const { w, bot } = await setup(t);
  for (let i = 0; i < 40; i += 1) w.pc.addIssue({ title: `Running job ${i}`, status: 'in_progress', assigneeAgentId: 'agent-1' });
  for (let i = 0; i < 20; i += 1) w.pc.addIssue({ title: `Review item ${i}`, status: 'in_review' });
  await bot.handleUpdate(w.tg.message('/status'));
  const [running, waiting] = w.tg.sent();
  assert.match(running.text, /\+25 more/);
  assert.equal(running.markup.inline_keyboard.length, 15);
  assert.match(waiting.text, /\+5 more/);
  assert.equal(waiting.markup.inline_keyboard.length, 15);
  for (const message of w.tg.sent()) assert.ok(message.text.length <= 4096);
});

test('/start and /help list the commands in menu order', async (t) => {
  const { w, bot } = await setup(t);
  for (const command of ['/start', '/help', '/nonsense']) {
    await bot.handleUpdate(w.tg.message(command));
    const text = w.tg.lastMessage().text;
    assert.match(text, /\/new \[@agent\] \[#project\] &lt;text&gt;/);
    const listed = [...text.matchAll(/^\/(\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(listed, COMMANDS.map((c) => c.command));
    assert.equal(validateTelegramHtml(text), null);
  }
});

test('no request to Paperclip carries a run id header', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/new Header check'));
  await bot.handleUpdate(w.tg.message('/status'));
  await bot.handleUpdate(w.tg.message('A comment', { replyTo: w.tg.sent()[0].message_id }));
  assert.ok(w.pc.requests.length > 5);
  for (const request of w.pc.requests) {
    assert.equal(request.headers['x-paperclip-run-id'], undefined);
    assert.equal(request.headers.authorization, `Bearer ${w.pc.token}`);
  }
});
