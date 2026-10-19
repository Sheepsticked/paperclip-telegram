import fs from 'node:fs';
import path from 'node:path';

const MAX_MESSAGES = 2000;
const MAX_ALERTED_RUNS = 500;
const MAX_SKIPPED_CARDS = 500;
const RESOLVED_CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FOLLOWING = 50;
const MAX_OFFERS = 20;
const OFFER_TTL_MS = 24 * 60 * 60 * 1000;

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

// Persistent bot state, saved atomically (temp file, then rename) with mode 600.
export class State {
  constructor(file, data = {}) {
    this.file = file;
    this.offset = data.offset ?? 0;
    this.cardCounter = data.cardCounter ?? 0;
    this.cards = new Map(Object.entries(data.cards ?? {}));
    this.messages = new Map((data.messages ?? []).map(([id, issueId]) => [Number(id), issueId]));
    this.identifiers = new Map(Object.entries(data.identifiers ?? {}));
    this.alertedRuns = data.alertedRuns ?? [];
    this.skippedCards = data.skippedCards ?? [];
    this.statuses = new Map(Object.entries(data.statuses ?? {}));
    this.baselineAt = data.baselineAt ?? null;
    this.initialSyncDone = data.initialSyncDone ?? false;
    this.lastPollAt = data.lastPollAt ?? null;
    this.lastAuthAlertAt = data.lastAuthAlertAt ?? null;
    this.settings = loadSettings(data.settings);
    this.muteUntil = data.muteUntil ?? null;
    this.mutedCounts = loadMutedCounts(data.mutedCounts);
    this.following = new Map(Object.entries(data.following ?? {}));
    this.offers = new Map(Object.entries(data.offers ?? {}));
    this.offerCounter = data.offerCounter ?? 0;
    this.prefixCounts = data.prefixCounts ?? {};
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

  addOffer(text, messageId, updateId, nowMs) {
    this.offerCounter += 1;
    const key = this.offerCounter.toString(36);
    this.offers.set(key, { text, messageId, updateId, at: nowMs });
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
      offset: this.offset,
      cardCounter: this.cardCounter,
      cards: Object.fromEntries(this.cards),
      messages: [...this.messages],
      identifiers: Object.fromEntries([...this.identifiers].filter(([issueId]) => referenced.has(issueId))),
      alertedRuns: this.alertedRuns,
      skippedCards: this.skippedCards,
      statuses: Object.fromEntries(this.statuses),
      baselineAt: this.baselineAt,
      initialSyncDone: this.initialSyncDone,
      lastPollAt: this.lastPollAt,
      lastAuthAlertAt: this.lastAuthAlertAt,
      settings: this.settings,
      muteUntil: this.muteUntil,
      mutedCounts: this.mutedCounts,
      following: Object.fromEntries(this.following),
      offers: Object.fromEntries(this.offers),
      offerCounter: this.offerCounter,
      prefixCounts: this.prefixCounts,
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
