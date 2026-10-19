import fs from 'node:fs';
import path from 'node:path';

const MAX_MESSAGES = 2000;
const MAX_ALERTED_RUNS = 500;
const RESOLVED_CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    this.statuses = new Map(Object.entries(data.statuses ?? {}));
    this.baselineAt = data.baselineAt ?? null;
    this.initialSyncDone = data.initialSyncDone ?? false;
    this.lastPollAt = data.lastPollAt ?? null;
    this.lastAuthAlertAt = data.lastAuthAlertAt ?? null;
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

  toJSON() {
    const referenced = new Set(this.messages.values());
    return {
      version: 1,
      offset: this.offset,
      cardCounter: this.cardCounter,
      cards: Object.fromEntries(this.cards),
      messages: [...this.messages],
      identifiers: Object.fromEntries([...this.identifiers].filter(([issueId]) => referenced.has(issueId))),
      alertedRuns: this.alertedRuns,
      statuses: Object.fromEntries(this.statuses),
      baselineAt: this.baselineAt,
      initialSyncDone: this.initialSyncDone,
      lastPollAt: this.lastPollAt,
      lastAuthAlertAt: this.lastAuthAlertAt,
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
