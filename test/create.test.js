import assert from 'node:assert/strict';
import test from 'node:test';
import { LEAD_AGENT_ID, startWorld } from './helpers.js';

async function setup(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const bot = await w.primedBot();
  return { w, bot };
}

const creates = (w) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/issues'));
const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const HOUR = 60 * 60 * 1000;

test('/new @agent #project assigns the named agent and project', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Web Site', urlKey: 'web-site' });
  w.pc.addAgent({ name: 'Design Bot' });
  const designer = w.pc.agents.at(-1);

  await bot.handleUpdate(w.tg.message('/new @DESIGNBOT #web-site Draw the logo\nIn blue.'));
  assert.equal(creates(w).length, 1);
  const { body } = creates(w)[0];
  assert.equal(body.assigneeAgentId, designer.id);
  assert.equal(body.projectId, project.id);
  assert.equal(body.title, 'Draw the logo');
  assert.equal(body.description, 'Draw the logo\nIn blue.');
});

test('/new matches a project by its name with spaces and dashes ignored', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Web Site', urlKey: 'ws' });
  await bot.handleUpdate(w.tg.message('/new #website Fix the footer'));
  assert.equal(creates(w)[0].body.projectId, project.id);
  assert.equal(creates(w)[0].body.title, 'Fix the footer');
});

test('/new with an unknown agent or project lists the valid ones and creates nothing', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addProject({ name: 'Website', urlKey: 'website' });
  w.pc.addAgent({ name: 'Retired', status: 'terminated' });

  await bot.handleUpdate(w.tg.message('/new @nobody Do something'));
  assert.equal(w.tg.lastMessage().text, 'Unknown agent @nobody. Available: @dev, @lead');

  await bot.handleUpdate(w.tg.message('/new #nothing Do something'));
  assert.equal(w.tg.lastMessage().text, 'Unknown project #nothing. Available: #website');

  await bot.handleUpdate(w.tg.message('/new @retired Do something'));
  assert.match(w.tg.lastMessage().text, /^Unknown agent @retired\./);
  assert.equal(creates(w).length, 0);
});

test('/new with only a target and no text explains the usage', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/new @dev'));
  assert.match(w.tg.lastMessage().text, /^Usage: \/new \[@agent\] \[#project\] &lt;text&gt;/);
  assert.equal(creates(w).length, 0);
});

test('/new keeps text that only looks like a target', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/new Ask @dev about #12'));
  assert.equal(creates(w)[0].body.title, 'Ask @dev about #12');
  assert.equal(creates(w)[0].body.assigneeAgentId, LEAD_AGENT_ID);
});

test('a configured default project is used unless #project names another one', async (t) => {
  const { w, bot } = await setup(t, { config: { newTaskProjectId: 'project-default' } });
  const other = w.pc.addProject({ name: 'Other' });
  await bot.handleUpdate(w.tg.message('/new Plain task'));
  assert.equal(creates(w)[0].body.projectId, 'project-default');
  await bot.handleUpdate(w.tg.message('/new #other Special task'));
  assert.equal(creates(w)[1].body.projectId, other.id);
});

test('/new answers with the task view and follows the new task', async (t) => {
  const { w, bot } = await setup(t);
  const update = w.tg.message('/new Plan the launch');
  await bot.handleUpdate(update);

  const view = w.tg.lastMessage();
  assert.match(view.text, /^✅ Created <b>TST-1<\/b> Plan the launch$/m);
  assert.match(view.text, /Assignee: Lead/);
  assert.equal(view.replyTo, update.message.message_id);
  assert.deepEqual(rowsOf(w, view.message_id).at(-1), ['🔕 Unfollow']);
  const issueId = [...w.pc.issues.keys()][0];
  assert.ok(bot.state.isFollowing(issueId));
});

test('a new task is not followed when auto-follow is off', async (t) => {
  const { w, bot } = await setup(t);
  bot.state.settings.autoFollowCreated = false;
  await bot.handleUpdate(w.tg.message('/new Quiet task'));
  assert.equal(bot.state.following.size, 0);
  assert.deepEqual(rowsOf(w, w.tg.lastMessage().message_id).at(-1), ['🔔 Follow']);
});

test('a task that already exists is shown but not followed again', async (t) => {
  const { w, bot } = await setup(t);
  const update = w.tg.message('/new Only once');
  await bot.handleUpdate(update);
  const issueId = [...w.pc.issues.keys()][0];
  bot.state.unfollow(issueId);
  await bot.handleUpdate(update);
  assert.match(w.tg.lastMessage().text, /^✅ Already exists <b>TST-1<\/b>/m);
  assert.equal(bot.state.following.size, 0);
});

test('/new still confirms when the new task cannot be read back', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.failRequests('GET', /\/api\/issues\/[^/]+$/, 500);
  await bot.handleUpdate(w.tg.message('/new Created anyway'));
  const reply = w.tg.lastMessage();
  assert.match(reply.text, /^✅ Created <b>TST-1<\/b>\n<a href="[^"]+">Open in Paperclip<\/a>$/);
  assert.deepEqual(rowsOf(w, reply.message_id), [['📋 Task']]);
  assert.equal(creates(w).length, 1);
});

test('plain text offers to create a task and creates nothing yet', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.agents.find((a) => a.id === LEAD_AGENT_ID).name = 'Chief';
  const update = w.tg.message('Fix the login page\nUsers see a blank screen.');
  await bot.handleUpdate(update);

  const offer = w.tg.lastMessage();
  assert.equal(offer.text, 'Create a task from this?');
  assert.equal(offer.replyTo, update.message.message_id);
  assert.deepEqual(rowsOf(w, offer.message_id), [['✅ For Chief', '👤 Other agent…', '✖']]);
  assert.equal(creates(w).length, 0);
  assert.equal(bot.state.offers.size, 1);
});

test('For Lead creates the task from the original message and replies with the task view', async (t) => {
  const { w, bot } = await setup(t);
  const update = w.tg.message('Fix the login page\nUsers see a blank screen.');
  await bot.handleUpdate(update);
  const offer = w.tg.lastMessage();

  await bot.handleUpdate(w.tg.tapButton(offer.message_id, 'For Lead'));
  assert.deepEqual(creates(w).map((r) => r.body), [
    {
      title: 'Fix the login page',
      description: 'Fix the login page\nUsers see a blank screen.',
      assigneeAgentId: LEAD_AGENT_ID,
      idempotencyKey: `telegram-update-${update.update_id}`,
    },
  ]);
  const view = w.tg.sent().at(-1);
  assert.match(view.text, /^✅ Created <b>TST-1<\/b> Fix the login page$/m);
  assert.equal(view.replyTo, update.message.message_id);
  assert.equal(w.tg.messages.get(offer.message_id).text, '✅ Created for Lead');
  assert.deepEqual(rowsOf(w, offer.message_id), []);
  assert.equal(bot.state.offers.size, 0);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Created');

  // A second tap on the same offer finds nothing and creates nothing.
  await bot.handleUpdate(w.tg.tap(offer.message_id, 'O:y:1'));
  assert.equal(creates(w).length, 1);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This offer has expired');
});

test('Other agent shows a picker, Back returns, and the chosen agent gets the task', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addAgent({ name: 'Retired', status: 'terminated' });
  await bot.handleUpdate(w.tg.message('Review the budget'));
  const offer = w.tg.lastMessage();

  await bot.handleUpdate(w.tg.tapButton(offer.message_id, 'Other agent'));
  assert.deepEqual(rowsOf(w, offer.message_id), [['Dev'], ['Lead'], ['◀ Back']]);
  await bot.handleUpdate(w.tg.tapButton(offer.message_id, 'Back'));
  assert.deepEqual(rowsOf(w, offer.message_id), [['✅ For Lead', '👤 Other agent…', '✖']]);
  assert.equal(creates(w).length, 0);

  await bot.handleUpdate(w.tg.tapButton(offer.message_id, 'Other agent'));
  await bot.handleUpdate(w.tg.tapButton(offer.message_id, 'Dev'));
  assert.equal(creates(w)[0].body.assigneeAgentId, 'agent-1');
  assert.equal(w.tg.messages.get(offer.message_id).text, '✅ Created for Dev');
});

test('the dismiss button drops the offer', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('Never mind this'));
  const offer = w.tg.lastMessage();
  await bot.handleUpdate(w.tg.tapButton(offer.message_id, '✖'));
  assert.equal(w.tg.messages.get(offer.message_id).text, 'Dismissed.');
  assert.equal(bot.state.offers.size, 0);
  assert.equal(creates(w).length, 0);
});

test('an offer expires after 24 hours and the poll prunes it', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('Old idea'));
  const offer = w.tg.lastMessage();
  const [key, saved] = [...bot.state.offers][0];

  saved.at -= 23 * HOUR;
  await bot.pollOnce();
  assert.equal(bot.state.offers.size, 1, 'a 23 hour old offer is still valid');

  saved.at -= 2 * HOUR;
  await bot.handleUpdate(w.tg.tapButton(offer.message_id, 'For Lead'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This offer has expired');
  assert.equal(w.tg.messages.get(offer.message_id).text, 'This offer has expired.');
  assert.equal(creates(w).length, 0);

  bot.state.offers.set(key, saved);
  await bot.pollOnce();
  assert.equal(bot.state.offers.size, 0);
});

test('only the newest twenty offers are kept', async (t) => {
  const { w, bot } = await setup(t);
  for (let i = 0; i < 25; i += 1) await bot.handleUpdate(w.tg.message(`Idea ${i}`));
  assert.equal(bot.state.offers.size, 20);
  const oldest = w.tg.sent()[0];
  await bot.handleUpdate(w.tg.tapButton(oldest.message_id, 'For Lead'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This offer has expired');
  assert.equal(creates(w).length, 0);
});

test('an offer survives a restart', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('Remember me'));
  const offer = w.tg.lastMessage();
  const restarted = w.makeBot();
  await restarted.handleUpdate(w.tg.tapButton(offer.message_id, 'For Lead'));
  assert.equal(creates(w)[0].body.title, 'Remember me');
});

test('a failed creation keeps the offer so the tap can be repeated', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('Try twice'));
  const offer = w.tg.lastMessage();

  w.pc.setDropConnections(true);
  await bot.handleUpdate(w.tg.tapButton(offer.message_id, 'For Lead'));
  w.pc.setDropConnections(false);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Paperclip unreachable, try again');
  assert.equal(bot.state.offers.size, 1);
  assert.equal(w.tg.messages.get(offer.message_id).text, 'Create a task from this?');

  await bot.handleUpdate(w.tg.tapButton(offer.message_id, 'For Lead'));
  assert.equal(w.pc.issues.size, 1);
});

test('unknown offer buttons are answered', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('Something'));
  const offer = w.tg.lastMessage();
  await bot.handleUpdate(w.tg.tap(offer.message_id, 'O:q:1'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  await bot.handleUpdate(w.tg.tap(offer.message_id, 'O:y:1', { from: 2002 }));
  assert.equal(creates(w).length, 0);
});
