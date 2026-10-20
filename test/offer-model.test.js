import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CALLBACK_DATA_LIMIT } from '../src/format.js';
import { State } from '../src/state.js';
import { LEAD_AGENT_ID, UI_BASE_URL, outcomePattern, startWorld } from './helpers.js';

const CLAUDE = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
];
const PI = [
  { id: 'openai-codex/gpt-6.1-sol', label: 'openai-codex/gpt-6.1-sol' },
  { id: 'openai-codex/gpt-5.3-codex-spark', label: 'openai-codex/gpt-5.3-codex-spark' },
];
const OFFER = 'Create a task from this?\n\n';
const QUESTION = 'Which project?\n\n';
const link = `<a href="${UI_BASE_URL}/TST/issues/TST-1">TST-1</a>`;

// Lead and Dev are Claude agents on Opus 5.5 at Extra high, Junior is a pi agent on Medium.
async function setup(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  w.pc.models.claude_local = CLAUDE;
  w.pc.models.pi_local = PI;
  const claude = { adapterType: 'claude_local', adapterConfig: { model: 'claude-opus-5-5', effort: 'xhigh', cwd: '/work' } };
  Object.assign(w.pc.agents.find((agent) => agent.id === LEAD_AGENT_ID), claude);
  Object.assign(w.pc.agents.find((agent) => agent.name === 'Dev'), claude);
  w.pc.addAgent({ name: 'Junior', adapterType: 'pi_local', adapterConfig: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' } });
  const bot = await w.primedBot();
  return { w, bot };
}

const creates = (w) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/issues'));
const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const tap = (w, bot, message, label) => bot.handleUpdate(w.tg.tapButton(message.message_id, label));
const toast = (w) => w.tg.callbackAnswers.at(-1).text;
const callbackData = (w, id) => w.tg.buttons(id).map((b) => b.callback_data);
const stateFile = (w) => JSON.parse(fs.readFileSync(w.statePath, 'utf8'));

async function newOffer(w, bot, text = 'Fix the login page') {
  await bot.handleUpdate(w.tg.message(text));
  return w.tg.lastMessage();
}

test('a fresh offer shows the agent, Other agent and the model and level the task will run with', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  assert.deepEqual(rowsOf(w, offer.message_id), [['For Lead', 'Cancel'], ['Other agent'], ['Model · Claude Opus 5.5', 'Reasoning · Extra high']]);
  assert.ok(w.tg.buttons(offer.message_id).every((b) => b.style === undefined), 'plain buttons');
  assert.equal(creates(w).length, 0);
});

test('an agent without a model list or levels gets no third row', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addAgent({ name: 'Plain' });
  w.pc.addAgent({ name: 'Odd', adapterType: 'made_up_local', adapterConfig: { model: 'm-1' } });
  w.pc.models.made_up_local = [{ id: 'm-1', label: 'Model One' }];
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Other agent');
  await tap(w, bot, offer, 'Plain');
  assert.deepEqual(rowsOf(w, offer.message_id), [['For Plain', 'Cancel'], ['Other agent']]);
  await tap(w, bot, offer, 'Other agent');
  await tap(w, bot, offer, 'Odd');
  assert.deepEqual(rowsOf(w, offer.message_id), [['For Odd', 'Cancel'], ['Other agent'], ['Model · Model One']], 'a type outside the table has models but no levels');
});

test('the labels fall back to the agent value and then Default', async (t) => {
  const { w, bot } = await setup(t);
  const lead = w.pc.agents.find((agent) => agent.id === LEAD_AGENT_ID);
  lead.adapterConfig = {};
  await bot.agentRecords({ fresh: true });
  const offer = await newOffer(w, bot);
  assert.deepEqual(rowsOf(w, offer.message_id)[2], ['Model · Default', 'Reasoning · Default']);
  lead.adapterConfig = { model: 'claude-custom-9', effort: 'high' };
  await bot.agentRecords({ fresh: true });
  await tap(w, bot, offer, 'Cancel');
  const next = await newOffer(w, bot, 'Another task');
  assert.deepEqual(rowsOf(w, next.message_id)[2], ['Model · claude-custom-9', 'Reasoning · High']);
});

test('choosing another agent goes back to the offer for that agent and creates nothing', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Other agent');
  await tap(w, bot, offer, 'Junior');
  assert.deepEqual(rowsOf(w, offer.message_id), [['For Junior', 'Cancel'], ['Other agent'], ['Model · openai-codex/gpt-6.1-sol', 'Reasoning · Medium']]);
  assert.equal(creates(w).length, 0);
  assert.equal(toast(w), '');
  assert.equal([...bot.state.offers.values()][0].agentId, w.pc.agents.find((agent) => agent.name === 'Junior').id);

  await tap(w, bot, offer, 'For Junior');
  assert.equal(creates(w)[0].body.assigneeAgentId, w.pc.agents.find((agent) => agent.name === 'Junior').id);
  assert.ok(!('assigneeAdapterOverrides' in creates(w)[0].body));
});

test('the model picker lists Agent default, the models and Back; a pick returns to the offer', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Model ·');
  assert.deepEqual(rowsOf(w, offer.message_id), [['✓ Agent default'], ['Claude Opus 5.5', 'Claude Sonnet 5.5'], ['Claude Haiku 4.5', 'Claude Opus 4.6'], ['◀ Back']]);
  assert.equal(w.tg.buttons(offer.message_id)[0].style, 'primary');
  assert.equal(w.tg.messages.get(offer.message_id).text, 'Create a task from this?', 'the text does not change');

  await tap(w, bot, offer, 'Sonnet');
  assert.equal(toast(w), 'Model: Claude Sonnet 5.5');
  assert.deepEqual(rowsOf(w, offer.message_id), [['For Lead', 'Cancel'], ['Other agent'], ['Model · Claude Sonnet 5.5', 'Reasoning · Extra high']]);
  assert.equal(creates(w).length, 0);
  assert.deepEqual(
    (({ model, reasoning, adapterType }) => ({ model, reasoning, adapterType }))([...bot.state.offers.values()][0]),
    { model: 'claude-sonnet-5-5', reasoning: null, adapterType: 'claude_local' },
  );

  await tap(w, bot, offer, 'Model ·');
  assert.deepEqual(rowsOf(w, offer.message_id)[0], ['Agent default']);
  assert.ok(rowsOf(w, offer.message_id)[1].includes('✓ Claude Sonnet 5.5'));
  await tap(w, bot, offer, 'Back');
  assert.equal(rowsOf(w, offer.message_id).length, 3);
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Agent default');
  assert.equal(toast(w), 'Model: Agent default');
  assert.deepEqual(rowsOf(w, offer.message_id)[2], ['Model · Claude Opus 5.5', 'Reasoning · Extra high']);
  assert.equal([...bot.state.offers.values()][0].adapterType, null, 'nothing is picked any more');
});

test('the reasoning picker lists Default and the levels of the model the task will run with', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Reasoning ·');
  assert.deepEqual(rowsOf(w, offer.message_id), [['✓ Default', 'Low', 'Medium'], ['High', 'Extra high', 'Max'], ['◀ Back']]);

  await tap(w, bot, offer, 'High');
  assert.equal(toast(w), 'Reasoning: High');
  assert.deepEqual(rowsOf(w, offer.message_id)[2], ['Model · Claude Opus 5.5', 'Reasoning · High']);
  await tap(w, bot, offer, 'Reasoning ·');
  assert.equal(w.tg.buttons(offer.message_id).filter((b) => b.style === 'primary').map((b) => b.text).join(), '✓ High');

  // A model that has fewer levels changes the list.
  await tap(w, bot, offer, 'Back');
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Opus 4.6');
  await tap(w, bot, offer, 'Reasoning ·');
  assert.deepEqual(rowsOf(w, offer.message_id), [['Default', 'Low', 'Medium'], ['✓ High', 'Max'], ['◀ Back']]);
});

test('a model and a level picked on the offer go into the new task and the outcome line names them', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Sonnet');
  await tap(w, bot, offer, 'Reasoning ·');
  await tap(w, bot, offer, 'High');
  await tap(w, bot, offer, 'For Lead');

  assert.equal(creates(w).length, 1);
  const { body } = creates(w)[0];
  assert.deepEqual(body.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-sonnet-5-5', effort: 'high' } });
  assert.equal(body.assigneeAgentId, LEAD_AGENT_ID);
  assert.match(w.tg.messages.get(offer.message_id).text, outcomePattern('Created', `${link} for Lead · Claude Sonnet 5.5 · High`, { before: OFFER }));
  assert.deepEqual(rowsOf(w, offer.message_id), []);
  assert.equal([...w.pc.issues.values()][0].assigneeAdapterOverrides.adapterConfig.effort, 'high');
  const view = w.tg.sent().at(-1);
  assert.ok(view.text.split('\n').includes('Model: Claude Sonnet 5.5 · High'), 'the task view shows the override the task was made with');
});

test('the picks are kept through the project question and the outcome names the project too', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Web' });
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Other agent');
  await tap(w, bot, offer, 'Dev');
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Sonnet');
  await tap(w, bot, offer, 'Reasoning ·');
  await tap(w, bot, offer, 'Medium');
  await tap(w, bot, offer, 'For Dev');
  assert.equal(creates(w).length, 0);
  assert.deepEqual(rowsOf(w, offer.message_id), [['Web'], ['No project', 'Cancel']], 'the plain-text offer asks the project with the usual buttons');

  await tap(w, bot, offer, 'Web');
  const { body } = creates(w)[0];
  assert.equal(body.projectId, project.id);
  assert.equal(body.assigneeAgentId, 'agent-1');
  assert.deepEqual(body.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-sonnet-5-5', effort: 'medium' } });
  assert.match(w.tg.messages.get(offer.message_id).text, outcomePattern('Created', `${link} for Dev in Web · Claude Sonnet 5.5 · Medium`, { before: OFFER }));
});

test('a model without levels hides Reasoning, and the agent level is blanked in the override', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Haiku');
  assert.deepEqual(rowsOf(w, offer.message_id)[2], ['Model · Claude Haiku 4.5']);
  await tap(w, bot, offer, 'For Lead');
  assert.deepEqual(creates(w)[0].body.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-haiku-4-5', effort: '' } });
  assert.match(w.tg.messages.get(offer.message_id).text, outcomePattern('Created', `${link} for Lead · Claude Haiku 4.5`, { before: OFFER }));
});

test('a level alone makes an override with the level only, and Default hands it back', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Reasoning ·');
  await tap(w, bot, offer, 'Low');
  await tap(w, bot, offer, 'Reasoning ·');
  await tap(w, bot, offer, 'Default');
  assert.equal(toast(w), 'Reasoning: Default');
  assert.deepEqual(rowsOf(w, offer.message_id)[2], ['Model · Claude Opus 5.5', 'Reasoning · Extra high']);

  await tap(w, bot, offer, 'Reasoning ·');
  await tap(w, bot, offer, 'Low');
  await tap(w, bot, offer, 'For Lead');
  assert.deepEqual(creates(w)[0].body.assigneeAdapterOverrides, { adapterConfig: { effort: 'low' } });
  assert.match(w.tg.messages.get(offer.message_id).text, outcomePattern('Created', `${link} for Lead · Low`, { before: OFFER }));
});

test('a model that does not allow the agent level shows Default for it and blanks it, a pick drops an unfit level', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Opus 4.6');
  assert.deepEqual(rowsOf(w, offer.message_id)[2], ['Model · Claude Opus 4.6', 'Reasoning · Default'], 'Extra high is not allowed for 4.6');
  await tap(w, bot, offer, 'For Lead');
  assert.deepEqual(creates(w)[0].body.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-opus-4-6', effort: '' } });

  const second = await newOffer(w, bot, 'Second task');
  await tap(w, bot, second, 'Reasoning ·');
  await tap(w, bot, second, 'Extra high');
  await tap(w, bot, second, 'Model ·');
  await tap(w, bot, second, 'Opus 4.6');
  assert.deepEqual(rowsOf(w, second.message_id)[2], ['Model · Claude Opus 4.6', 'Reasoning · Default'], 'the picked level went with the model change');
  assert.equal([...bot.state.offers.values()][0].reasoning, null);
});

test('another agent of the same adapter type keeps the model; another type drops the picks and says so', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Sonnet');
  await tap(w, bot, offer, 'Reasoning ·');
  await tap(w, bot, offer, 'High');

  await tap(w, bot, offer, 'Other agent');
  await tap(w, bot, offer, 'Dev');
  assert.equal(toast(w), '');
  assert.deepEqual(rowsOf(w, offer.message_id), [['For Dev', 'Cancel'], ['Other agent'], ['Model · Claude Sonnet 5.5', 'Reasoning · High']]);

  await tap(w, bot, offer, 'Other agent');
  await tap(w, bot, offer, 'Junior');
  assert.equal(toast(w), 'Model and reasoning reset for Junior');
  assert.deepEqual(rowsOf(w, offer.message_id), [['For Junior', 'Cancel'], ['Other agent'], ['Model · openai-codex/gpt-6.1-sol', 'Reasoning · Medium']]);
  const saved = [...bot.state.offers.values()][0];
  assert.deepEqual([saved.model, saved.reasoning, saved.adapterType], [null, null, null]);

  // Back to Claude: nothing from before is left.
  await tap(w, bot, offer, 'Other agent');
  await tap(w, bot, offer, 'Lead');
  assert.deepEqual(rowsOf(w, offer.message_id)[2], ['Model · Claude Opus 5.5', 'Reasoning · Extra high']);
  await tap(w, bot, offer, 'For Lead');
  assert.ok(!('assigneeAdapterOverrides' in creates(w)[0].body));
});

test('a picked level that the next agent model does not allow is dropped with a note', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addAgent({ name: 'Small', adapterType: 'claude_local', adapterConfig: { model: 'claude-haiku-4-5' } });
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Reasoning ·');
  await tap(w, bot, offer, 'Extra high');
  await tap(w, bot, offer, 'Other agent');
  await tap(w, bot, offer, 'Small');
  assert.equal(toast(w), 'Reasoning reset for Small');
  assert.deepEqual(rowsOf(w, offer.message_id), [['For Small', 'Cancel'], ['Other agent'], ['Model · Claude Haiku 4.5']]);
  await tap(w, bot, offer, 'For Small');
  assert.ok(!('assigneeAdapterOverrides' in creates(w)[0].body));
});

test('an offer with nothing picked creates the task exactly as before', async (t) => {
  const { w, bot } = await setup(t);
  const update = w.tg.message('Plain task');
  await bot.handleUpdate(update);
  const offer = w.tg.lastMessage();
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Back');
  await tap(w, bot, offer, 'For Lead');
  assert.deepEqual(creates(w)[0].body, {
    title: 'Plain task',
    description: 'Plain task',
    assigneeAgentId: LEAD_AGENT_ID,
    idempotencyKey: `telegram-update-${update.update_id}`,
  });
  assert.match(w.tg.messages.get(offer.message_id).text, outcomePattern('Created', `${link} for Lead`, { before: OFFER }));
});

test('the picks survive a restart', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Sonnet');
  await tap(w, bot, offer, 'Reasoning ·');
  await tap(w, bot, offer, 'Max');
  const saved = Object.values(stateFile(w).offers)[0];
  assert.deepEqual([saved.model, saved.reasoning, saved.adapterType], ['claude-sonnet-5-5', 'max', 'claude_local']);

  const restarted = w.makeBot();
  const [only] = restarted.state.offers.values();
  assert.deepEqual([only.model, only.reasoning, only.adapterType], ['claude-sonnet-5-5', 'max', 'claude_local']);
  await restarted.handleUpdate(w.tg.tapButton(offer.message_id, 'For Lead'));
  assert.deepEqual(creates(w)[0].body.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-sonnet-5-5', effort: 'max' } });
});

test('an offer saved before the picks existed, or with unusable pick fields, loads as nothing picked', () => {
  const base = { text: 'T', at: 1, messageId: 3 };
  const file = JSON.stringify({ offers: { a: base, b: { ...base, model: 5, reasoning: [], adapterType: {} }, c: { ...base, model: 'm', reasoning: 'low', adapterType: 'pi_local' } } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-telegram-test-'));
  fs.writeFileSync(path.join(dir, 'state.json'), file);
  const state = State.load(path.join(dir, 'state.json'), { warn() {}, info() {}, error() {} });
  assert.deepEqual([...state.offers.values()].map((o) => [o.model, o.reasoning, o.adapterType]), [[null, null, null], [null, null, null], ['m', 'low', 'pi_local']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the picks of an offer made for another adapter type count for nothing', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Sonnet');
  // The agent is moved to another adapter in Paperclip before the offer is used.
  Object.assign(w.pc.agents.find((agent) => agent.id === LEAD_AGENT_ID), { adapterType: 'pi_local', adapterConfig: { model: 'openai-codex/gpt-6.1-sol' } });
  await bot.agentRecords({ fresh: true });
  await tap(w, bot, offer, 'For Lead');
  assert.ok(!('assigneeAdapterOverrides' in creates(w)[0].body));
  assert.match(w.tg.messages.get(offer.message_id).text, outcomePattern('Created', `${link} for Lead`, { before: OFFER }));
});

test('the override is built from the agent as it is when the task is created', async (t) => {
  const { w, bot } = await setup(t);
  const lead = w.pc.agents.find((agent) => agent.id === LEAD_AGENT_ID);
  lead.adapterConfig = { model: 'claude-opus-5-5', effort: 'high' };
  await bot.agentRecords({ fresh: true });
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Opus 4.6');
  assert.deepEqual(rowsOf(w, offer.message_id)[2], ['Model · Claude Opus 4.6', 'Reasoning · High']);
  // The agent's level changed in Paperclip after the agent list was cached, to one this model does not allow.
  lead.adapterConfig = { model: 'claude-opus-5-5', effort: 'xhigh' };
  await tap(w, bot, offer, 'For Lead');
  assert.deepEqual(creates(w)[0].body.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-opus-4-6', effort: '' } });
});

test('a tap on a model button of a list that changed says so and changes nothing', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Model ·');
  const old = w.tg.buttons(offer.message_id).find((b) => b.text === 'Claude Sonnet 5.5');
  w.pc.models.claude_local = [CLAUDE[2], ...CLAUDE.filter((model, i) => i !== 2)];
  await bot.handleUpdate(w.tg.tap(offer.message_id, old.callback_data));
  assert.equal(toast(w), 'List changed, try again');
  assert.deepEqual(rowsOf(w, offer.message_id)[2], ['Model · Claude Opus 5.5', 'Reasoning · Extra high']);
  assert.equal([...bot.state.offers.values()][0].model, null);

  // A level the model does not allow is refused the same way.
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Haiku');
  await bot.handleUpdate(w.tg.tap(offer.message_id, `O:R:${[...bot.state.offers.keys()][0]}:high`));
  assert.equal(toast(w), 'List changed, try again');
  assert.equal([...bot.state.offers.values()][0].reasoning, null);
});

test('a model button of an offer that is gone says it expired', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Model ·');
  const old = w.tg.buttons(offer.message_id).find((b) => b.text === 'Claude Sonnet 5.5');
  await bot.handleUpdate(w.tg.tap(offer.message_id, `O:x:${[...bot.state.offers.keys()][0]}`));
  await bot.handleUpdate(w.tg.tap(offer.message_id, old.callback_data));
  assert.equal(toast(w), 'This offer has expired');
  assert.equal(creates(w).length, 0);
});

test('an agent that cannot take the task any more is reported and Lead takes its place', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Other agent');
  await tap(w, bot, offer, 'Junior');
  w.pc.agents.find((agent) => agent.name === 'Junior').status = 'terminated';
  await bot.agentRecords({ fresh: true });
  await tap(w, bot, offer, 'For Junior');
  assert.equal(toast(w), 'Agent not found');
  assert.equal(creates(w).length, 0);
  assert.deepEqual(rowsOf(w, offer.message_id)[0], ['For Lead', 'Cancel']);
});

test('a failed creation keeps the picks so the tap can be repeated', async (t) => {
  const { w, bot } = await setup(t);
  const offer = await newOffer(w, bot);
  await tap(w, bot, offer, 'Model ·');
  await tap(w, bot, offer, 'Sonnet');
  w.pc.failRequests('POST', /\/issues$/, 500, 1);
  await tap(w, bot, offer, 'For Lead');
  assert.equal(creates(w).length, 1);
  assert.equal(w.pc.issues.size, 0);
  assert.deepEqual(rowsOf(w, offer.message_id)[2], ['Model · Claude Sonnet 5.5', 'Reasoning · Extra high']);

  await tap(w, bot, offer, 'For Lead');
  assert.deepEqual(creates(w)[1].body.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-sonnet-5-5' } });
  assert.equal(w.pc.issues.size, 1);
});

// ---- /new ----

test('/new without #project asks the project with the Model and Reasoning buttons of the agent', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Web' });
  await bot.handleUpdate(w.tg.message('/new @dev Draw the logo'));
  const question = w.tg.lastMessage();
  assert.equal(question.text, 'Which project?');
  assert.deepEqual(rowsOf(w, question.message_id), [['Web'], ['Model · Claude Opus 5.5', 'Reasoning · Extra high'], ['No project', 'Cancel']]);

  await tap(w, bot, question, 'Model ·');
  assert.equal(rowsOf(w, question.message_id)[0][0], '✓ Agent default');
  await tap(w, bot, question, 'Haiku');
  assert.equal(toast(w), 'Model: Claude Haiku 4.5');
  assert.deepEqual(rowsOf(w, question.message_id), [['Web'], ['Model · Claude Haiku 4.5'], ['No project', 'Cancel']]);
  assert.equal(creates(w).length, 0);

  await tap(w, bot, question, 'Web');
  const { body } = creates(w)[0];
  assert.equal(body.assigneeAgentId, 'agent-1');
  assert.equal(body.projectId, project.id);
  assert.deepEqual(body.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-haiku-4-5', effort: '' } });
  assert.match(w.tg.messages.get(question.message_id).text, outcomePattern('Created', `${link} for Dev in Web · Claude Haiku 4.5`, { before: QUESTION }));
});

test('the /new question is for Lead without @agent, and No project creates with the picks', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addProject({ name: 'Web' });
  await bot.handleUpdate(w.tg.message('/new Draw the logo'));
  const question = w.tg.lastMessage();
  await tap(w, bot, question, 'Reasoning ·');
  await tap(w, bot, question, 'Low');
  await tap(w, bot, question, 'No project');
  const { body } = creates(w)[0];
  assert.equal(body.assigneeAgentId, LEAD_AGENT_ID);
  assert.ok(!('projectId' in body));
  assert.deepEqual(body.assigneeAdapterOverrides, { adapterConfig: { effort: 'low' } });
});

test('paging the /new question keeps the buttons, and the picks survive it', async (t) => {
  const { w, bot } = await setup(t);
  for (let i = 0; i < 10; i += 1) w.pc.addProject({ name: `Project ${String(i).padStart(2, '0')}` });
  await bot.handleUpdate(w.tg.message('/new Plan it'));
  const question = w.tg.lastMessage();
  await tap(w, bot, question, 'Model ·');
  await tap(w, bot, question, 'Sonnet');
  await tap(w, bot, question, '▶');
  const rows = rowsOf(w, question.message_id);
  assert.deepEqual(rows.slice(-3), [['◀', '2/2'], ['Model · Claude Sonnet 5.5', 'Reasoning · Extra high'], ['No project', 'Cancel']]);
});

test('/new with #project still creates at once and picks nothing', async (t) => {
  const { w, bot } = await setup(t);
  const project = w.pc.addProject({ name: 'Web', urlKey: 'web' });
  await bot.handleUpdate(w.tg.message('/new @dev #web Draw the logo'));
  assert.equal(creates(w).length, 1);
  assert.equal(creates(w)[0].body.projectId, project.id);
  assert.ok(!('assigneeAdapterOverrides' in creates(w)[0].body));
  assert.ok(!w.tg.sent().some((m) => m.text === 'Which project?'));
});

test('the /new question has no model row when the agent has nothing to pick', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addProject({ name: 'Web' });
  w.pc.addAgent({ name: 'Plain' });
  await bot.handleUpdate(w.tg.message('/new @plain Do it'));
  assert.deepEqual(rowsOf(w, w.tg.lastMessage().message_id), [['Web'], ['No project', 'Cancel']]);
});

// ---- limits ----

test('every callback of the offer stays under 64 bytes with long model ids and real-length agent ids', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addProject({ name: 'Web' });
  const real = w.pc.addAgent({ name: 'Real', adapterType: 'pi_local', adapterConfig: { model: `provider/${'x'.repeat(150)}` } });
  real.id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  w.pc.models.pi_local = Array.from({ length: 99 }, (_, i) => ({ id: `openai-codex/gpt-5.3-codex-spark-${'z'.repeat(80)}-${i}`, label: `Pi ${i}` }));
  const offer = await newOffer(w, bot);
  const all = [...callbackData(w, offer.message_id)];
  await tap(w, bot, offer, 'Other agent');
  all.push(...callbackData(w, offer.message_id));
  await tap(w, bot, offer, 'Real');
  all.push(...callbackData(w, offer.message_id));
  await tap(w, bot, offer, 'Model ·');
  all.push(...callbackData(w, offer.message_id));
  await tap(w, bot, offer, '▶');
  all.push(...callbackData(w, offer.message_id));
  await tap(w, bot, offer, 'Pi 40');
  await tap(w, bot, offer, 'Reasoning ·');
  all.push(...callbackData(w, offer.message_id));
  await tap(w, bot, offer, 'Back');
  await bot.handleUpdate(w.tg.message('/new @real Long one'));
  all.push(...callbackData(w, w.tg.lastMessage().message_id));
  assert.ok(all.length > 60);
  const longest = Math.max(...all.map((data) => Buffer.byteLength(data)));
  assert.ok(longest <= CALLBACK_DATA_LIMIT, `longest callback is ${longest} bytes`);
});
