import { ago, button, escapeHtml, truncate } from './format.js';
import { taskRow } from './lists.js';
import {
  agentModelChange,
  agentReasoningChange,
  modelHash,
  modelLabel,
  modelRows,
  readModel,
  readReasoning,
  reasoningLabel,
  reasoningRows,
  reasoningValues,
} from './models.js';
import { reportActionFailure } from './tasks.js';
import { threadOf, where } from './thread.js';

const LIST_BUTTON_LIMIT = 40;
const TASK_LIMIT = 20;
const CONFIRM_LABEL = 'Tap again to confirm';
const STALE_LIST = 'List changed, try again';
const NO_CONTROLS = new Set(['terminated', 'pending_approval']);

const STATUS_NAMES = {
  active: 'Active',
  idle: 'Idle',
  running: 'Running',
  paused: 'Paused',
  error: 'Error',
  pending_approval: 'Pending approval',
  terminated: 'Terminated',
};
const RUN_NAMES = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
};
const nameOf = (names, value) => names[value] ?? String(value ?? 'Unknown');

export async function commandAgents(bot, msg) {
  const [agents, working] = await Promise.all([
    bot.agentRecords({ fresh: true }),
    bot.pc.listIssues(bot.config.companyId, { status: 'in_progress', limit: 200 }),
  ]);
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [`<b>Agents</b> (${agents.length})`];
  if (agents.length === 0) lines.push('No agents.');
  if (agents.length > LIST_BUTTON_LIMIT) lines.push(`+${agents.length - LIST_BUTTON_LIMIT} more`);
  const rows = sorted.slice(0, LIST_BUTTON_LIMIT).map((agent) => {
    const count = working.filter((issue) => issue.assigneeAgentId === agent.id).length;
    return [button(`${agent.name} · ${nameOf(STATUS_NAMES, agent.status)}${count > 0 ? ` · ${count} in progress` : ''}`, `G:v:${agent.id}`)];
  });
  await bot.send(lines.join('\n'), { keyboard: rows, ...where(bot, msg) });
}

async function loadAgent(bot, agentId) {
  const [agent, runs, working] = await Promise.all([
    bot.pc.getAgent(agentId),
    bot.pc.listRuns(bot.config.companyId, { agentId, limit: 1 }),
    bot.pc.listIssues(bot.config.companyId, { status: 'in_progress', assigneeAgentId: agentId, limit: TASK_LIMIT }),
  ]);
  const models = NO_CONTROLS.has(agent.status) ? [] : await bot.models.list(agent.adapterType);
  return { agent, run: Array.isArray(runs) ? (runs[0] ?? null) : null, tasks: working, models };
}

// The Model and Reasoning buttons: each only when there is something to choose from.
function settingsRow(agent, models) {
  const config = agent.adapterConfig ?? {};
  const model = readModel(config);
  const row = [];
  if (models.length > 0) row.push(button(`Model · ${model ? modelLabel(models, model) : 'Default'}`, `G:o:${agent.id}`));
  if (reasoningValues(agent.adapterType, model).length > 0) {
    const level = readReasoning(agent.adapterType, config);
    row.push(button(`Reasoning · ${level ? reasoningLabel(level) : 'Default'}`, `G:e:${agent.id}`));
  }
  return row;
}

function renderAgent(bot, view, armed) {
  const { agent, run, tasks, models } = view;
  const lines = [`<b>Agent</b> · ${escapeHtml(truncate(agent.name, 80))}`];
  const about = agent.title || agent.role;
  if (about) lines.push(escapeHtml(truncate(about, 100)));
  const reason = agent.status === 'paused' && agent.pauseReason ? ` (${truncate(agent.pauseReason, 60)})` : '';
  lines.push(`Status: ${escapeHtml(nameOf(STATUS_NAMES, agent.status) + reason)}`);
  if (run) {
    const at = run.finishedAt ?? run.startedAt ?? run.createdAt;
    lines.push(`Last run: ${escapeHtml(nameOf(RUN_NAMES, run.status))}${at ? ` ${ago(at, bot.now())}` : ''}`);
  } else {
    lines.push('Last run: none yet');
  }
  lines.push(`In progress: ${tasks.length}`);

  const id = agent.id;
  const controls = [];
  if (agent.status === 'paused') controls.push(button('Resume', `G:u:${id}`));
  else if (!NO_CONTROLS.has(agent.status)) controls.push(button(armed.has('p') ? CONFIRM_LABEL : 'Pause (stops its current run)', `G:p:${id}`, 'danger'));
  if (agent.status !== 'paused' && !NO_CONTROLS.has(agent.status)) controls.push(button('Run now', `G:n:${id}`));
  controls.push(button('Refresh', `G:r:${id}`));
  const settings = NO_CONTROLS.has(agent.status) ? [] : settingsRow(agent, models);
  return { text: lines.join('\n'), keyboard: [controls, ...(settings.length > 0 ? [settings] : []), ...tasks.map((issue) => taskRow(issue))] };
}

export async function sendAgentView(bot, agentId, { replyTo, thread } = {}) {
  const { text, keyboard } = renderAgent(bot, await loadAgent(bot, agentId), new Set());
  return bot.send(text, { keyboard, replyTo, thread });
}

async function showAgent(bot, message, agentId) {
  const { text, keyboard } = renderAgent(bot, await loadAgent(bot, agentId), bot.armedOps(message.message_id));
  await bot.edit(message.message_id, text, keyboard);
}

async function pause(bot, cq, agentId) {
  const messageId = cq.message.message_id;
  if (!bot.isArmed(messageId, 'p')) {
    bot.arm(messageId, 'p', () => showAgent(bot, cq.message, agentId));
    await showAgent(bot, cq.message, agentId);
    return bot.answer(cq.id, CONFIRM_LABEL);
  }
  bot.disarm(messageId);
  await bot.pc.pauseAgent(agentId);
  await showAgent(bot, cq.message, agentId);
  return bot.answer(cq.id, 'Paused');
}

async function runNow(bot, cq, agentId) {
  const run = await bot.pc.invokeAgent(agentId);
  await showAgent(bot, cq.message, agentId);
  return bot.answer(cq.id, run?.status === 'skipped' ? 'Nothing was started' : 'Run started');
}

// Puts the view back, with a note for the tap.
async function redraw(bot, cq, agentId, note) {
  bot.disarm(cq.message.message_id);
  await showAgent(bot, cq.message, agentId);
  return bot.answer(cq.id, note);
}

// A configuration change is read by the next agent list, not the one cached before it.
async function saveConfig(bot, agentId, change) {
  await bot.pc.updateAgentConfig(agentId, change);
  bot.agentsLoadedAt = 0;
}

async function openModels(bot, cq, agentId, pageArg) {
  const agent = await bot.pc.getAgent(agentId);
  const models = await bot.models.list(agent.adapterType);
  if (models.length === 0) return redraw(bot, cq, agentId, 'No models to choose from');
  const rows = modelRows({
    models,
    current: readModel(agent.adapterConfig),
    page: pageArg === undefined ? undefined : Number(pageArg) || 0,
    pick: (index, id) => `G:O:${agentId}:${index}:${modelHash(id)}`,
    turn: (page) => `G:o:${agentId}:${page}`,
  });
  rows.push([button('◀ Back', `G:b:${agentId}`)]);
  bot.disarm(cq.message.message_id);
  await bot.editKeyboard(cq.message.message_id, rows);
  return bot.answer(cq.id);
}

// The list is read again, and the tapped button must still be the same model at the same place.
async function setModel(bot, cq, agentId, index, hash) {
  const agent = await bot.pc.getAgent(agentId);
  const models = await bot.models.list(agent.adapterType, { fresh: true });
  const model = /^\d+$/.test(index ?? '') ? models[Number(index)] : undefined;
  if (!model || modelHash(model.id) !== hash) return redraw(bot, cq, agentId, STALE_LIST);
  const config = agent.adapterConfig ?? {};
  if (readModel(config) !== model.id) await saveConfig(bot, agentId, agentModelChange(agent.adapterType, config, model.id));
  return redraw(bot, cq, agentId, `Model: ${model.label}`);
}

async function openReasoning(bot, cq, agentId) {
  const agent = await bot.pc.getAgent(agentId);
  const config = agent.adapterConfig ?? {};
  const values = reasoningValues(agent.adapterType, readModel(config));
  if (values.length === 0) return redraw(bot, cq, agentId, 'No reasoning levels for this model');
  const rows = reasoningRows({ values, current: readReasoning(agent.adapterType, config), pick: (value) => `G:E:${agentId}:${value || '-'}` });
  rows.push([button('◀ Back', `G:b:${agentId}`)]);
  bot.disarm(cq.message.message_id);
  await bot.editKeyboard(cq.message.message_id, rows);
  return bot.answer(cq.id);
}

async function setReasoning(bot, cq, agentId, valueArg) {
  const agent = await bot.pc.getAgent(agentId);
  const config = agent.adapterConfig ?? {};
  const value = valueArg === '-' ? '' : (valueArg ?? '');
  const values = reasoningValues(agent.adapterType, readModel(config));
  if (values.length === 0 || (value && !values.includes(value))) return redraw(bot, cq, agentId, STALE_LIST);
  if (readReasoning(agent.adapterType, config) !== value) await saveConfig(bot, agentId, agentReasoningChange(agent.adapterType, config, value));
  return redraw(bot, cq, agentId, `Reasoning: ${value ? reasoningLabel(value) : 'Default'}`);
}

export async function handleAgentCallback(bot, cq) {
  const [, op, agentId, arg, hash] = String(cq.data).split(':');
  if (!agentId || !cq.message?.message_id) return bot.answer(cq.id, 'Unknown action');
  try {
    if (op === 'v') {
      await sendAgentView(bot, agentId, { thread: threadOf(bot, cq.message) });
      return await bot.answer(cq.id);
    }
    if (op === 'p') return await pause(bot, cq, agentId);
    if (op === 'u' || op === 'n' || op === 'r') bot.disarm(cq.message.message_id);
    if (op === 'u') {
      await bot.pc.resumeAgent(agentId);
      await showAgent(bot, cq.message, agentId);
      return await bot.answer(cq.id, 'Resumed');
    }
    if (op === 'n') return await runNow(bot, cq, agentId);
    if (op === 'o') return await openModels(bot, cq, agentId, arg);
    if (op === 'O') return await setModel(bot, cq, agentId, arg, hash);
    if (op === 'e') return await openReasoning(bot, cq, agentId);
    if (op === 'E') return await setReasoning(bot, cq, agentId, arg);
    if (op === 'b') {
      bot.disarm(cq.message.message_id);
      await showAgent(bot, cq.message, agentId);
      return await bot.answer(cq.id);
    }
    if (op === 'r') {
      await showAgent(bot, cq.message, agentId);
      return await bot.answer(cq.id, 'Refreshed');
    }
  } catch (err) {
    return reportActionFailure(bot, cq, err, 'Agent not found');
  }
  return bot.answer(cq.id, 'Unknown action');
}
