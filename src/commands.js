import { findCardByMessage, findCardByReasonPrompt, handleReasonReply, handleTextAnswer, hasOpenTextQuestion, reportFailure } from './actions.js';
import { NEW_USAGE, createTask, offerTask, parseNewArgs, resolveTargets } from './create.js';
import { issueUrl, link } from './format.js';
import { commandAgents, commandFind, commandFollowing, commandStatus, commandTasks } from './lists.js';
import { PaperclipError } from './paperclip.js';
import { commandSettings } from './settings.js';
import { guessPrefix, parseTaskRef, sendTaskView } from './tasks.js';

const HELP = [
  '<b>Paperclip bot</b>',
  '/new [@agent] [#project] &lt;text&gt; — create a task (the first line is the title)',
  '/task &lt;ID&gt; — open a task',
  '/tasks — open tasks',
  '/find &lt;text&gt; — search tasks',
  '/status — what is running and what waits for you',
  '/following — tasks you follow',
  '/agents — agents and what they work on',
  '/settings — notifications and mute',
  '/help — this list',
  '',
  'Send plain text to create a task from it.',
  'Reply to any bot message about a task to comment on it.',
].join('\n');

const TASK_USAGE = 'Usage: /task &lt;ID&gt;, for example /task ABC-12 or /task 12';

function parseCommand(text) {
  const match = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), rest: (match[2] ?? '').trim() } : null;
}

async function reply(bot, msg, html, issue) {
  return bot.send(html, { replyTo: msg.message_id, issue });
}

async function commandNew(bot, update, rest) {
  const msg = update.message;
  const parsed = parseNewArgs(rest);
  if (!parsed.text) return reply(bot, msg, NEW_USAGE);
  const { targets, error } = await resolveTargets(bot, parsed);
  if (error) return reply(bot, msg, error);
  await createTask(bot, { updateId: update.update_id, text: parsed.text, replyTo: msg.message_id, ...targets });
  return undefined;
}

async function commandTask(bot, msg, rest) {
  const bare = /^#?\d+$/.test(rest);
  const ref = rest ? parseTaskRef(rest, bare ? await guessPrefix(bot) : undefined) : null;
  if (!ref) return reply(bot, msg, TASK_USAGE);
  try {
    return await sendTaskView(bot, ref, { replyTo: msg.message_id });
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
  settings: (bot, update) => commandSettings(bot, update.message),
};

async function runCommand(bot, update, command) {
  const msg = update.message;
  const run = HANDLERS[command.name];
  if (!run) return reply(bot, msg, HELP);
  try {
    return await run(bot, update, command.rest);
  } catch (err) {
    if (!(err instanceof PaperclipError)) throw err;
    return reportFailure(bot, err, msg.message_id);
  }
}

// Precedence: a decline reason, then an open text question, then a plain comment on the task.
async function handleReply(bot, msg) {
  const replyTo = msg.reply_to_message.message_id;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';

  const reasonCard = findCardByReasonPrompt(bot.state, replyTo);
  if (reasonCard) {
    if (!text) return reply(bot, msg, 'Only text replies are supported');
    return handleReasonReply(bot, reasonCard, msg);
  }

  const card = findCardByMessage(bot.state, replyTo);
  if (card && hasOpenTextQuestion(card)) {
    if (!text) return reply(bot, msg, 'Only text replies are supported');
    return handleTextAnswer(bot, card, msg);
  }

  const issue = bot.state.issueForMessage(replyTo) ?? (card ? { id: card.issueId, identifier: card.identifier } : null);
  if (!issue) return reply(bot, msg, "I don't know which task this is");
  if (!text) return reply(bot, msg, 'Only text replies are supported');
  try {
    await bot.pc.postComment(issue.id, text);
  } catch (err) {
    await reportFailure(bot, err, msg.message_id);
    return undefined;
  }
  const label = issue.identifier ? link(issueUrl(bot.config.uiBaseUrl, issue.identifier), issue.identifier) : 'the task';
  return reply(bot, msg, `💬 Posted on ${label}`, issue);
}

export async function handleMessage(bot, update) {
  const msg = update.message;
  const command = typeof msg.text === 'string' ? parseCommand(msg.text) : null;
  if (command) return runCommand(bot, update, command);
  if (msg.reply_to_message) return handleReply(bot, msg);
  if (typeof msg.text === 'string' && msg.text.trim()) return offerTask(bot, update);
  return reply(bot, msg, 'Send text to create a task, or reply to a task message to comment on it. /help lists the commands.');
}
