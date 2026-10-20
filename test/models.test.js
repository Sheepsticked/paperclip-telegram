import assert from 'node:assert/strict';
import test from 'node:test';
import { CALLBACK_DATA_LIMIT } from '../src/format.js';
import {
  agentModelChange,
  agentReasoningChange,
  overrideWithModel,
  overrideWithReasoning,
  overrideWithoutModel,
  reasoningLabel,
  reasoningValues,
} from '../src/models.js';
import { startWorld } from './helpers.js';

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
const CODEX = [
  { id: 'gpt-6.1-sol', label: 'gpt-6.1-sol' },
  { id: 'gpt-5.4', label: 'gpt-5.4' },
];

async function setup(t, options, botOptions) {
  const w = await startWorld(options);
  t.after(() => w.close());
  w.pc.models.claude_local = CLAUDE;
  w.pc.models.pi_local = PI;
  w.pc.models.codex_local = CODEX;
  // Dev is a Claude agent set to Opus 5.5 at Extra high; the extra key must survive every change.
  Object.assign(w.pc.agents[0], { adapterType: 'claude_local', adapterConfig: { model: 'claude-opus-5-5', effort: 'xhigh', cwd: '/work' } });
  const bot = await w.primedBot(botOptions);
  return { w, bot };
}

const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const styledRows = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => (b.style ? `${b.text} [${b.style}]` : b.text)));
const tap = (w, bot, message, label) => bot.handleUpdate(w.tg.tapButton(message.message_id, label));
const answer = (w) => w.tg.callbackAnswers.at(-1).text;
const agentPatches = (w) => w.pc.requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/api/agents/'));
const issuePatches = (w) => w.pc.requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/api/issues/'));
const modelRequests = (w, type) => w.pc.requests.filter((r) => r.path.endsWith(`/adapters/${type}/models`));

async function openAgent(w, bot, name = 'Dev') {
  await bot.handleUpdate(w.tg.message('/agents'));
  const list = w.tg.lastMessage();
  await tap(w, bot, list, name);
  return w.tg.lastMessage();
}

const callbackData = (w, id) => w.tg.buttons(id).map((b) => b.callback_data);

test('the reasoning values follow the adapter rules', () => {
  assert.deepEqual(reasoningValues('claude_local', 'claude-haiku-4-5'), []);
  assert.deepEqual(reasoningValues('claude_local', 'claude-opus-5-5'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(reasoningValues('claude_local', 'claude-opus-4-8'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(reasoningValues('claude_local', 'claude-fable-5-1'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(reasoningValues('claude_local', 'claude-opus-4-6'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(reasoningValues('claude_local', 'us.anthropic.claude-sonnet-4-6-v1'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(reasoningValues('claude_local', 'claude-opus-5-5[1m]'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(reasoningValues('claude_local', 'claude-sonnet-4-5'), ['low', 'medium', 'high']);
  assert.deepEqual(reasoningValues('claude_local', ''), ['low', 'medium', 'high', 'xhigh', 'max'], 'a missing model is the adapter default');
  assert.deepEqual(reasoningValues('codex_local', 'gpt-6.1-sol'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(reasoningValues('codex_local', 'gpt-5.6'), ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'the bare alias is the sol model');
  assert.deepEqual(reasoningValues('codex_local', 'gpt-6-luna'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(reasoningValues('codex_local', 'gpt-5.4'), ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(reasoningValues('pi_local', 'anything'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(reasoningValues('made_up_local', 'x'), []);
  assert.equal(reasoningLabel('xhigh'), 'Extra high');
  assert.equal(reasoningLabel('weird'), 'Weird');
});

test('a new agent model clears a reasoning level the model does not allow, and only then', () => {
  assert.deepEqual(agentModelChange('claude_local', { effort: 'xhigh' }, 'claude-haiku-4-5'), { model: 'claude-haiku-4-5', effort: '' });
  assert.deepEqual(agentModelChange('claude_local', { effort: 'xhigh' }, 'claude-opus-4-6'), { model: 'claude-opus-4-6', effort: '' });
  assert.deepEqual(agentModelChange('claude_local', { effort: 'high' }, 'claude-opus-4-6'), { model: 'claude-opus-4-6' });
  assert.deepEqual(agentModelChange('claude_local', {}, 'claude-haiku-4-5'), { model: 'claude-haiku-4-5' });
  assert.deepEqual(agentModelChange('pi_local', { thinking: 'xhigh' }, 'any/model'), { model: 'any/model' });
  assert.deepEqual(agentModelChange('codex_local', { modelReasoningEffort: 'ultra', reasoningEffort: 'ultra' }, 'gpt-5.4'), {
    model: 'gpt-5.4',
    modelReasoningEffort: '',
    reasoningEffort: '',
  });
  assert.deepEqual(agentReasoningChange('claude_local', { effort: 'high' }, 'max'), { effort: 'max' });
  assert.deepEqual(agentReasoningChange('claude_local', { effort: 'high' }, ''), { effort: '' });
  assert.deepEqual(agentReasoningChange('codex_local', { reasoningEffort: 'low' }, ''), { modelReasoningEffort: '', reasoningEffort: '' });
  assert.deepEqual(agentReasoningChange('codex_local', { reasoningEffort: 'low' }, 'high'), { modelReasoningEffort: 'high' });
});

test('an override keeps its other keys and is null when nothing is left', () => {
  const override = { adapterConfig: { model: 'claude-opus-5-5', effort: 'high', cwd: '/work' }, useProjectWorkspace: false };
  assert.deepEqual(overrideWithoutModel(override), { adapterConfig: { cwd: '/work' }, useProjectWorkspace: false });
  assert.deepEqual(overrideWithoutModel({ adapterConfig: { model: 'x', thinking: 'low' } }), null);
  assert.deepEqual(overrideWithoutModel({ adapterConfig: { model: 'x' }, useProjectWorkspace: true }), { useProjectWorkspace: true });
  assert.equal(overrideWithoutModel(null), null);
  assert.deepEqual(overrideWithModel('claude_local', null, {}, 'claude-sonnet-5-5'), { adapterConfig: { model: 'claude-sonnet-5-5' } });
  // The override's own level goes when the model does not allow it; the agent's level is cleared in the override.
  assert.deepEqual(overrideWithModel('claude_local', { adapterConfig: { effort: 'xhigh' } }, {}, 'claude-opus-4-6'), { adapterConfig: { model: 'claude-opus-4-6' } });
  assert.deepEqual(overrideWithModel('claude_local', null, { effort: 'xhigh' }, 'claude-haiku-4-5'), { adapterConfig: { model: 'claude-haiku-4-5', effort: '' } });
  assert.deepEqual(overrideWithModel('claude_local', null, { effort: 'high' }, 'claude-haiku-4-5'), { adapterConfig: { model: 'claude-haiku-4-5', effort: '' } });
  assert.deepEqual(overrideWithModel('claude_local', null, { effort: 'high' }, 'claude-sonnet-5-5'), { adapterConfig: { model: 'claude-sonnet-5-5' } });
  assert.deepEqual(overrideWithReasoning('claude_local', null, {}, 'high'), { adapterConfig: { effort: 'high' } });
  assert.equal(overrideWithReasoning('claude_local', { adapterConfig: { effort: 'high' } }, {}, ''), null);
  // Handing the level back must not hand on an agent level the override's model does not allow.
  assert.deepEqual(
    overrideWithReasoning('claude_local', { adapterConfig: { model: 'claude-opus-4-6', effort: 'max' } }, { effort: 'xhigh' }, ''),
    { adapterConfig: { model: 'claude-opus-4-6', effort: '' } },
  );
});

test('the agent view shows the model and the reasoning level of a Claude agent', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  assert.deepEqual(styledRows(w, view.message_id), [['Pause (stops its current run) [danger]', 'Run now', 'Refresh'], ['Model · Claude Opus 5.5', 'Reasoning · Extra high']]);
  assert.deepEqual(view.text.split('\n'), ['<b>Agent</b> · Dev', 'engineer', 'Status: Idle', 'Last run: none yet', 'In progress: 0'], 'the buttons are the display: no extra text line');
  for (const data of callbackData(w, view.message_id)) assert.ok(Buffer.byteLength(data) <= CALLBACK_DATA_LIMIT, data);
});

test('an unset model and level show Default, a model missing from the list shows its id, a pi agent shows its thinking level', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.agents[0].adapterConfig = {};
  assert.deepEqual(rowsOf(w, (await openAgent(w, bot)).message_id)[1], ['Model · Default', 'Reasoning · Default']);
  w.pc.agents[0].adapterConfig = { model: 'claude-custom-9' };
  assert.deepEqual(rowsOf(w, (await openAgent(w, bot)).message_id)[1], ['Model · claude-custom-9', 'Reasoning · Default']);
  const junior = w.pc.addAgent({ name: 'Junior', adapterType: 'pi_local', adapterConfig: { model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh' } });
  assert.ok(junior);
  const view = await openAgent(w, bot, 'Junior');
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Model · openai-codex/gpt-6.1-sol', 'Reasoning · Extra high']);
});

test('the reasoning button is hidden for a model without levels, and a type outside the table gets the model button only', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.agents[0].adapterConfig = { model: 'claude-haiku-4-5' };
  assert.deepEqual(rowsOf(w, (await openAgent(w, bot)).message_id)[1], ['Model · Claude Haiku 4.5']);

  w.pc.models.made_up_local = [{ id: 'm-1', label: 'Model One' }];
  w.pc.addAgent({ name: 'Odd', adapterType: 'made_up_local', adapterConfig: { model: 'm-1', effort: 'high' } });
  const odd = await openAgent(w, bot, 'Odd');
  assert.deepEqual(rowsOf(w, odd.message_id), [['Pause (stops its current run)', 'Run now', 'Refresh'], ['Model · Model One']]);

  await tap(w, bot, odd, 'Model · Model One');
  assert.deepEqual(rowsOf(w, odd.message_id), [['✓ Model One'], ['◀ Back']]);
  await tap(w, bot, odd, 'Model One');
  assert.equal(agentPatches(w).length, 0, 'the same model needs no change');
});

test('a failing or empty model list hides the model button and leaves the rest of the view working', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.failRequests('GET', /\/adapters\/claude_local\/models$/, 500);
  const view = await openAgent(w, bot);
  assert.deepEqual(rowsOf(w, view.message_id), [['Pause (stops its current run)', 'Run now', 'Refresh'], ['Reasoning · Extra high']]);
  assert.match(w.allLogText(), /could not load the models/);
  await openAgent(w, bot);
  assert.equal(modelRequests(w, 'claude_local').length, 1, 'a failed list is not asked for again at once');

  w.pc.addAgent({ name: 'Empty', adapterType: 'made_up_local', adapterConfig: { model: 'x' } });
  assert.deepEqual(rowsOf(w, (await openAgent(w, bot, 'Empty')).message_id), [['Pause (stops its current run)', 'Run now', 'Refresh']]);
  w.pc.addAgent({ name: 'Plain' });
  assert.deepEqual(rowsOf(w, (await openAgent(w, bot, 'Plain')).message_id), [['Pause (stops its current run)', 'Run now', 'Refresh']], 'an agent without an adapter has no model controls');
});

test('terminated agents get no model controls', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addAgent({ name: 'Gone', status: 'terminated', adapterType: 'claude_local', adapterConfig: {} });
  assert.deepEqual(rowsOf(w, (await openAgent(w, bot, 'Gone')).message_id), [['Refresh']]);
});

test('the model lists are cached for ten minutes per adapter type', async (t) => {
  let clock = Date.now();
  const { w, bot } = await setup(t, undefined, { now: () => clock });
  await openAgent(w, bot);
  await openAgent(w, bot);
  assert.equal(modelRequests(w, 'claude_local').length, 1);
  clock += 10 * 60 * 1000 + 1;
  await openAgent(w, bot);
  assert.equal(modelRequests(w, 'claude_local').length, 2);
});

test('the model picker edits the message in place and marks the current model', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  const sent = w.tg.sent().length;
  const text = view.text;
  await tap(w, bot, view, 'Model · Claude Opus 5.5');
  assert.deepEqual(styledRows(w, view.message_id), [
    ['✓ Claude Opus 5.5 [primary]', 'Claude Sonnet 5.5'],
    ['Claude Haiku 4.5', 'Claude Opus 4.6'],
    ['◀ Back'],
  ]);
  assert.equal(w.tg.sent().length, sent, 'no new message');
  assert.equal(w.tg.messages.get(view.message_id).text, text);
  assert.equal(agentPatches(w).length, 0);

  await tap(w, bot, view, 'Back');
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Model · Claude Opus 5.5', 'Reasoning · Extra high']);
});

test('picking a model saves it at once with only the model key, answers with a toast and returns to the view', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  const sent = w.tg.sent().length;
  await tap(w, bot, view, 'Model · Claude Opus 5.5');
  await tap(w, bot, view, 'Claude Sonnet 5.5');
  assert.equal(agentPatches(w).length, 1);
  assert.equal(agentPatches(w)[0].path, '/api/agents/agent-1');
  assert.deepEqual(agentPatches(w)[0].body, { adapterConfig: { model: 'claude-sonnet-5-5' } });
  assert.equal(answer(w), 'Model: Claude Sonnet 5.5');
  assert.deepEqual(w.pc.agents[0].adapterConfig, { model: 'claude-sonnet-5-5', effort: 'xhigh', cwd: '/work' }, 'the other keys stay');
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Model · Claude Sonnet 5.5', 'Reasoning · Extra high']);
  assert.equal(w.tg.sent().length, sent);
});

test('a model that does not allow the current level clears it in the same request', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  await tap(w, bot, view, 'Model · Claude Opus 5.5');
  await tap(w, bot, view, 'Claude Opus 4.6');
  assert.deepEqual(agentPatches(w)[0].body, { adapterConfig: { model: 'claude-opus-4-6', effort: '' } });
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Model · Claude Opus 4.6', 'Reasoning · Default']);

  await tap(w, bot, view, 'Model · Claude Opus 4.6');
  await tap(w, bot, view, 'Claude Haiku 4.5');
  assert.deepEqual(agentPatches(w)[1].body, { adapterConfig: { model: 'claude-haiku-4-5' } }, 'nothing to clear');
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Model · Claude Haiku 4.5'], 'Haiku has no levels');
});

test('the reasoning picker offers the values of the model, with Default first', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  await tap(w, bot, view, 'Reasoning · Extra high');
  assert.deepEqual(styledRows(w, view.message_id), [['Default', 'Low', 'Medium'], ['High', '✓ Extra high [primary]', 'Max'], ['◀ Back']]);

  w.pc.agents[0].adapterConfig.model = 'claude-opus-4-6';
  const again = await openAgent(w, bot);
  await tap(w, bot, again, 'Reasoning ·');
  assert.deepEqual(rowsOf(w, again.message_id), [['Default', 'Low', 'Medium'], ['High', 'Max'], ['◀ Back']], 'Opus 4.6 has max and no extra high');

  w.pc.agents[1].adapterType = 'codex_local';
  w.pc.agents[1].adapterConfig = { model: 'gpt-6.1-sol', modelReasoningEffort: 'ultra' };
  const codex = await openAgent(w, bot, 'Lead');
  await tap(w, bot, codex, 'Reasoning · Ultra');
  assert.deepEqual(rowsOf(w, codex.message_id), [['Default', 'Low', 'Medium'], ['High', 'Extra high', 'Max'], ['✓ Ultra'], ['◀ Back']]);

  w.pc.addAgent({ name: 'Junior', adapterType: 'pi_local', adapterConfig: { model: 'openai-codex/gpt-6.1-sol' } });
  const pi = await openAgent(w, bot, 'Junior');
  await tap(w, bot, pi, 'Reasoning · Default');
  assert.deepEqual(rowsOf(w, pi.message_id), [['✓ Default', 'Off', 'Minimal'], ['Low', 'Medium', 'High'], ['Extra high'], ['◀ Back']]);
});

test('picking a level saves only that key; Default empties it', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  await tap(w, bot, view, 'Reasoning · Extra high');
  await tap(w, bot, view, 'Max');
  assert.deepEqual(agentPatches(w)[0].body, { adapterConfig: { effort: 'max' } });
  assert.equal(answer(w), 'Reasoning: Max');
  assert.deepEqual(w.pc.agents[0].adapterConfig, { model: 'claude-opus-5-5', effort: 'max', cwd: '/work' });
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Model · Claude Opus 5.5', 'Reasoning · Max']);

  await tap(w, bot, view, 'Reasoning · Max');
  await tap(w, bot, view, 'Default');
  assert.deepEqual(agentPatches(w)[1].body, { adapterConfig: { effort: '' } });
  assert.equal(answer(w), 'Reasoning: Default');
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Model · Claude Opus 5.5', 'Reasoning · Default']);

  await tap(w, bot, view, 'Reasoning · Default');
  await tap(w, bot, view, 'Default');
  assert.equal(agentPatches(w).length, 2, 'Default on a default level changes nothing');
  assert.ok(agentPatches(w).every((r) => r.body.replaceAdapterConfig === undefined));
});

test('a codex agent with an older level name is cleared under both names by Default', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.agents[1].adapterType = 'codex_local';
  w.pc.agents[1].adapterConfig = { model: 'gpt-5.4', reasoningEffort: 'high' };
  const view = await openAgent(w, bot, 'Lead');
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Model · gpt-5.4', 'Reasoning · High']);
  await tap(w, bot, view, 'Reasoning · High');
  await tap(w, bot, view, 'Default');
  assert.deepEqual(agentPatches(w)[0].body, { adapterConfig: { modelReasoningEffort: '', reasoningEffort: '' } });
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Model · gpt-5.4', 'Reasoning · Default']);
});

test('a tap on a list that changed answers List changed, changes nothing and redraws', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  await tap(w, bot, view, 'Model · Claude Opus 5.5');
  // A model was added in front: the button for Sonnet now points at another place.
  w.pc.models.claude_local = [{ id: 'claude-new-1', label: 'Claude New' }, ...CLAUDE];
  await tap(w, bot, view, 'Claude Sonnet 5.5');
  assert.equal(answer(w), 'List changed, try again');
  assert.equal(agentPatches(w).length, 0);
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Model · Claude Opus 5.5', 'Reasoning · Extra high'], 'the view is back');

  // The same list read again after the change picks the right model.
  await tap(w, bot, view, 'Model · Claude Opus 5.5');
  await tap(w, bot, view, 'Claude Sonnet 5.5');
  assert.deepEqual(agentPatches(w)[0].body, { adapterConfig: { model: 'claude-sonnet-5-5' } });
});

test('a model added at the end does not stale the buttons of the old list', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  await tap(w, bot, view, 'Model · Claude Opus 5.5');
  w.pc.models.claude_local = [...CLAUDE, { id: 'claude-new-1', label: 'Claude New' }];
  await tap(w, bot, view, 'Claude Haiku 4.5');
  assert.deepEqual(agentPatches(w)[0].body, { adapterConfig: { model: 'claude-haiku-4-5', effort: '' } });
});

test('a reasoning tap that the model no longer allows answers List changed', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  await tap(w, bot, view, 'Reasoning · Extra high');
  w.pc.agents[0].adapterConfig.model = 'claude-opus-4-6';
  await tap(w, bot, view, 'Extra high');
  assert.equal(answer(w), 'List changed, try again');
  assert.equal(agentPatches(w).length, 0);
  w.pc.agents[0].adapterConfig.model = 'claude-haiku-4-5';
  await tap(w, bot, view, 'Reasoning ·');
  assert.equal(answer(w), 'No reasoning levels for this model');
});

test('a failing save is reported and leaves the config alone', async (t) => {
  const { w, bot } = await setup(t);
  const view = await openAgent(w, bot);
  await tap(w, bot, view, 'Model · Claude Opus 5.5');
  w.pc.failRequests('PATCH', /^\/api\/agents\//, 403, 1, 'Forbidden');
  await tap(w, bot, view, 'Claude Sonnet 5.5');
  assert.equal(answer(w), 'Forbidden');
  assert.equal(w.pc.agents[0].adapterConfig.model, 'claude-opus-5-5');
});

test('a long list is paged, opens on the page of the current model, and every button fits the callback limit', async (t) => {
  const { w, bot } = await setup(t);
  const longId = `provider/${'x'.repeat(190)}`;
  w.pc.models.claude_local = Array.from({ length: 70 }, (_, i) => ({ id: i === 69 ? longId : `vendor/model-${i}`, label: i === 69 ? longId : `Model ${i}` }));
  w.pc.agents[0].adapterConfig = { model: 'vendor/model-45' };
  const view = await openAgent(w, bot);
  await tap(w, bot, view, 'Model · Model 45');
  let rows = rowsOf(w, view.message_id);
  assert.equal(rows.flat().filter((label) => label.startsWith('Model') || label.startsWith('✓ Model')).length, 30);
  assert.ok(rows.flat().includes('✓ Model 45'), 'opens on the second page');
  assert.deepEqual(rows.at(-2), ['◀', '2/3', '▶']);
  for (const data of callbackData(w, view.message_id)) assert.ok(Buffer.byteLength(data) <= CALLBACK_DATA_LIMIT, data);

  await tap(w, bot, view, '▶');
  rows = rowsOf(w, view.message_id);
  assert.deepEqual(rows.at(-2), ['◀', '3/3']);
  for (const data of callbackData(w, view.message_id)) assert.ok(Buffer.byteLength(data) <= CALLBACK_DATA_LIMIT, data);
  await tap(w, bot, view, 'provider/xxx');
  assert.deepEqual(agentPatches(w)[0].body, { adapterConfig: { model: longId } }, 'the full id is sent, not the shortened button text');
});

test('every callback of the agent pickers stays under 64 bytes with real-length ids', async (t) => {
  const { w, bot } = await setup(t);
  const agent = w.pc.addAgent({ name: 'Real', adapterType: 'pi_local', adapterConfig: {} });
  agent.id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  w.pc.models.pi_local = Array.from({ length: 99 }, (_, i) => ({ id: `openai-codex/gpt-5.3-codex-spark-${'z'.repeat(60)}-${i}`, label: `Pi ${i}` }));
  const view = await openAgent(w, bot, 'Real');
  const all = [...callbackData(w, view.message_id)];
  await tap(w, bot, view, 'Model ·');
  all.push(...callbackData(w, view.message_id));
  await tap(w, bot, view, '▶');
  all.push(...callbackData(w, view.message_id));
  await tap(w, bot, view, 'Back');
  await tap(w, bot, view, 'Reasoning ·');
  all.push(...callbackData(w, view.message_id));
  assert.ok(all.length > 60);
  const longest = Math.max(...all.map((data) => Buffer.byteLength(data)));
  assert.ok(longest <= CALLBACK_DATA_LIMIT, `longest callback is ${longest} bytes`);
});

// ---- the model of one task ----

async function openMore(w, bot, issue) {
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  const view = w.tg.lastMessage();
  await tap(w, bot, view, 'More');
  return view;
}

const withOverride = (override) => (w, assigneeAgentId = 'agent-1') => w.pc.addIssue({ title: 'Tune me', status: 'todo', assigneeAgentId, assigneeAdapterOverrides: override });

test('More offers Model and Reasoning only for an agent whose adapter has them', async (t) => {
  const { w, bot } = await setup(t);
  const issue = withOverride(null)(w);
  const view = await openMore(w, bot, issue);
  assert.deepEqual(styledRows(w, view.message_id), [
    ['Assign', 'Project'],
    ['Model', 'Reasoning'],
    ['Cancel task [danger]'],
    ['Follow'],
    ['Comment'],
    ['Refresh', '◀ Back'],
  ]);
  for (const data of callbackData(w, view.message_id)) assert.ok(Buffer.byteLength(data) <= CALLBACK_DATA_LIMIT, data);

  const noAdapter = await openMore(w, bot, withOverride(null)(w, 'agent-lead'));
  assert.equal(rowsOf(w, noAdapter.message_id).flat().includes('Model'), false);
  const unassigned = await openMore(w, bot, w.pc.addIssue({ title: 'Nobody', status: 'todo' }));
  assert.equal(rowsOf(w, unassigned.message_id).flat().includes('Model'), false);

  w.pc.agents[1].adapterType = 'claude_local';
  w.pc.agents[1].adapterConfig = { model: 'claude-haiku-4-5' };
  await bot.agentRecords({ fresh: true });
  const haiku = await openMore(w, bot, withOverride(null)(w, 'agent-lead'));
  assert.deepEqual(rowsOf(w, haiku.message_id)[1], ['Model'], 'Haiku has no levels');
});

test('the task model picker starts with Agent default and saves an override with only the model', async (t) => {
  const { w, bot } = await setup(t);
  const issue = withOverride(null)(w);
  const view = await openMore(w, bot, issue);
  const sent = w.tg.sent().length;
  await tap(w, bot, view, 'Model');
  assert.deepEqual(styledRows(w, view.message_id), [
    ['✓ Agent default [primary]'],
    ['Claude Opus 5.5', 'Claude Sonnet 5.5'],
    ['Claude Haiku 4.5', 'Claude Opus 4.6'],
    ['◀ Back'],
  ]);
  assert.equal(w.tg.sent().length, sent);

  await tap(w, bot, view, 'Claude Sonnet 5.5');
  assert.equal(issuePatches(w).length, 1);
  assert.deepEqual(issuePatches(w)[0].body, { assigneeAdapterOverrides: { adapterConfig: { model: 'claude-sonnet-5-5' } } });
  assert.equal(answer(w), 'Model: Claude Sonnet 5.5');
  const lines = w.tg.messages.get(view.message_id).text.split('\n');
  assert.equal(lines[2], 'Model: Claude Sonnet 5.5', 'the line follows the status line');
  assert.deepEqual(rowsOf(w, view.message_id), [['Done', 'More']]);
});

test('the model line shows only when an override sets something', async (t) => {
  const { w, bot } = await setup(t);
  const none = withOverride(null)(w);
  await bot.handleUpdate(w.tg.message(`/task ${none.identifier}`));
  assert.equal(w.tg.lastMessage().text.includes('Model:'), false);
  const only = withOverride({ useProjectWorkspace: true })(w);
  await bot.handleUpdate(w.tg.message(`/task ${only.identifier}`));
  assert.equal(w.tg.lastMessage().text.includes('Model:'), false);
  const level = withOverride({ adapterConfig: { effort: 'high' } })(w);
  await bot.handleUpdate(w.tg.message(`/task ${level.identifier}`));
  assert.equal(w.tg.lastMessage().text.split('\n')[2], 'Model: Agent default · High');
  const both = withOverride({ adapterConfig: { model: 'claude-opus-4-6', effort: 'max' } })(w);
  await bot.handleUpdate(w.tg.message(`/task ${both.identifier}`));
  assert.equal(w.tg.lastMessage().text.split('\n')[2], 'Model: Claude Opus 4.6 · Max');
  const unlisted = withOverride({ adapterConfig: { model: 'x<y>' } })(w);
  await bot.handleUpdate(w.tg.message(`/task ${unlisted.identifier}`));
  assert.equal(w.tg.lastMessage().text.split('\n')[2], 'Model: x&lt;y&gt;');
});

test('the task override is set, changed and reset to Agent default, keeping the rest of it', async (t) => {
  const { w, bot } = await setup(t);
  const issue = withOverride({ adapterConfig: { cwd: '/other', model: 'claude-opus-4-6' }, useProjectWorkspace: true })(w);
  const view = await openMore(w, bot, issue);

  await tap(w, bot, view, 'Model');
  assert.ok(rowsOf(w, view.message_id).flat().includes('✓ Claude Opus 4.6'));
  await tap(w, bot, view, 'Claude Haiku 4.5');
  assert.deepEqual(issue.assigneeAdapterOverrides, { adapterConfig: { cwd: '/other', model: 'claude-haiku-4-5', effort: '' }, useProjectWorkspace: true }, 'the agent level Haiku cannot take is cleared');

  await tap(w, bot, view, 'More');
  assert.deepEqual(rowsOf(w, view.message_id)[1], ['Model'], 'Haiku has no levels');
  await tap(w, bot, view, 'Model');
  await tap(w, bot, view, 'Claude Opus 5.5');
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Reasoning');
  assert.deepEqual(styledRows(w, view.message_id), [['✓ Default [primary]', 'Low', 'Medium'], ['High', 'Extra high', 'Max'], ['◀ Back']]);
  await tap(w, bot, view, 'Extra high');
  assert.deepEqual(issuePatches(w).at(-1).body, { assigneeAdapterOverrides: { adapterConfig: { cwd: '/other', model: 'claude-opus-5-5', effort: 'xhigh' }, useProjectWorkspace: true } });
  assert.equal(answer(w), 'Reasoning: Extra high');
  assert.equal(w.tg.messages.get(view.message_id).text.split('\n')[2], 'Model: Claude Opus 5.5 · Extra high');

  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Reasoning');
  assert.ok(rowsOf(w, view.message_id).flat().includes('✓ Extra high'));
  await tap(w, bot, view, 'Default');
  assert.deepEqual(issue.assigneeAdapterOverrides, { adapterConfig: { cwd: '/other', model: 'claude-opus-5-5' }, useProjectWorkspace: true });

  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Model');
  await tap(w, bot, view, 'Agent default');
  assert.equal(answer(w), 'Model: Agent default');
  assert.deepEqual(issue.assigneeAdapterOverrides, { adapterConfig: { cwd: '/other' }, useProjectWorkspace: true }, 'only the model and level keys go');
  assert.equal(w.tg.messages.get(view.message_id).text.includes('Model:'), false);
});

test('Agent default sends null when nothing else is left in the override', async (t) => {
  const { w, bot } = await setup(t);
  const issue = withOverride({ adapterConfig: { model: 'claude-sonnet-5-5', effort: 'high' } })(w);
  const view = await openMore(w, bot, issue);
  await tap(w, bot, view, 'Model');
  await tap(w, bot, view, 'Agent default');
  assert.deepEqual(issuePatches(w).at(-1).body, { assigneeAdapterOverrides: null });
  assert.equal(issue.assigneeAdapterOverrides, null);

  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Model');
  await tap(w, bot, view, 'Agent default');
  assert.equal(issuePatches(w).length, 1, 'no override and Agent default changes nothing');
});

test('a model in a task override drops a level it does not allow and clears an inherited one', async (t) => {
  const { w, bot } = await setup(t);
  const issue = withOverride({ adapterConfig: { effort: 'max' } })(w);
  const view = await openMore(w, bot, issue);
  await tap(w, bot, view, 'Model');
  await tap(w, bot, view, 'Claude Sonnet 5.5');
  assert.deepEqual(issue.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-sonnet-5-5', effort: 'max' } }, 'max is allowed, so it stays');
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Model');
  await tap(w, bot, view, 'Claude Opus 4.6');
  assert.deepEqual(issue.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-opus-4-6', effort: 'max' } });
  w.pc.agents[0].adapterConfig.effort = 'xhigh';
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Model');
  await tap(w, bot, view, 'Claude Haiku 4.5');
  assert.deepEqual(issue.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-haiku-4-5', effort: '' } });
});

test('a task tap after the assignee changed answers List changed and changes nothing', async (t) => {
  const { w, bot } = await setup(t);
  const issue = withOverride(null)(w);
  const view = await openMore(w, bot, issue);
  await tap(w, bot, view, 'Model');
  issue.assigneeAgentId = 'agent-lead';
  await tap(w, bot, view, 'Claude Sonnet 5.5');
  assert.equal(answer(w), 'List changed, try again');
  assert.equal(issuePatches(w).length, 0);
  assert.deepEqual(rowsOf(w, view.message_id), [['Done', 'More']]);

  issue.assigneeAgentId = 'agent-1';
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Model');
  w.pc.models.claude_local = [{ id: 'claude-new-1', label: 'Claude New' }, ...CLAUDE];
  await tap(w, bot, view, 'Claude Sonnet 5.5');
  assert.equal(answer(w), 'List changed, try again');
  assert.equal(issuePatches(w).length, 0);
});

test('every callback of the task model pickers fits the limit with real ids and long model ids', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.agents[0].id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  w.pc.models.claude_local = Array.from({ length: 99 }, (_, i) => ({ id: `provider/${'y'.repeat(150)}-${i}`, label: `Model ${i}` }));
  const issue = withOverride(null)(w, w.pc.agents[0].id);
  await bot.agentRecords({ fresh: true });
  const view = await openMore(w, bot, issue);
  const all = [...callbackData(w, view.message_id)];
  await tap(w, bot, view, 'Model');
  all.push(...callbackData(w, view.message_id));
  await tap(w, bot, view, '▶');
  all.push(...callbackData(w, view.message_id));
  await tap(w, bot, view, 'Back');
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Reasoning');
  all.push(...callbackData(w, view.message_id));
  const longest = Math.max(...all.map((data) => Buffer.byteLength(data)));
  assert.ok(longest <= CALLBACK_DATA_LIMIT, `longest callback is ${longest} bytes`);
});

// ---- reassign ----

async function assignTo(w, bot, issue, name) {
  const view = await openMore(w, bot, issue);
  await tap(w, bot, view, 'Assign');
  await tap(w, bot, view, name);
  return view;
}

test('assigning to an agent of another adapter type clears the model and level of the override only', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addAgent({ name: 'Junior', adapterType: 'pi_local', adapterConfig: {} });
  await bot.agentRecords({ fresh: true });
  const issue = withOverride({ adapterConfig: { model: 'claude-opus-5-5', effort: 'high', cwd: '/other' }, useProjectWorkspace: true })(w);
  await assignTo(w, bot, issue, 'Junior');
  assert.deepEqual(issuePatches(w).at(-1).body, {
    assigneeAgentId: 'agent-3',
    assigneeUserId: null,
    assigneeAdapterOverrides: { adapterConfig: { cwd: '/other' }, useProjectWorkspace: true },
  });
  assert.equal(issue.assigneeAgentId, 'agent-3');

  const alone = withOverride({ adapterConfig: { model: 'claude-opus-5-5' } })(w);
  await assignTo(w, bot, alone, 'Junior');
  assert.deepEqual(issuePatches(w).at(-1).body.assigneeAdapterOverrides, null);
});

test('assigning within one adapter type, or a task without a model override, leaves the override alone', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addAgent({ name: 'Second', adapterType: 'claude_local', adapterConfig: {} });
  w.pc.addAgent({ name: 'Junior', adapterType: 'pi_local', adapterConfig: {} });
  await bot.agentRecords({ fresh: true });
  const same = withOverride({ adapterConfig: { model: 'claude-opus-5-5' } })(w);
  await assignTo(w, bot, same, 'Second');
  assert.deepEqual(issuePatches(w).at(-1).body, { assigneeAgentId: 'agent-3', assigneeUserId: null });
  assert.deepEqual(same.assigneeAdapterOverrides, { adapterConfig: { model: 'claude-opus-5-5' } });

  const workspaceOnly = withOverride({ useProjectWorkspace: true })(w);
  await assignTo(w, bot, workspaceOnly, 'Junior');
  assert.equal('assigneeAdapterOverrides' in issuePatches(w).at(-1).body, false);
  const plain = withOverride(null)(w);
  await assignTo(w, bot, plain, 'Junior');
  assert.equal('assigneeAdapterOverrides' in issuePatches(w).at(-1).body, false);
});

test('a task that was not assigned to an agent loses a stale model when an agent takes it', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Parked', status: 'todo', assigneeAdapterOverrides: { adapterConfig: { model: 'claude-opus-5-5', thinking: 'low' } } });
  await assignTo(w, bot, issue, 'Dev');
  assert.equal(issuePatches(w).at(-1).body.assigneeAdapterOverrides, null);
});

test('/help mentions the model buttons in one line', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/help'));
  const lines = w.tg.lastMessage().text.split('\n').filter((line) => /Model and Reasoning/.test(line));
  assert.equal(lines.length, 1);
});
