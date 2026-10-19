import { followIssue } from './follow.js';
import { button, escapeHtml, firstLine, issueUrl, link, taskButton, truncate } from './format.js';
import { ID_PREFIX, assignableAgents, byPrefix, reportActionFailure, sendTaskView } from './tasks.js';

const NEW_TITLE_LIMIT = 100;
const NAME_LIST_LIMIT = 30;
const OFFER_AGENT_LIMIT = 40;

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

// Creates the task, follows it when asked to, and replies with its task view.
export async function createTask(bot, { updateId, text, agent = null, project = null, replyTo }) {
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
  const headline = issue.deduplicated ? '✅ Already exists' : '✅ Created';
  try {
    await sendTaskView(bot, issue.id, { headline, replyTo });
  } catch (err) {
    // The task exists, so the confirmation still goes out in a short form.
    bot.log.warn('could not read the new task', { error: err.message });
    const url = issueUrl(bot.config.uiBaseUrl, issue.identifier);
    const html = `${headline} <b>${escapeHtml(issue.identifier)}</b>\n${link(url, 'Open in Paperclip')}`;
    await bot.send(html, { replyTo, keyboard: [[taskButton(issue.id)]], issue: { id: issue.id, identifier: issue.identifier } });
  }
  return issue;
}

function offerKeyboard(key, leadName) {
  return [[button(`✅ For ${leadName}`, `O:y:${key}`), button('👤 Other agent…', `O:o:${key}`), button('✖', `O:x:${key}`)]];
}

async function leadName(bot) {
  return truncate((await bot.agentName(bot.config.leadAgentId)) ?? 'Lead', 30);
}

// A plain text message: ask before creating a task from it.
export async function offerTask(bot, update) {
  const msg = update.message;
  const key = bot.state.addOffer(msg.text.trim(), msg.message_id, update.update_id, bot.now());
  bot.state.save();
  await bot.send('Create a task from this?', { replyTo: msg.message_id, keyboard: offerKeyboard(key, await leadName(bot)) });
}

async function createFromOffer(bot, cq, key, offer, agent) {
  await createTask(bot, { updateId: offer.updateId, text: offer.text, agent, replyTo: offer.messageId });
  bot.state.offers.delete(key);
  bot.state.save();
  await bot.edit(cq.message.message_id, `✅ Created for ${escapeHtml(agent ? agent.name : await leadName(bot))}`, []);
  return bot.answer(cq.id, 'Created');
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
    if (op === 'y') return await createFromOffer(bot, cq, key, offer, null);
    if (op === 'x') {
      bot.state.offers.delete(key);
      bot.state.save();
      await bot.edit(messageId, 'Dismissed.', []);
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
      return await createFromOffer(bot, cq, key, offer, agent);
    }
  } catch (err) {
    return reportActionFailure(bot, cq, err);
  }
  return bot.answer(cq.id, 'Unknown action');
}
