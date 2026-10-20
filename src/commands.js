import { findCardByMessage, findCardByReasonPrompt, handleReasonReply, handleTextAnswer, hasOpenTextQuestion, reportFailure } from './actions.js';
import { commandAgents } from './agents.js';
import { NEW_USAGE, askProjectForNew, createTask, offerTask, parseNewArgs, resolveTargets } from './create.js';
import { attachToTask, fileOf } from './files.js';
import { headline, issueUrl } from './format.js';
import { handleNoteReply } from './inbox.js';
import { commandFind, commandFollowing, commandStatus, commandTasks } from './lists.js';
import { PaperclipError } from './paperclip.js';
import { commandProjects } from './projects.js';
import { commandSettings } from './settings.js';
import { guessPrefix, parseTaskRef, sendTaskView } from './tasks.js';
import { isServiceMessage, replyTarget, threadOf, where } from './thread.js';
import { handleVoice, lengthWords } from './voice.js';

const HELP_COMMANDS = [
  '<b>Paperclip bot</b>',
  '/new [@agent] [#project] &lt;text&gt; — create a task (the first line is the title)',
  '/task &lt;ID&gt; — open a task',
  '/tasks — open tasks',
  '/find &lt;text&gt; — search tasks',
  '/status — what is running and what waits for you',
  '/following — tasks you follow',
  '/agents — agents and what they work on',
  '/projects — projects and their open tasks',
  '/settings — notifications and mute',
  '/help — this list',
  '',
  'Send plain text to create a task from it.',
];

function helpText(bot) {
  const topics = ['In a task topic, plain text comments on that task and /task opens it.'];
  const { voice } = bot.config;
  const voiceNotes = voice
    ? [`Voice notes work too, up to ${lengthWords(voice.maxSeconds)} long: the bot turns them into text on this machine, shows the text and uses it only after you confirm.`]
    : [];
  return [...HELP_COMMANDS, ...(bot.topics.on ? topics : []), 'Reply to any bot message about a task to comment on it.', ...voiceNotes].join('\n');
}

const TASK_USAGE = 'Usage: /task &lt;ID&gt;, for example /task ABC-12 or /task 12';

function parseCommand(text) {
  const match = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), rest: (match[2] ?? '').trim() } : null;
}

async function reply(bot, msg, html, issue) {
  return bot.send(html, { ...where(bot, msg), issue });
}

async function commandNew(bot, update, rest) {
  const msg = update.message;
  const parsed = parseNewArgs(rest);
  if (!parsed.text) return reply(bot, msg, NEW_USAGE);
  const { targets, error } = await resolveTargets(bot, parsed);
  if (error) return reply(bot, msg, error);
  if (targets.project === null && (await askProjectForNew(bot, update, { text: parsed.text, agent: targets.agent }))) return undefined;
  await createTask(bot, { updateId: update.update_id, text: parsed.text, ...where(bot, msg), ...targets });
  return undefined;
}

async function commandTask(bot, msg, rest) {
  const topicTask = rest ? null : bot.state.rootForThread(threadOf(bot, msg));
  if (topicTask) return sendTaskView(bot, topicTask, where(bot, msg));
  const bare = /^#?\d+$/.test(rest);
  const ref = rest ? parseTaskRef(rest, bare ? await guessPrefix(bot) : undefined) : null;
  if (!ref) return reply(bot, msg, TASK_USAGE);
  try {
    return await sendTaskView(bot, ref, where(bot, msg));
  } catch (err) {
    if (err instanceof PaperclipError && err.status === 404) return reply(bot, msg, `No task ${ref}`);
    throw err;
  }
}

const HANDLERS = {
  new: (bot, update, rest) => commandNew(bot, update, rest),
  task: (bot, update, rest) => commandTask(bot, update.message, rest),
  tasks: (bot, update) => commandTasks(bot, update.message),
  find: (bot, update, rest) => commandFind(bot, update.message, rest),
  status: (bot, update) => commandStatus(bot, update.message),
  following: (bot, update) => commandFollowing(bot, update.message),
  agents: (bot, update) => commandAgents(bot, update.message),
  projects: (bot, update) => commandProjects(bot, update.message),
  settings: (bot, update) => commandSettings(bot, update.message),
};

async function runCommand(bot, update, command) {
  const msg = update.message;
  const run = HANDLERS[command.name];
  if (!run) return reply(bot, msg, helpText(bot));
  try {
    return await run(bot, update, command.rest);
  } catch (err) {
    if (!(err instanceof PaperclipError)) throw err;
    return reportFailure(bot, err, msg);
  }
}

// Posts the owner's text as a comment; the reaction (or a short reply) confirms it. True when the comment was posted.
async function postComment(bot, msg, issue) {
  try {
    await bot.pc.postComment(issue.id, msg.text.trim());
  } catch (err) {
    await reportFailure(bot, err, msg);
    return false;
  }
  if (bot.topics.on && (await bot.react(msg.message_id))) return true;
  const url = issue.identifier ? issueUrl(bot.config.uiBaseUrl, issue.identifier) : null;
  await reply(bot, msg, issue.identifier ? headline('Comment posted', issue, { url }) : '<b>Comment posted</b>', issue);
  return true;
}

// Says something in reply to `msg` about text that was not used.
async function refuse(bot, msg, html) {
  await reply(bot, msg, html);
  return false;
}

// The task a reply belongs to: the one its message was about, the card's, or the topic's.
function taskOfReply(bot, msg, replyTo) {
  const card = findCardByMessage(bot.state, replyTo);
  return bot.state.issueForMessage(replyTo) ?? (card ? { id: card.issueId, identifier: card.identifier } : topicTask(bot, msg));
}

// Precedence: a note for a stalled review, a decline reason, an open text question, then a plain comment on the task.
// True when the text was used.
async function handleReply(bot, msg, replyTo) {
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';

  const noteRecord = bot.state.inboxByNotePrompt(replyTo);
  if (noteRecord) {
    if (!text) return refuse(bot, msg, 'Only text replies are supported');
    return handleNoteReply(bot, noteRecord, msg);
  }

  const reasonCard = findCardByReasonPrompt(bot.state, replyTo);
  if (reasonCard) {
    if (!text) return refuse(bot, msg, 'Only text replies are supported');
    return handleReasonReply(bot, reasonCard, msg);
  }

  const card = findCardByMessage(bot.state, replyTo);
  if (card && hasOpenTextQuestion(card)) {
    if (!text) return refuse(bot, msg, 'Only text replies are supported');
    return handleTextAnswer(bot, card, msg);
  }

  const issue = taskOfReply(bot, msg, replyTo);
  if (!issue) return refuse(bot, msg, "I don't know which task this is");
  if (!text) return refuse(bot, msg, 'Only text replies are supported');
  return postComment(bot, msg, issue);
}

// The task whose topic the message was written in, if any.
function topicTask(bot, msg) {
  const rootId = bot.state.rootForThread(threadOf(bot, msg));
  return rootId ? { id: rootId, identifier: bot.state.topics.get(rootId).identifier } : null;
}

// Handles text the owner did not type (the transcript of a voice note) as if it was typed where `msg` was written:
// as a reply to the message `msg` answers, else as a comment in a task topic. True when the text was used.
export async function deliverText(bot, msg) {
  const target = replyTarget(msg);
  if (target) return handleReply(bot, msg, target);
  const task = topicTask(bot, msg);
  return task ? postComment(bot, msg, task) : refuse(bot, msg, "I don't know which task this is");
}

// A photo or file: it goes to the task the message replies to or is written under; with a caption alone it offers a new task.
async function handleFile(bot, update, file) {
  const msg = update.message;
  const caption = typeof msg.caption === 'string' ? msg.caption.trim() : '';
  const replyTo = replyTarget(msg);
  const issue = replyTo ? taskOfReply(bot, msg, replyTo) : topicTask(bot, msg);
  if (issue) return attachToTask(bot, msg, issue, file, caption);
  if (replyTo) return reply(bot, msg, "I don't know which task this is");
  if (!caption) return reply(bot, msg, 'Add a caption to make a task, or reply to a task message to attach it');
  return offerTask(bot, update, { text: caption, file });
}

export async function handleMessage(bot, update) {
  const msg = update.message;
  if (isServiceMessage(msg) || msg.from?.is_bot) return undefined;
  const command = typeof msg.text === 'string' ? parseCommand(msg.text) : null;
  if (command) return runCommand(bot, update, command);
  if (msg.voice) return handleVoice(bot, update, { offer: !replyTarget(msg) && !topicTask(bot, msg), replyTo: replyTarget(msg) });
  const file = fileOf(msg);
  if (file) return handleFile(bot, update, file);
  const target = replyTarget(msg);
  if (target) return handleReply(bot, msg, target);
  if (typeof msg.text === 'string' && msg.text.trim()) {
    const task = topicTask(bot, msg);
    return task ? postComment(bot, msg, task) : offerTask(bot, update);
  }
  return reply(bot, msg, 'Send text to create a task, or reply to a task message to comment on it. /help lists the commands.');
}
