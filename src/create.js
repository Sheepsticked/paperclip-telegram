import { FileProblem, attachFile } from './files.js';
import { followIssue } from './follow.js';
import { TRANSCRIPT_LEVELS, button, escapeHtml, firstLine, fitMessage, headline, issueUrl, quote, taskButton, truncate } from './format.js';
import { languageName, noteLanguage, readAgainButtons, voiceLanguages } from './languages.js';
import { STALE_LIST, modelHash, reasoningLabel } from './models.js';
import { carryPicks, chooseModel, chooseReasoning, controlsRow, modelPickerRows, offerOverride, offerRun, pickedWords, reasoningPickerRows } from './offer-model.js';
import { makeOutcome, outcomeBlock } from './outcome.js';
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
const OFFER_PROMPT = 'Create a task from this?';
const PROJECT_QUESTION = 'Which project?';

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
// `override` is the task's own adapter override (model and reasoning level), sent when there is one.
export async function createTask(bot, { updateId, text, agent = null, project = null, override = null, replyTo, thread = null }) {
  const body = {
    title: truncate(firstLine(text), NEW_TITLE_LIMIT),
    description: text,
    assigneeAgentId: agent?.id ?? bot.config.leadAgentId,
    idempotencyKey: `telegram-update-${updateId}`,
  };
  const projectId = project?.id ?? bot.config.newTaskProjectId;
  if (projectId) body.projectId = projectId;
  if (override) body.assigneeAdapterOverrides = override;
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

// The offer's buttons: the agent it goes to and Cancel, Other agent, and the Model and Reasoning of the agent's
// adapter. An offer made from a voice note adds a row with a button per other language.
async function offerKeyboard(bot, key, offer) {
  const run = await offerRun(bot, offer);
  const rows = [[button(`For ${truncate(run.agent?.name ?? 'Lead', 30)}`, `O:y:${key}`), button('Cancel', `O:x:${key}`)], [button('Other agent', `O:o:${key}`)]];
  const controls = controlsRow(key, run);
  if (controls.length > 0) rows.push(controls);
  const again = offer.voice ? readAgainButtons(bot, 'o', key, offer.voice.language) : [];
  return again.length > 0 ? [...rows, again] : rows;
}

async function leadName(bot) {
  return truncate((await bot.agentName(bot.config.leadAgentId)) ?? 'Lead', 30);
}

// A plain text message, or a file with a caption: ask before creating a task from it.
export async function offerTask(bot, update, { text, file = null } = {}) {
  const msg = update.message;
  const key = bot.state.addOffer(text ?? msg.text.trim(), msg.message_id, update.update_id, bot.now(), threadOf(bot, msg), { file, prompt: OFFER_PROMPT });
  bot.state.save();
  await bot.send(OFFER_PROMPT, { ...where(bot, msg), keyboard: await offerKeyboard(bot, key, bot.state.offers.get(key)) });
}

// Turns the "Transcribing…" reply to a voice note into the offer to create a task from its transcript.
export async function offerFromVoice(bot, job, text) {
  // With a list of languages the offer keeps what it needs to read the note again.
  const voice = voiceLanguages(bot) ? { fileId: job.fileId, duration: job.duration, language: noteLanguage(bot, job), messageId: job.messageId } : null;
  const key = bot.state.addOffer(text, job.noteId, job.updateId, bot.now(), job.thread, { prompt: OFFER_PROMPT, heard: text, voice });
  bot.state.save();
  const offer = bot.state.offers.get(key);
  try {
    await bot.edit(job.messageId, withOfferText(bot, offer, null, (html) => html), await offerKeyboard(bot, key, offer));
  } catch (err) {
    bot.state.offers.delete(key);
    bot.state.save();
    throw err;
  }
}

// True for the offer `/new` makes to ask the project: its message is the question itself.
const isNewQuestion = (offer) => offer?.prompt === PROJECT_QUESTION;

// The project question is skipped when the config names a project or there is none to pick.
async function shouldAskProject(bot) {
  return !bot.config.newTaskProjectId && (await bot.projectList()).length > 0;
}

// The project buttons, paged. The question of `/new` also holds the Model and Reasoning buttons of its agent.
async function projectQuestion(bot, key, page, offer) {
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
  const controls = isNewQuestion(offer) ? controlsRow(key, await offerRun(bot, offer)) : [];
  if (controls.length > 0) rows.push(controls);
  rows.push([button('No project', `O:n:${key}`), button('Cancel', `O:x:${key}`)]);
  return rows;
}

// `/new` without #project: keep the text and ask which project, as a reply to the command.
// Returns false (and asks nothing) when the project is decided by the config or there is none to pick.
export async function askProjectForNew(bot, update, { text, agent }) {
  if (!(await shouldAskProject(bot))) return false;
  const msg = update.message;
  const key = bot.state.addOffer(text, msg.message_id, update.update_id, bot.now(), threadOf(bot, msg), { agentId: agent?.id ?? null, prompt: PROJECT_QUESTION });
  bot.state.save();
  await bot.send(PROJECT_QUESTION, { ...where(bot, msg), keyboard: await projectQuestion(bot, key, 0, bot.state.offers.get(key)) });
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

// Offer messages settled in this run. A tap queued before the settle still shows the buttons, so the buttons do not
// tell a settled offer from an expired one.
const settledMessages = new WeakMap();
const MAX_SETTLED = 200;

export function markSettled(bot, messageId) {
  if (!settledMessages.has(bot)) settledMessages.set(bot, new Set());
  const ids = settledMessages.get(bot);
  ids.add(messageId);
  if (ids.size > MAX_SETTLED) ids.delete(ids.values().next().value);
}

export const wasSettled = (bot, messageId) => settledMessages.get(bot)?.has(messageId) === true;

// The text an offer message was sent with: kept on the offer, else the first block of the message as it is now.
function promptOf(offer, message) {
  if (offer?.prompt) return offer.prompt;
  const first = typeof message?.text === 'string' ? message.text.split('\n\n')[0].trim() : '';
  return first || OFFER_PROMPT;
}

// A settled message: its text as HTML, the outcome last, and a line below it when there is one.
export function settledHtml(html, outcome, below = null) {
  return `${[html, '', outcomeBlock({ outcome })].join('\n')}${below ? `\n${below}` : ''}`;
}

// A settled offer message from the plain text of its prompt.
export function settledText(prompt, outcome, below = null) {
  return settledHtml(escapeHtml(prompt), outcome, below);
}

// Budgets for plain message text rebuilt from a tap, tried until the text and its outcome fit the Telegram limit.
const PLAIN_TEXT_LEVELS = [3500, 2000, 1000, 500];

// A settled message rebuilt from the plain text Telegram sends with a tap, cut so the outcome still fits.
export function settledPlain(text, outcome) {
  return fitMessage((max) => settledText(truncate(text, max), outcome), PLAIN_TEXT_LEVELS);
}

// Builds a message around the text of an offer. An offer made from a voice note shows the transcript, which is cut
// as far as the Telegram limit asks, and the language it was read in when the config lists languages.
function withOfferText(bot, offer, message, build) {
  if (!offer?.heard) return build(escapeHtml(promptOf(offer, message)));
  const language = voiceLanguages(bot) && offer.voice ? ` · ${escapeHtml(languageName(offer.voice.language))}` : '';
  return fitMessage((level) => build(`Heard${language}:\n${quote(offer.heard, level)}\n${escapeHtml(offer.prompt ?? OFFER_PROMPT)}`), TRANSCRIPT_LEVELS);
}

// The buttons an offer message shows now: the project question of `/new`, else the offer's own.
const offerRows = (bot, key, offer) => (isNewQuestion(offer) ? projectQuestion(bot, key, 0, offer) : offerKeyboard(bot, key, offer));

// Creates the task for the picked agent, with the model and level picked on the offer.
async function createFromOffer(bot, cq, key, offer, agent, project) {
  // The agent's configuration is read again, so the override fits what it is now.
  const run = await offerRun(bot, offer, offer.model || offer.reasoning ? { fresh: true } : undefined);
  const override = offerOverride(run);
  const issue = await createTask(bot, { updateId: offer.updateId, text: offer.text, agent, project, override, replyTo: offer.messageId, thread: offer.thread ?? null });
  bot.state.offers.delete(key);
  bot.state.save();
  markSettled(bot, cq.message.message_id);
  const forWho = [`for ${agent ? agent.name : await leadName(bot)}${project ? ` in ${truncate(project.name, 60)}` : ''}`, ...pickedWords(run)].join(' · ');
  const ref = issue.identifier ? { label: issue.identifier, url: issueUrl(bot.config.uiBaseUrl, issue.identifier) } : null;
  const below = offer.file ? await attachOfferFile(bot, issue, offer.file) : null;
  const outcome = makeOutcome('Created', forWho, bot.now(), ref);
  await bot.edit(cq.message.message_id, withOfferText(bot, offer, cq.message, (html) => settledHtml(html, outcome, below)), []);
  return bot.answer(cq.id, 'Created');
}

// The agent is chosen: ask for the project when there is a choice, else create the task.
async function afterAgent(bot, cq, key, offer, agent) {
  if (!(await shouldAskProject(bot))) return createFromOffer(bot, cq, key, offer, agent, null);
  const asking = withOfferText(bot, offer, cq.message, (html) => `${html}\n\n${PROJECT_QUESTION}`);
  await bot.edit(cq.message.message_id, asking, await projectQuestion(bot, key, 0, offer));
  return bot.answer(cq.id);
}

// The tap on an offer that is gone: it was settled, or it expired and the message is settled now.
export async function expiredOffer(bot, cq) {
  // A note that was read again owns its message; a late tap on the buttons of an earlier reading changes nothing.
  if (bot.state.ownsVoiceMessage(cq.message?.message_id, bot.now())) return bot.answer(cq.id, 'Already handled');
  await bot.answer(cq.id, 'This offer has expired');
  // A settled message keeps its outcome.
  if (wasSettled(bot, cq.message?.message_id) || !cq.message?.reply_markup?.inline_keyboard?.length) return undefined;
  return bot.edit(cq.message.message_id, settledPlain(promptOf(null, cq.message), makeOutcome('Expired', null, bot.now())), []);
}

// The agent the offer is for: null for Lead, else its record; undefined when the picked agent cannot take it any more.
async function assigneeOf(bot, offer) {
  if (!offer.agentId) return null;
  return (await agentFor(bot, offer.agentId)) ?? undefined;
}

export async function handleOfferCallback(bot, cq) {
  const [, op, key, arg, hash] = String(cq.data).split(':');
  const offer = bot.state.getOffer(key, bot.now());
  if (!offer) return expiredOffer(bot, cq);
  const messageId = cq.message.message_id;
  // Puts the offer's buttons back, with a note for the tap.
  const redraw = async (note, alert = false) => {
    await bot.editKeyboard(messageId, await offerRows(bot, key, offer));
    return bot.answer(cq.id, note, alert);
  };
  // A picked agent that is gone: Lead takes its place and the buttons say so.
  const agentGone = () => {
    offer.agentId = null;
    bot.state.save();
    return redraw('Agent not found', true);
  };
  try {
    if (op === 'y' || op === 'j' || op === 'n') {
      const agent = await assigneeOf(bot, offer);
      if (agent === undefined) return await agentGone();
      if (op === 'y') return await afterAgent(bot, cq, key, offer, agent);
      const project = op === 'j' ? byPrefix(await bot.projectList(), arg ?? '') : null;
      if (op === 'j' && !project) return await bot.answer(cq.id, 'Project not found', true);
      return await createFromOffer(bot, cq, key, offer, agent, project);
    }
    if (op === 'x') {
      bot.state.offers.delete(key);
      bot.state.save();
      markSettled(bot, messageId);
      const outcome = makeOutcome('Cancelled', null, bot.now());
      await bot.edit(messageId, withOfferText(bot, offer, cq.message, (html) => settledHtml(html, outcome)), []);
      return await bot.answer(cq.id);
    }
    if (op === 'b') return await redraw();
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
      const note = carryPicks(offer, agent);
      offer.agentId = agent.id;
      bot.state.save();
      return await redraw(note ?? undefined);
    }
    if (op === 'g') {
      await bot.editKeyboard(messageId, await projectQuestion(bot, key, Number(arg) || 0, offer));
      return await bot.answer(cq.id);
    }
    if (['m', 'M', 'r', 'R'].includes(op)) return await pickModelOrReasoning(bot, cq, key, offer, redraw, { op, arg, hash });
  } catch (err) {
    return reportActionFailure(bot, cq, err);
  }
  return bot.answer(cq.id, 'Unknown action');
}

// The Model and Reasoning pickers of an offer: `m` and `r` open them in the offer message, `M` and `R` save a pick.
// A model pick is the index in the model list and the hash of its id, so a list that changed since is noticed.
async function pickModelOrReasoning(bot, cq, key, offer, redraw, { op, arg, hash }) {
  const run = await offerRun(bot, offer);
  if (!run.agent?.adapterType) return redraw(STALE_LIST);
  const show = async (rows) => {
    await bot.editKeyboard(cq.message.message_id, rows);
    return bot.answer(cq.id);
  };
  if (op === 'm') return run.models.length === 0 ? redraw('No models to choose from') : show(modelPickerRows(key, run, arg === undefined ? undefined : Number(arg) || 0));
  if (op === 'r') return run.values.length === 0 ? redraw('No reasoning levels for this model') : show(reasoningPickerRows(key, run));
  if (op === 'M') {
    let model = null;
    if (arg !== '-') {
      const models = await bot.models.list(run.agent.adapterType, { fresh: true });
      model = /^\d+$/.test(arg ?? '') ? models[Number(arg)] : undefined;
      if (!model || modelHash(model.id) !== hash) return redraw(STALE_LIST);
    }
    chooseModel(offer, run, model?.id ?? '');
    bot.state.save();
    return redraw(`Model: ${truncate(model?.label ?? 'Agent default', 100)}`);
  }
  const value = arg === '-' ? '' : (arg ?? '');
  if (run.values.length === 0 || (value && !run.values.includes(value))) return redraw(STALE_LIST);
  chooseReasoning(offer, run, value);
  bot.state.save();
  return redraw(`Reasoning: ${value ? reasoningLabel(value) : 'Default'}`);
}
