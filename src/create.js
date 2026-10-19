import { FileProblem, attachFile } from './files.js';
import { followIssue } from './follow.js';
import { button, escapeHtml, firstLine, headline, issueUrl, taskButton, truncate } from './format.js';
import { PaperclipError } from './paperclip.js';
import { ID_PREFIX, byPrefix } from './pick.js';
import { orderedProjects } from './projects.js';
import { assignableAgents, reportActionFailure, sendTaskView } from './tasks.js';
import { threadOf, where } from './thread.js';
import { linkTopic, topicTarget } from './topics.js';

const NEW_TITLE_LIMIT = 100;
const NAME_LIST_LIMIT = 30;
const OFFER_AGENT_LIMIT = 40;
const PROJECT_PAGE = 8;

export const NEW_USAGE = 'Usage: /new [@agent] [#project] &lt;text&gt;\nThe first line becomes the title, the whole text the description.';

const normalize = (name) => String(name ?? '').toLowerCase().replace(/[\s_-]+/g, '');

// Splits leading @agent and #project words from the task text.
export function parseNewArgs(rest) {
  const out = { agent: null, project: null, text: rest.trim() };
  for (;;) {
    const match = /^([@#])(\S+)(?:\s+|$)/.exec(out.text);
    if (!match) break;
    const field = match[1] === '@' ? 'agent' : 'project';
    if (out[field] !== null) break;
    out[field] = match[2];
    out.text = out.text.slice(match[0].length);
  }
  return out;
}

// Items whose urlKey or name (spaces, dashes and case ignored) equals the wanted word.
function matching(items, wanted) {
  const word = normalize(wanted);
  return items.filter((item) => normalize(item.urlKey) === word || normalize(item.name) === word);
}

const handleOf = (item) => item.urlKey || normalize(item.name);

function unknownReply(kind, sigil, wanted, items) {
  const names = items.slice(0, NAME_LIST_LIMIT).map((item) => `${sigil}${escapeHtml(handleOf(item))}`);
  return `Unknown ${kind} ${sigil}${escapeHtml(truncate(wanted, 60))}. ${names.length > 0 ? `Available: ${names.join(', ')}` : `There is no ${kind} to pick.`}`;
}

// Resolves the @agent and #project words; `error` holds the reply when one is unknown or ambiguous.
export async function resolveTargets(bot, { agent, project }) {
  const targets = { agent: null, project: null };
  if (agent !== null) {
    const agents = assignableAgents(await bot.agentRecords({ fresh: true }));
    const found = matching(agents, agent);
    if (found.length !== 1) return { error: unknownReply('agent', '@', agent, agents) };
    targets.agent = found[0];
  }
  if (project !== null) {
    const projects = await bot.projectList({ fresh: true });
    const found = matching(projects, project);
    if (found.length !== 1) return { error: unknownReply('project', '#', project, projects) };
    targets.project = found[0];
  }
  return { targets };
}

// Gives a new task its topic: the unknown topic it was asked for in, else a topic of its own.
// Returns true when the topic is the place the owner asked in (the task view is already there).
async function openTopic(bot, issue, thread) {
  await bot.topicsReady();
  if (!bot.topics.on) return { here: false, separate: false };
  if (thread !== null && !bot.state.rootForThread(thread) && (await linkTopic(bot, thread, issue))) return { here: true, separate: false };
  const target = await topicTarget(bot, issue);
  return { here: false, separate: target.thread !== null };
}

// Creates the task, follows it when asked to, gives it a topic and replies with its task view.
export async function createTask(bot, { updateId, text, agent = null, project = null, replyTo, thread = null }) {
  const body = {
    title: truncate(firstLine(text), NEW_TITLE_LIMIT),
    description: text,
    assigneeAgentId: agent?.id ?? bot.config.leadAgentId,
    idempotencyKey: `telegram-update-${updateId}`,
  };
  const projectId = project?.id ?? bot.config.newTaskProjectId;
  if (projectId) body.projectId = projectId;
  const issue = await bot.pc.createIssue(bot.config.companyId, body);

  if (!issue.deduplicated && bot.state.settings.autoFollowCreated) {
    try {
      await followIssue(bot, issue);
    } catch (err) {
      bot.log.warn('could not follow the new task', { error: err.message });
    }
  }
  const placed = issue.deduplicated ? { here: false, separate: false } : await openTopic(bot, issue, thread);
  if (placed.here) return issue;
  // A short confirmation is enough when the full view is in the task's own topic; it is also the fallback.
  const confirm = () => {
    const html = headline(issue.deduplicated ? 'Task' : 'Created', issue, { url: issueUrl(bot.config.uiBaseUrl, issue.identifier) });
    return bot.send(html, { replyTo, thread, keyboard: [[taskButton(issue.id)]], issue: { id: issue.id, identifier: issue.identifier } });
  };
  if (placed.separate) {
    await confirm();
    return issue;
  }
  try {
    await sendTaskView(bot, issue.id, { note: issue.deduplicated ? 'Already exists' : null, replyTo, thread });
  } catch (err) {
    // The task exists, so the confirmation still goes out in a short form.
    bot.log.warn('could not read the new task', { error: err.message });
    await confirm();
  }
  return issue;
}

function offerKeyboard(key, leadName) {
  return [[button(`For ${leadName}`, `O:y:${key}`), button('Other agent', `O:o:${key}`), button('Cancel', `O:x:${key}`)]];
}

async function leadName(bot) {
  return truncate((await bot.agentName(bot.config.leadAgentId)) ?? 'Lead', 30);
}

// A plain text message, or a file with a caption: ask before creating a task from it.
export async function offerTask(bot, update, { text, file = null } = {}) {
  const msg = update.message;
  const key = bot.state.addOffer(text ?? msg.text.trim(), msg.message_id, update.update_id, bot.now(), threadOf(bot, msg), { file });
  bot.state.save();
  await bot.send('Create a task from this?', { ...where(bot, msg), keyboard: offerKeyboard(key, await leadName(bot)) });
}

// The project question is skipped when the config names a project or there is none to pick.
async function shouldAskProject(bot) {
  return !bot.config.newTaskProjectId && (await bot.projectList()).length > 0;
}

async function projectQuestion(bot, key, page) {
  const projects = await orderedProjects(bot);
  const pages = Math.max(1, Math.ceil(projects.length / PROJECT_PAGE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const rows = projects.slice(current * PROJECT_PAGE, (current + 1) * PROJECT_PAGE).map((project) => [button(project.name, `O:j:${key}:${project.id.slice(0, ID_PREFIX)}`)]);
  if (pages > 1) {
    rows.push([
      ...(current > 0 ? [button('◀', `O:g:${key}:${current - 1}`)] : []),
      button(`${current + 1}/${pages}`, `O:g:${key}:${current}`),
      ...(current < pages - 1 ? [button('▶', `O:g:${key}:${current + 1}`)] : []),
    ]);
  }
  rows.push([button('No project', `O:n:${key}`), button('Cancel', `O:x:${key}`)]);
  return rows;
}

// `/new` without #project: keep the text and ask which project, as a reply to the command.
// Returns false (and asks nothing) when the project is decided by the config or there is none to pick.
export async function askProjectForNew(bot, update, { text, agent }) {
  if (!(await shouldAskProject(bot))) return false;
  const msg = update.message;
  const key = bot.state.addOffer(text, msg.message_id, update.update_id, bot.now(), threadOf(bot, msg), { agentId: agent?.id ?? null });
  bot.state.save();
  await bot.send('Which project?', { ...where(bot, msg), keyboard: await projectQuestion(bot, key, 0) });
  return true;
}

async function agentFor(bot, agentId) {
  if (!agentId) return null;
  return assignableAgents(await bot.agentRecords()).find((agent) => agent.id === agentId) ?? null;
}

// Attaches the file kept with the offer; the line says how it went.
async function attachOfferFile(bot, issue, file) {
  try {
    await attachFile(bot, issue, file, '');
    return `Attached: ${escapeHtml(truncate(file.name, 80))}`;
  } catch (err) {
    if (!(err instanceof FileProblem) && !(err instanceof PaperclipError)) throw err;
    bot.log.warn('could not attach a file to a new task', { error: err.message });
    return `The file could not be attached: ${escapeHtml(err instanceof FileProblem ? err.message : (err.detail || 'Paperclip refused it'))}`;
  }
}

async function createFromOffer(bot, cq, key, offer, agent, project) {
  const issue = await createTask(bot, { updateId: offer.updateId, text: offer.text, agent, project, replyTo: offer.messageId, thread: offer.thread ?? null });
  bot.state.offers.delete(key);
  bot.state.save();
  const lines = [`Created for ${escapeHtml(agent ? agent.name : await leadName(bot))}${project ? ` in ${escapeHtml(truncate(project.name, 60))}` : ''}`];
  if (offer.file) lines.push(await attachOfferFile(bot, issue, offer.file));
  await bot.edit(cq.message.message_id, lines.join('\n'), []);
  return bot.answer(cq.id, 'Created');
}

// The agent is chosen: ask for the project when there is a choice, else create the task.
async function afterAgent(bot, cq, key, offer, agent) {
  offer.agentId = agent?.id ?? null;
  bot.state.save();
  if (!(await shouldAskProject(bot))) return createFromOffer(bot, cq, key, offer, agent, null);
  await bot.edit(cq.message.message_id, 'Which project?', await projectQuestion(bot, key, 0));
  return bot.answer(cq.id);
}

export async function handleOfferCallback(bot, cq) {
  const [, op, key, arg] = String(cq.data).split(':');
  const offer = bot.state.getOffer(key, bot.now());
  if (!offer) {
    await bot.answer(cq.id, 'This offer has expired');
    return bot.edit(cq.message.message_id, 'This offer has expired.', []);
  }
  const messageId = cq.message.message_id;
  try {
    if (op === 'y') return await afterAgent(bot, cq, key, offer, null);
    if (op === 'x') {
      bot.state.offers.delete(key);
      bot.state.save();
      await bot.edit(messageId, 'Cancelled.', []);
      return await bot.answer(cq.id);
    }
    if (op === 'b') {
      await bot.editKeyboard(messageId, offerKeyboard(key, await leadName(bot)));
      return await bot.answer(cq.id);
    }
    if (op === 'o') {
      const agents = assignableAgents(await bot.agentRecords({ fresh: true })).slice(0, OFFER_AGENT_LIMIT);
      const rows = agents.map((agent) => [button(agent.name, `O:a:${key}:${agent.id.slice(0, ID_PREFIX)}`)]);
      rows.push([button('◀ Back', `O:b:${key}`)]);
      await bot.editKeyboard(messageId, rows);
      return await bot.answer(cq.id);
    }
    if (op === 'a') {
      const agent = byPrefix(assignableAgents(await bot.agentRecords({ fresh: true })), arg ?? '');
      if (!agent) return await bot.answer(cq.id, 'Agent not found', true);
      return await afterAgent(bot, cq, key, offer, agent);
    }
    if (op === 'g') {
      await bot.editKeyboard(messageId, await projectQuestion(bot, key, Number(arg) || 0));
      return await bot.answer(cq.id);
    }
    if (op === 'j' || op === 'n') {
      const project = op === 'j' ? byPrefix(await bot.projectList(), arg ?? '') : null;
      if (op === 'j' && !project) return await bot.answer(cq.id, 'Project not found', true);
      return await createFromOffer(bot, cq, key, offer, await agentFor(bot, offer.agentId), project);
    }
  } catch (err) {
    return reportActionFailure(bot, cq, err);
  }
  return bot.answer(cq.id, 'Unknown action');
}
