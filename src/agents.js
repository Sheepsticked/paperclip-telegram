import { ago, button, escapeHtml, truncate } from './format.js';
import { taskRow } from './lists.js';
import { reportActionFailure } from './tasks.js';
import { threadOf, where } from './thread.js';

const LIST_BUTTON_LIMIT = 40;
const TASK_LIMIT = 20;
const CONFIRM_LABEL = 'Tap again to confirm';
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
  return { agent, run: Array.isArray(runs) ? (runs[0] ?? null) : null, tasks: working };
}

function renderAgent(bot, view, armed) {
  const { agent, run, tasks } = view;
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
  else if (!NO_CONTROLS.has(agent.status)) controls.push(button(armed.has('p') ? CONFIRM_LABEL : 'Pause (stops its current run)', `G:p:${id}`));
  if (agent.status !== 'paused' && !NO_CONTROLS.has(agent.status)) controls.push(button('Run now', `G:n:${id}`));
  controls.push(button('Refresh', `G:r:${id}`));
  return { text: lines.join('\n'), keyboard: [controls, ...tasks.map((issue) => taskRow(issue))] };
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

export async function handleAgentCallback(bot, cq) {
  const [, op, agentId] = String(cq.data).split(':');
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
    if (op === 'r') {
      await showAgent(bot, cq.message, agentId);
      return await bot.answer(cq.id, 'Refreshed');
    }
  } catch (err) {
    return reportActionFailure(bot, cq, err, 'Agent not found');
  }
  return bot.answer(cq.id, 'Unknown action');
}
