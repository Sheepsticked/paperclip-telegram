import fs from 'node:fs';
import path from 'node:path';

const MAX_MESSAGES = 2000;
const MAX_RICH_MESSAGES = 2000;
const MAX_ALERTED_RUNS = 500;
const MAX_SKIPPED_CARDS = 500;
const MAX_SKIPPED_INBOX = 500;
const RESOLVED_CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INBOX = 300;
const MAX_FOLLOWING = 50;
const MAX_OFFERS = 20;
const OFFER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ROOTS = 2000;
const MAX_REVIEW_SENT = 2000;
const MAX_STATUS_RETRIES = 200;
const MAX_SHOWN_COMMENTS = 500;

export const DEFAULT_SETTINGS = {
  done: true,
  inReview: true,
  runFailed: true,
  followedComments: true,
  autoFollowCreated: true,
};

const MUTED_KINDS = ['done', 'inReview', 'runFailed', 'comments'];

function loadSettings(saved) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) if (typeof saved?.[key] === 'boolean') settings[key] = saved[key];
  return settings;
}

function loadMutedCounts(saved) {
  return Object.fromEntries(MUTED_KINDS.map((kind) => [kind, Number.isInteger(saved?.[kind]) && saved[kind] > 0 ? saved[kind] : 0]));
}

// Keeps only well-formed topic entries, so a hand-edited file cannot break the lookups.
// `iconId` is only kept for an open topic that an older version gave an icon, until the bot has taken the icon off.
function loadTopics(saved) {
  const topics = new Map();
  for (const [rootId, topic] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
    if (!Number.isInteger(topic?.thread)) continue;
    const closed = topic.closed === 'done' || topic.closed === 'cancelled' ? topic.closed : null;
    // An entry without the flag that is closed is taken to carry a status suffix in its name.
    const suffixed = typeof topic.suffixed === 'boolean' ? topic.suffixed : closed !== null;
    topics.set(rootId, {
      thread: topic.thread,
      identifier: String(topic.identifier ?? ''),
      title: String(topic.title ?? ''),
      closed,
      suffixed,
      closedAt: closed !== null && Number.isFinite(topic.closedAt) ? topic.closedAt : null,
      ...(closed === null && typeof topic.iconId === 'string' && topic.iconId !== '' ? { iconId: topic.iconId } : {}),
    });
  }
  return topics;
}

function loadRoots(saved) {
  const entries = Object.entries(saved && typeof saved === 'object' ? saved : {}).filter(([, rootId]) => typeof rootId === 'string');
  return new Map(entries.slice(-MAX_ROOTS));
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stringOrNull = (value) => (typeof value === 'string' ? value : null);

// Followed tasks from a saved file; an entry without an identifier is dropped.
function loadFollowing(saved) {
  const following = new Map();
  for (const [issueId, entry] of Object.entries(isObject(saved) ? saved : {})) {
    if (!isObject(entry) || typeof entry.identifier !== 'string') continue;
    following.set(issueId, {
      identifier: entry.identifier,
      title: String(entry.title ?? ''),
      status: String(entry.status ?? ''),
      lastSeenCommentId: stringOrNull(entry.lastSeenCommentId),
      lastSeenAt: stringOrNull(entry.lastSeenAt),
      retry: Number.isInteger(entry.retry) && entry.retry > 0 ? entry.retry : 0,
    });
  }
  return following;
}

// Pending "create a task" offers from a saved file; an entry that cannot be used is dropped.
function loadOffers(saved) {
  const offers = new Map();
  for (const [key, offer] of Object.entries(isObject(saved) ? saved : {})) {
    const usable =
      isObject(offer) &&
      typeof offer.text === 'string' &&
      Number.isFinite(offer.at) &&
      Number.isInteger(offer.messageId) &&
      (offer.thread === null || offer.thread === undefined || Number.isInteger(offer.thread)) &&
      (offer.file === null || offer.file === undefined || (isObject(offer.file) && typeof offer.file.fileId === 'string' && typeof offer.file.name === 'string'));
    if (!usable) continue;
    offers.set(key, {
      text: offer.text,
      messageId: offer.messageId,
      updateId: Number.isInteger(offer.updateId) ? offer.updateId : 0,
      at: offer.at,
      thread: offer.thread ?? null,
      file: offer.file ?? null,
      agentId: stringOrNull(offer.agentId),
      prompt: stringOrNull(offer.prompt),
    });
  }
  return offers;
}

function loadPrefixCounts(saved) {
  const counts = {};
  for (const [prefix, count] of Object.entries(isObject(saved) ? saved : {})) if (Number.isInteger(count) && count > 0) counts[prefix] = count;
  return counts;
}

function loadReviewSent(saved) {
  const ids = Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [];
  return new Set(ids.slice(-MAX_REVIEW_SENT));
}

function loadShownComments(saved) {
  const ids = Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [];
  return new Set(ids.slice(-MAX_SHOWN_COMMENTS));
}

// Failed status messages that are tried again: issue id to the status and the number of failed tries.
function loadStatusRetries(saved) {
  const retries = new Map();
  for (const [issueId, entry] of Object.entries(isObject(saved) ? saved : {})) {
    if (isObject(entry) && typeof entry.status === 'string' && Number.isInteger(entry.tries) && entry.tries > 0) retries.set(issueId, { status: entry.status, tries: entry.tries });
  }
  return retries;
}

// Inbox records from a saved file; an entry that is not usable is dropped.
function loadInbox(saved) {
  const inbox = new Map();
  for (const [key, record] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
    const usable =
      record &&
      typeof record === 'object' &&
      typeof record.kind === 'string' &&
      typeof record.dedupKey === 'string' &&
      (record.status === 'open' || record.status === 'resolved') &&
      [record.messageIds, record.facts, record.options].every(Array.isArray);
    if (usable) inbox.set(key, record);
  }
  return inbox;
}

// Persistent bot state, saved atomically (temp file, then rename) with mode 600.
export class State {
  constructor(file, data = {}) {
    this.file = file;
    this.chatId = Number.isFinite(data.chatId) ? data.chatId : null;
    this.offset = data.offset ?? 0;
    this.cardCounter = data.cardCounter ?? 0;
    this.cards = new Map(Object.entries(data.cards ?? {}));
    this.messages = new Map((data.messages ?? []).map(([id, issueId]) => [Number(id), issueId]));
    this.richMessages = new Set((Array.isArray(data.richMessages) ? data.richMessages : []).filter(Number.isInteger).slice(-MAX_RICH_MESSAGES));
    this.identifiers = new Map(Object.entries(data.identifiers ?? {}));
    this.alertedRuns = data.alertedRuns ?? [];
    this.skippedCards = data.skippedCards ?? [];
    this.inbox = loadInbox(data.inbox);
    this.inboxCounter = Number.isInteger(data.inboxCounter) ? data.inboxCounter : 0;
    this.skippedInbox = Array.isArray(data.skippedInbox) ? data.skippedInbox.filter((dedupKey) => typeof dedupKey === 'string') : [];
    this.statuses = new Map(Object.entries(data.statuses ?? {}));
    this.baselineAt = data.baselineAt ?? null;
    this.initialSyncDone = data.initialSyncDone ?? false;
    this.inboxSyncDone = data.inboxSyncDone === true;
    this.cardResync = data.cardResync === true;
    this.lastPollAt = data.lastPollAt ?? null;
    this.lastAuthAlertAt = data.lastAuthAlertAt ?? null;
    this.settings = loadSettings(data.settings);
    this.muteUntil = data.muteUntil ?? null;
    this.mutedCounts = loadMutedCounts(data.mutedCounts);
    this.following = loadFollowing(data.following);
    this.offers = loadOffers(data.offers);
    this.offerCounter = Number.isInteger(data.offerCounter) && data.offerCounter >= 0 ? data.offerCounter : 0;
    this.prefixCounts = loadPrefixCounts(data.prefixCounts);
    this.reviewSent = loadReviewSent(data.reviewSent);
    this.statusRetries = loadStatusRetries(data.statusRetries);
    this.shownComments = loadShownComments(data.shownComments);
    this.topics = loadTopics(data.topics);
    this.roots = loadRoots(data.roots);
    this.boardMessageId = Number.isInteger(data.boardMessageId) ? data.boardMessageId : null;
    this.boardHash = stringOrNull(data.boardHash);
  }

  // A missing file starts fresh; an unreadable one is set aside and the bot starts fresh too.
  static load(file, log) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return new State(file);
      throw err;
    }
    try {
      return new State(file, JSON.parse(text));
    } catch {
      fs.renameSync(file, `${file}.corrupt`);
      log?.warn('state file was not valid JSON; moved aside and starting fresh');
      return new State(file);
    }
  }

  // Takes the configured chat. When the saved chat differs, everything tied to its message ids is dropped
  // (message ids restart in every chat) and the open cards and inbox items are sent again to the new one.
  adoptChat(chatId) {
    if (this.chatId === chatId) return false;
    const changed = this.chatId !== null;
    this.chatId = chatId;
    if (!changed) return false;
    this.messages.clear();
    this.richMessages.clear();
    this.identifiers.clear();
    this.cards.clear();
    this.inbox.clear();
    this.offers.clear();
    this.topics.clear();
    this.boardMessageId = null;
    this.boardHash = null;
    this.shownComments.clear();
    this.inboxSyncDone = false;
    this.cardResync = true;
    return true;
  }

  nextCardKey() {
    this.cardCounter += 1;
    return this.cardCounter.toString(36);
  }

  mapMessage(messageId, issueId, identifier) {
    this.messages.delete(messageId);
    this.messages.set(messageId, issueId);
    if (identifier) this.identifiers.set(issueId, identifier);
    while (this.messages.size > MAX_MESSAGES) this.messages.delete(this.messages.keys().next().value);
  }

  // Messages sent as rich messages, so an edit of one is a rich edit.
  noteRich(messageId) {
    this.richMessages.delete(messageId);
    this.richMessages.add(messageId);
    while (this.richMessages.size > MAX_RICH_MESSAGES) this.richMessages.delete(this.richMessages.values().next().value);
  }

  isRich(messageId) {
    return this.richMessages.has(messageId);
  }

  dropRich(messageId) {
    this.richMessages.delete(messageId);
  }

  issueForMessage(messageId) {
    const issueId = this.messages.get(messageId);
    return issueId ? { id: issueId, identifier: this.identifiers.get(issueId) ?? null } : null;
  }

  markRunAlerted(runId) {
    if (this.alertedRuns.includes(runId)) return;
    this.alertedRuns.push(runId);
    if (this.alertedRuns.length > MAX_ALERTED_RUNS) this.alertedRuns.splice(0, this.alertedRuns.length - MAX_ALERTED_RUNS);
  }

  // Interactions left out of the first-start batch; they are never sent later.
  skipCard(interactionId) {
    if (this.skippedCards.includes(interactionId)) return;
    this.skippedCards.push(interactionId);
    if (this.skippedCards.length > MAX_SKIPPED_CARDS) this.skippedCards.splice(0, this.skippedCards.length - MAX_SKIPPED_CARDS);
  }

  nextInboxKey() {
    this.inboxCounter += 1;
    return this.inboxCounter.toString(36);
  }

  // Inbox items left out of the first-start batch; they are not sent unless they leave the feed and come back.
  skipInbox(dedupKey) {
    if (this.skippedInbox.includes(dedupKey)) return;
    this.skippedInbox.push(dedupKey);
    if (this.skippedInbox.length > MAX_SKIPPED_INBOX) this.skippedInbox.splice(0, this.skippedInbox.length - MAX_SKIPPED_INBOX);
  }

  openInbox() {
    return [...this.inbox.values()].filter((record) => record.status === 'open');
  }

  inboxByDedupKey(dedupKey) {
    return this.openInbox().find((record) => record.dedupKey === dedupKey) ?? null;
  }

  inboxByNotePrompt(messageId) {
    return this.openInbox().find((record) => record.notePromptMessageId === messageId) ?? null;
  }

  // Drops old resolved records, and the oldest ones when there are too many.
  pruneInbox(now) {
    for (const [key, record] of this.inbox) {
      if (record.status === 'resolved' && record.resolvedAt && now - Date.parse(record.resolvedAt) > RESOLVED_CARD_TTL_MS) this.inbox.delete(key);
    }
    for (const [key, record] of this.inbox) {
      if (this.inbox.size <= MAX_INBOX) break;
      if (record.status === 'resolved') this.inbox.delete(key);
    }
  }

  // Remembers that an in-review message went out for the task.
  noteReviewSent(issueId) {
    this.reviewSent.delete(issueId);
    this.reviewSent.add(issueId);
    while (this.reviewSent.size > MAX_REVIEW_SENT) this.reviewSent.delete(this.reviewSent.values().next().value);
  }

  // Remembers that a comment was shown in the chat, so it is not quoted or sent a second time.
  noteShown(commentId) {
    if (!commentId) return;
    this.shownComments.delete(commentId);
    this.shownComments.add(commentId);
    while (this.shownComments.size > MAX_SHOWN_COMMENTS) this.shownComments.delete(this.shownComments.values().next().value);
  }

  hasShown(commentId) {
    return this.shownComments.has(commentId);
  }

  // Counts a failed status message; returns the number of failed tries for this issue and status.
  noteStatusFailure(issueId, status) {
    const previous = this.statusRetries.get(issueId);
    const tries = (previous?.status === status ? previous.tries : 0) + 1;
    this.statusRetries.delete(issueId);
    this.statusRetries.set(issueId, { status, tries });
    while (this.statusRetries.size > MAX_STATUS_RETRIES) this.statusRetries.delete(this.statusRetries.keys().next().value);
    return tries;
  }

  pendingCards() {
    return [...this.cards.values()].filter((card) => card.status === 'pending');
  }

  cardByInteraction(interactionId) {
    return [...this.cards.values()].find((card) => card.interactionId === interactionId) ?? null;
  }

  pruneCards(now) {
    for (const [key, card] of this.cards) {
      if (card.status === 'resolved' && card.resolvedAt && now - Date.parse(card.resolvedAt) > RESOLVED_CARD_TTL_MS) {
        this.cards.delete(key);
      }
    }
  }

  isMuted(nowMs) {
    return this.muteUntil != null && nowMs < Date.parse(this.muteUntil);
  }

  mute(nowMs, hours) {
    this.muteUntil = new Date(nowMs + hours * 60 * 60 * 1000).toISOString();
  }

  // Remembers one suppressed message of the given kind (done, inReview, runFailed, comments).
  countMuted(kind) {
    this.mutedCounts[kind] += 1;
  }

  // What the mute hid so far, or null when nothing was hidden.
  hiddenCounts() {
    return MUTED_KINDS.some((kind) => this.mutedCounts[kind] > 0) ? { ...this.mutedCounts } : null;
  }

  endMute() {
    this.muteUntil = null;
    this.mutedCounts = loadMutedCounts();
  }

  isFollowing(issueId) {
    return this.following.has(issueId);
  }

  // Starts following; at the limit the oldest followed task is dropped and its identifier returned.
  follow(issueId, entry) {
    this.following.delete(issueId);
    this.following.set(issueId, entry);
    if (this.following.size <= MAX_FOLLOWING) return null;
    const [oldestId, oldest] = this.following.entries().next().value;
    this.following.delete(oldestId);
    return oldest.identifier;
  }

  unfollow(issueId) {
    return this.following.delete(issueId);
  }

  // `file` is a Telegram file waiting to be attached to the new task; `agentId` is the agent picked so far;
  // `prompt` is the text of the offer message.
  addOffer(text, messageId, updateId, nowMs, thread = null, { file = null, agentId = null, prompt = null } = {}) {
    this.offerCounter += 1;
    const key = this.offerCounter.toString(36);
    this.offers.set(key, { text, messageId, updateId, at: nowMs, thread, file, agentId, prompt });
    while (this.offers.size > MAX_OFFERS) this.offers.delete(this.offers.keys().next().value);
    return key;
  }

  getOffer(key, nowMs) {
    const offer = this.offers.get(key);
    return offer && nowMs - offer.at <= OFFER_TTL_MS ? offer : null;
  }

  pruneOffers(nowMs) {
    for (const [key, offer] of this.offers) if (nowMs - offer.at > OFFER_TTL_MS) this.offers.delete(key);
  }

  // Remembers which top-level task an issue belongs to; the oldest entries go first.
  noteRoot(issueId, rootId) {
    this.roots.delete(issueId);
    this.roots.set(issueId, rootId);
    while (this.roots.size > MAX_ROOTS) this.roots.delete(this.roots.keys().next().value);
  }

  rootForThread(thread) {
    for (const [rootId, topic] of this.topics) if (topic.thread === thread) return rootId;
    return null;
  }

  // The top-level task of an issue, from what is already known; nothing is read. Null when it is not known.
  knownRoot(issueId, parentId) {
    const direct = this.roots.get(issueId) ?? (this.topics.has(issueId) ? issueId : null);
    if (direct || !parentId) return direct;
    return this.roots.get(parentId) ?? (this.topics.has(parentId) ? parentId : null);
  }

  // A closed topic that was saved without the time it was closed counts from now.
  stampClosedTopics(nowMs) {
    let changed = false;
    for (const topic of this.topics.values()) {
      if (topic.closed !== null && topic.closedAt === null) {
        topic.closedAt = nowMs;
        changed = true;
      }
    }
    return changed;
  }

  // Drops the topic of a task, and the offers that were made in that topic.
  forgetTopic(rootId) {
    const topic = this.topics.get(rootId);
    if (!topic) return;
    this.topics.delete(rootId);
    for (const [key, offer] of this.offers) if (offer.thread === topic.thread) this.offers.delete(key);
  }

  // Counts the company prefix of an identifier so /task <number> can guess it.
  notePrefix(identifier) {
    const dash = String(identifier ?? '').indexOf('-');
    if (dash <= 0) return;
    const prefix = identifier.slice(0, dash);
    this.prefixCounts[prefix] = (this.prefixCounts[prefix] ?? 0) + 1;
  }

  topPrefix() {
    const entries = Object.entries(this.prefixCounts);
    return entries.length ? entries.sort((a, b) => b[1] - a[1])[0][0] : null;
  }

  toJSON() {
    const referenced = new Set(this.messages.values());
    return {
      version: 2,
      chatId: this.chatId,
      offset: this.offset,
      cardCounter: this.cardCounter,
      cards: Object.fromEntries(this.cards),
      messages: [...this.messages],
      richMessages: [...this.richMessages],
      identifiers: Object.fromEntries([...this.identifiers].filter(([issueId]) => referenced.has(issueId))),
      alertedRuns: this.alertedRuns,
      skippedCards: this.skippedCards,
      inbox: Object.fromEntries(this.inbox),
      inboxCounter: this.inboxCounter,
      skippedInbox: this.skippedInbox,
      statuses: Object.fromEntries(this.statuses),
      baselineAt: this.baselineAt,
      initialSyncDone: this.initialSyncDone,
      inboxSyncDone: this.inboxSyncDone,
      cardResync: this.cardResync,
      lastPollAt: this.lastPollAt,
      lastAuthAlertAt: this.lastAuthAlertAt,
      settings: this.settings,
      muteUntil: this.muteUntil,
      mutedCounts: this.mutedCounts,
      following: Object.fromEntries(this.following),
      offers: Object.fromEntries(this.offers),
      offerCounter: this.offerCounter,
      prefixCounts: this.prefixCounts,
      topics: Object.fromEntries(this.topics),
      roots: Object.fromEntries(this.roots),
      boardMessageId: this.boardMessageId,
      boardHash: this.boardHash,
      reviewSent: [...this.reviewSent],
      statusRetries: Object.fromEntries(this.statusRetries),
      shownComments: [...this.shownComments],
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
