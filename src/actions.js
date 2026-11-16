import {
  answeredOutcome,
  buildCard,
  checkboxAcceptBody,
  chooseOption,
  confirmedOutcome,
  declinedOutcome,
  formRespondBody,
  interactionOutcome,
  isInstantForm,
  openTextQuestion,
  parseCallback,
  renderCard,
  resolveCard,
  setTextAnswer,
  toggleCheckbox,
} from './cards.js';
import { isAgentComment } from './comments.js';
import { followAsked, sendComment } from './follow.js';
import { escapeHtml, truncate } from './format.js';
import { isTelegramOutage, isUnauthorized } from './guard.js';
import { sendCardImages } from './images.js';
import { makeOutcome } from './outcome.js';
import { PaperclipError } from './paperclip.js';
import { threadOf, where } from './thread.js';

const MAX_REASON_LENGTH = 4000;
const CARD_COMMENT_READ = 50;
const MAX_CARD_COMMENTS = 3;

// Maps a Paperclip failure to what the owner should be told.
function classify(err) {
  if (!(err instanceof PaperclipError)) throw err;
  if (err.network) return { kind: 'network', text: 'Paperclip unreachable, try again' };
  if (err.status === 409) return { kind: 'closed', text: 'Already answered or closed' };
  if (err.status === 401) return { kind: 'auth', text: 'Paperclip token rejected' };
  return { kind: 'error', text: truncate(`Paperclip error: ${err.status} ${err.detail}`, 180) };
}

export async function editCardMessage(bot, card) {
  if (!card.messageId) return;
  const { text, rich, keyboard } = renderCard(card, bot.config.uiBaseUrl);
  try {
    await bot.edit(card.messageId, text, keyboard, rich);
  } catch (err) {
    bot.log.warn('could not update a card message', { error: err.message });
  }
}

export async function closeCard(bot, card, outcome) {
  resolveCard(card, outcome);
  bot.state.save();
  await editCardMessage(bot, card);
}

// The agent comments the chat has not shown that the card's run posted (or that the card names), up to the card's
// time, oldest first. A card that names neither has none.
export async function cardComments(bot, interaction, issueId) {
  const runId = interaction.sourceRunId ?? null;
  const commentId = interaction.sourceCommentId ?? null;
  if (!runId && !commentId) return [];
  const comments = await bot.pc.listComments(issueId, { limit: CARD_COMMENT_READ, order: 'desc' });
  // A named comment older than the page is read on its own.
  if (commentId && !comments.some((comment) => comment.id === commentId)) comments.push(await bot.pc.getComment(issueId, commentId));
  const cardAt = Date.parse(interaction.createdAt);
  const fromCard = (comment) => (commentId ? comment.id === commentId : false) || (runId ? comment.createdByRunId === runId : false);
  const early = (comment) => Number.isNaN(cardAt) || !(Date.parse(comment.createdAt) > cardAt);
  return comments
    .filter((comment) => !comment.deletedAt && isAgentComment(comment) && fromCard(comment) && early(comment) && !bot.state.hasShown(comment.id))
    .slice(0, MAX_CARD_COMMENTS)
    .reverse();
}

// Sends the card's comments before the card. A failure is logged and the card still goes out, unless Telegram or
// the Paperclip token is down, which fails the whole send so it is tried again.
async function sendCardComments(bot, interaction, issue) {
  let comments;
  try {
    comments = await cardComments(bot, interaction, issue.id);
  } catch (err) {
    if (isUnauthorized(err)) throw err;
    bot.log.warn(`could not read the comments of the card on ${issue.identifier}`, { error: err.message });
    return;
  }
  for (const comment of comments) {
    try {
      await sendComment(bot, issue, comment);
      bot.state.save();
    } catch (err) {
      if (isUnauthorized(err) || isTelegramOutage(err)) throw err;
      bot.log.warn(`could not send a comment of the card on ${issue.identifier}`, { error: err.message });
    }
  }
}

// A task that asks the owner is followed first, so its later comments reach the chat too.
export async function sendCard(bot, interaction, issue) {
  await followAsked(bot, issue);
  await sendCardComments(bot, interaction, issue);
  const card = buildCard({ interaction, issue, key: bot.state.nextCardKey() });
  const sent = await bot.sendAbout(
    issue,
    ({ own }) => {
      card.own = own;
      return renderCard(card, bot.config.uiBaseUrl);
    },
    { alert: true },
  );
  card.messageId = sent.messageId;
  bot.state.cards.set(card.key, card);
  bot.state.save();
  await sendCardImages(bot, issue, card, sent);
  return card;
}

// Re-reads the card from Paperclip; returns true when it is no longer pending (and the message is closed).
export async function refreshCard(bot, card, cache = new Map()) {
  let list = cache.get(card.issueId);
  if (!list) {
    try {
      list = await bot.pc.listInteractions(card.issueId);
    } catch (err) {
      if (err instanceof PaperclipError && err.status === 404) list = [];
      else throw err;
    }
    cache.set(card.issueId, list);
  }
  const current = list.find((interaction) => interaction.id === card.interactionId);
  if (current?.status === 'pending') return false;
  await closeCard(bot, card, interactionOutcome(current, bot.now()));
  return true;
}

// A 409 means the card is already settled: sync the message with whatever Paperclip now says.
async function syncClosed(bot, card) {
  try {
    if (await refreshCard(bot, card)) return;
  } catch {
    // The 409 already proves the card is settled, so fall through to a plain Closed outcome.
  }
  if (card.status === 'pending') await closeCard(bot, card, makeOutcome('Closed', null, bot.now()));
}

// Runs the Paperclip call; on success the card is settled with the outcome `outcomeAt(nowMs)` and the tap answered with its kind.
async function settle(bot, cq, card, call, outcomeAt, undo) {
  try {
    await call();
  } catch (err) {
    undo?.();
    const failure = classify(err);
    if (failure.kind === 'closed') await syncClosed(bot, card);
    if (failure.kind === 'auth') await bot.paperclipFailed(err);
    await bot.answer(cq.id, failure.text, failure.kind === 'error');
    return;
  }
  const outcome = outcomeAt(bot.now());
  await closeCard(bot, card, outcome);
  await bot.answer(cq.id, outcome.kind);
}

async function askForReason(bot, cq, card) {
  if (card.reasonPromptMessageId) return bot.answer(cq.id, 'Reply to the reason prompt first');
  const label = card.confirm.reasonLabel ?? 'Why are you declining?';
  const promptId = await bot.send(`${escapeHtml(truncate(label, 160))}\nReply to this message with your reason.`, {
    replyTo: card.messageId,
    thread: threadOf(bot, cq.message),
    forceReply: true,
  });
  card.reasonPromptMessageId = promptId;
  bot.state.save();
  await editCardMessage(bot, card);
  return bot.answer(cq.id, 'Reply with the reason');
}

export async function handleCallback(bot, cq) {
  const parsed = parseCallback(cq.data);
  const card = parsed ? bot.state.cards.get(parsed.key) : null;
  if (!card) return bot.answer(cq.id, 'This card is no longer available');
  if (card.status !== 'pending') {
    await bot.answer(cq.id, 'Already answered or closed');
    return editCardMessage(bot, card);
  }

  const { op, args } = parsed;
  const accept = (body) => () => bot.pc.accept(card.issueId, card.interactionId, body);
  const reject = (body) => () => bot.pc.reject(card.issueId, card.interactionId, body);

  if (op === 'a' && card.mode === 'confirm') return settle(bot, cq, card, accept({}), (now) => confirmedOutcome(card, now));
  if (op === 'a' && card.mode === 'checkbox') {
    const result = checkboxAcceptBody(card);
    if (result.alert) return bot.answer(cq.id, result.alert, true);
    return settle(bot, cq, card, accept(result.body), (now) => confirmedOutcome(card, now));
  }
  if (op === 'd' && (card.mode === 'confirm' || card.mode === 'checkbox')) {
    if (card.confirm.requiresReason) return askForReason(bot, cq, card);
    return settle(bot, cq, card, reject({}), (now) => declinedOutcome(card, null, now));
  }
  if (op === 't' && card.mode === 'checkbox') {
    const result = toggleCheckbox(card, args[0]);
    if (result.alert) return bot.answer(cq.id, result.alert, true);
    bot.state.save();
    await editCardMessage(bot, card);
    return bot.answer(cq.id);
  }
  if (op === 'o' && card.mode === 'form') {
    const [qIndex, oIndex] = args;
    const result = chooseOption(card, qIndex, oIndex);
    if (result.alert) return bot.answer(cq.id, result.alert, true);
    if (!result.submit) {
      bot.state.save();
      await editCardMessage(bot, card);
      return bot.answer(cq.id);
    }
    const body = formRespondBody(card);
    if (body.alert) return bot.answer(cq.id, body.alert, true);
    const undo = () => {
      card.answers[qIndex].sel = [];
    };
    return settle(bot, cq, card, () => bot.pc.respond(card.issueId, card.interactionId, body.body), (now) => answeredOutcome(card, now), undo);
  }
  if (op === 's' && card.mode === 'form') {
    const body = formRespondBody(card);
    if (body.alert) return bot.answer(cq.id, body.alert, true);
    return settle(bot, cq, card, () => bot.pc.respond(card.issueId, card.interactionId, body.body), (now) => answeredOutcome(card, now));
  }
  return bot.answer(cq.id, 'Unknown action');
}

export function findCardByMessage(state, messageId) {
  return [...state.cards.values()].find((card) => card.messageId === messageId) ?? null;
}

export function findCardByReasonPrompt(state, messageId) {
  return [...state.cards.values()].find((card) => card.reasonPromptMessageId === messageId) ?? null;
}

export function hasOpenTextQuestion(card) {
  return card.status === 'pending' && openTextQuestion(card) >= 0;
}

// Tells the owner about a failed write that was not triggered by a button tap.
export async function reportFailure(bot, err, msg) {
  const failure = classify(err);
  if (failure.kind === 'auth') await bot.paperclipFailed(err);
  else await bot.send(escapeHtml(failure.text), where(bot, msg));
  return failure;
}

// Both reply handlers say whether the owner's text was used.
export async function handleReasonReply(bot, card, msg) {
  if (card.status !== 'pending') {
    await bot.send('This card was already answered or closed.', where(bot, msg));
    return false;
  }
  const reason = msg.text.trim();
  if (reason.length > MAX_REASON_LENGTH) {
    await bot.send(`The reason is too long (max ${MAX_REASON_LENGTH} characters).`, where(bot, msg));
    return false;
  }
  try {
    await bot.pc.reject(card.issueId, card.interactionId, { reason });
  } catch (err) {
    const failure = await reportFailure(bot, err, msg);
    if (failure.kind === 'closed') await syncClosed(bot, card);
    return false;
  }
  await closeCard(bot, card, declinedOutcome(card, reason, bot.now()));
  return true;
}

export async function handleTextAnswer(bot, card, msg) {
  const index = setTextAnswer(card, msg.text.trim());
  if (!isInstantForm(card)) {
    bot.state.save();
    await editCardMessage(bot, card);
    return true;
  }
  const result = formRespondBody(card);
  try {
    await bot.pc.respond(card.issueId, card.interactionId, result.body);
  } catch (err) {
    card.answers[index].text = null;
    const failure = await reportFailure(bot, err, msg);
    if (failure.kind === 'closed') await syncClosed(bot, card);
    return false;
  }
  await closeCard(bot, card, answeredOutcome(card, bot.now()));
  return true;
}
