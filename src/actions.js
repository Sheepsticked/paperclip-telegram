import {
  buildCard,
  checkboxAcceptBody,
  chooseOption,
  formRespondBody,
  isInstantForm,
  lineForInteraction,
  openTextQuestion,
  parseCallback,
  renderCard,
  resolveCard,
  setTextAnswer,
  toggleCheckbox,
} from './cards.js';
import { escapeHtml, truncate } from './format.js';
import { PaperclipError } from './paperclip.js';
import { threadOf, where } from './thread.js';

const MAX_REASON_LENGTH = 4000;

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

export async function closeCard(bot, card, line) {
  resolveCard(card, line, new Date(bot.now()).toISOString());
  bot.state.save();
  await editCardMessage(bot, card);
}

export async function sendCard(bot, interaction, issue) {
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
  await closeCard(bot, card, current ? lineForInteraction(current) : 'Closed in Paperclip');
  return true;
}

// A 409 means the card is already settled: sync the message with whatever Paperclip now says.
async function syncClosed(bot, card) {
  try {
    if (await refreshCard(bot, card)) return;
  } catch {
    // The 409 already proves the card is settled, so fall through to a generic closing line.
  }
  if (card.status === 'pending') await closeCard(bot, card, 'Closed in Paperclip');
}

async function settle(bot, cq, card, call, line, undo) {
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
  await closeCard(bot, card, line);
  await bot.answer(cq.id, line);
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

  if (op === 'a' && card.mode === 'confirm') return settle(bot, cq, card, accept({}), 'Confirmed');
  if (op === 'a' && card.mode === 'checkbox') {
    const result = checkboxAcceptBody(card);
    if (result.alert) return bot.answer(cq.id, result.alert, true);
    return settle(bot, cq, card, accept(result.body), 'Confirmed');
  }
  if (op === 'd' && (card.mode === 'confirm' || card.mode === 'checkbox')) {
    if (card.confirm.requiresReason) return askForReason(bot, cq, card);
    return settle(bot, cq, card, reject({}), 'Declined');
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
    return settle(bot, cq, card, () => bot.pc.respond(card.issueId, card.interactionId, body.body), 'Answered', undo);
  }
  if (op === 's' && card.mode === 'form') {
    const body = formRespondBody(card);
    if (body.alert) return bot.answer(cq.id, body.alert, true);
    return settle(bot, cq, card, () => bot.pc.respond(card.issueId, card.interactionId, body.body), 'Answered');
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

export async function handleReasonReply(bot, card, msg) {
  if (card.status !== 'pending') {
    await bot.send('This card was already answered or closed.', where(bot, msg));
    return;
  }
  const reason = msg.text.trim();
  if (reason.length > MAX_REASON_LENGTH) {
    await bot.send(`The reason is too long (max ${MAX_REASON_LENGTH} characters).`, where(bot, msg));
    return;
  }
  try {
    await bot.pc.reject(card.issueId, card.interactionId, { reason });
  } catch (err) {
    const failure = await reportFailure(bot, err, msg);
    if (failure.kind === 'closed') await syncClosed(bot, card);
    return;
  }
  await closeCard(bot, card, `Declined: ${truncate(reason, 200)}`);
}

export async function handleTextAnswer(bot, card, msg) {
  const index = setTextAnswer(card, msg.text.trim());
  if (!isInstantForm(card)) {
    bot.state.save();
    await editCardMessage(bot, card);
    return;
  }
  const result = formRespondBody(card);
  try {
    await bot.pc.respond(card.issueId, card.interactionId, result.body);
  } catch (err) {
    card.answers[index].text = null;
    const failure = await reportFailure(bot, err, msg);
    if (failure.kind === 'closed') await syncClosed(bot, card);
    return;
  }
  await closeCard(bot, card, 'Answered');
}
