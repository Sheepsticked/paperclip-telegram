import { findCardByMessage, findCardByReasonPrompt, handleReasonReply, handleTextAnswer, hasOpenTextQuestion, reportFailure } from './actions.js';
import { chunkLines, escapeHtml, firstLine, issueUrl, cardUrl, link, truncate } from './format.js';
import { PaperclipError } from './paperclip.js';

const STATUS_SECTION_LIMIT = 15;
const STATUS_TITLE_LIMIT = 60;
const NEW_TITLE_LIMIT = 100;

const HELP = [
  '<b>Paperclip bot</b>',
  '/new &lt;text&gt; — create a task (the first line is the title)',
  '/status — what is running and what waits for you',
  '/help — this list',
  '',
  'Reply to any bot message about a task to comment on it.',
].join('\n');

const NEW_USAGE = 'Usage: /new &lt;text&gt;\nThe first line becomes the title, the whole text the description.';

function parseCommand(text) {
  const match = /^\/([A-Za-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), rest: (match[2] ?? '').trim() } : null;
}

async function reply(bot, msg, html, issue) {
  return bot.send(html, { replyTo: msg.message_id, issue });
}

async function commandNew(bot, update, rest) {
  const msg = update.message;
  if (!rest) return reply(bot, msg, NEW_USAGE);
  const body = {
    title: truncate(firstLine(rest), NEW_TITLE_LIMIT),
    description: rest,
    assigneeAgentId: bot.config.leadAgentId,
    idempotencyKey: `telegram-update-${update.update_id}`,
  };
  if (bot.config.newTaskProjectId) body.projectId = bot.config.newTaskProjectId;
  let issue;
  try {
    issue = await bot.pc.createIssue(bot.config.companyId, body);
  } catch (err) {
    await reportFailure(bot, err, msg.message_id);
    return undefined;
  }
  const verb = issue.deduplicated ? 'Already exists' : 'Created';
  const url = issueUrl(bot.config.uiBaseUrl, issue.identifier);
  return reply(bot, msg, `✅ ${verb} <b>${escapeHtml(issue.identifier)}</b>\n${link(url, 'Open in Paperclip')}`, {
    id: issue.id,
    identifier: issue.identifier,
  });
}

function section(title, lines, total) {
  const shown = lines.slice(0, STATUS_SECTION_LIMIT);
  const out = [`<b>${title}</b> (${total})`, ...shown];
  if (total > shown.length) out.push(`+${total - shown.length} more`);
  if (total === 0) out.push('Nothing here.');
  return out;
}

async function commandStatus(bot, msg) {
  const { config } = bot;
  const [running, review, items] = await Promise.all([
    bot.pc.listIssues(config.companyId, { status: 'in_progress', limit: 200 }),
    bot.pc.listIssues(config.companyId, { status: 'in_review', limit: 200 }),
    bot.pc.listAttention(config.companyId),
  ]);
  const cards = items.filter((item) => item.sourceKind === 'issue_thread_interaction' && item.relatedIssue);
  const cardIssueIds = new Set(cards.map((item) => item.relatedIssue.id));

  const runningLines = [];
  for (const issue of running.slice(0, STATUS_SECTION_LIMIT)) {
    const agent = (await bot.agentName(issue.assigneeAgentId)) ?? 'unassigned';
    runningLines.push(`• ${link(issueUrl(config.uiBaseUrl, issue.identifier), issue.identifier)} ${escapeHtml(truncate(issue.title, STATUS_TITLE_LIMIT))} — ${escapeHtml(agent)}`);
  }

  const reviewIssues = review.filter((issue) => !cardIssueIds.has(issue.id));
  const waiting = [
    ...cards.map((item) => {
      const issue = item.relatedIssue;
      const url = cardUrl(config.uiBaseUrl, issue.identifier, item.subject.id);
      return `• ❓ ${link(url, issue.identifier)} ${escapeHtml(truncate(item.subject.title ?? issue.title, STATUS_TITLE_LIMIT))}`;
    }),
    ...reviewIssues.map(
      (issue) => `• 👀 ${link(issueUrl(config.uiBaseUrl, issue.identifier), issue.identifier)} ${escapeHtml(truncate(issue.title, STATUS_TITLE_LIMIT))}`,
    ),
  ];

  const lines = [
    ...section('Running', runningLines, running.length),
    '',
    ...section('Waiting for you', waiting, waiting.length),
  ];
  for (const chunk of chunkLines(lines)) await reply(bot, msg, chunk);
}

async function runCommand(bot, update, command) {
  const msg = update.message;
  if (command.name === 'new') return commandNew(bot, update, command.rest);
  if (command.name === 'status') {
    try {
      return await commandStatus(bot, msg);
    } catch (err) {
      if (!(err instanceof PaperclipError)) throw err;
      return reportFailure(bot, err, msg.message_id);
    }
  }
  return reply(bot, msg, HELP);
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
  return reply(bot, msg, 'Reply to a task message to comment on it, or use /new &lt;text&gt; to create a task. /help lists the commands.');
}
