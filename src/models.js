import { createHash } from 'node:crypto';
import { button, choiceButton } from './format.js';
import { PaperclipError } from './paperclip.js';

// What a tap on a picker button answers when the list or the item behind it changed.
export const STALE_LIST = 'List changed, try again';

const MODEL_CACHE_MS = 10 * 60 * 1000;
const FAILED_CACHE_MS = 60 * 1000;
// Model buttons per page, two to a row; a long list is paged to stay under Telegram's button limit.
const MODEL_PAGE = 30;
const REASONING_PER_ROW = 3;

const REASONING_LABELS = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

// The values each adapter accepts for a model, as its package defines them.
function claudeValues(model) {
  const id = model.trim().replace(/\[1m\]$/, '').replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, '');
  if (/^claude-haiku-/.test(id)) return [];
  if (/^claude-(?:opus-5(?:-5)?|opus-4-[78]|sonnet-5(?:-5)?|fable-5(?:-1)?)$/.test(id)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/^claude-(?:opus|sonnet)-4-6(?:-v1)?$/.test(id)) return ['low', 'medium', 'high', 'max'];
  return ['low', 'medium', 'high'];
}

const CODEX_ULTRA = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CODEX_MAX = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_DEFAULT = ['minimal', 'low', 'medium', 'high', 'xhigh'];

function codexValues(model) {
  const id = model.trim() === 'gpt-5.6' ? 'gpt-5.6-sol' : model.trim();
  if (['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra'].includes(id)) return CODEX_ULTRA;
  if (['gpt-6-luna', 'gpt-5.6-luna'].includes(id)) return CODEX_MAX;
  return CODEX_DEFAULT;
}

const PI_VALUES = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

// Adapter type -> the config key of its reasoning level (`aliases` are older names it still reads), the values a
// model accepts, and the model a missing one stands for. Other adapter types get no reasoning control.
const ADAPTERS = {
  claude_local: { key: 'effort', aliases: [], values: claudeValues, defaultModel: 'claude-opus-5' },
  codex_local: { key: 'modelReasoningEffort', aliases: ['reasoningEffort'], values: codexValues, defaultModel: '' },
  pi_local: { key: 'thinking', aliases: [], values: () => PI_VALUES, defaultModel: '' },
};
const ALL_REASONING_KEYS = [...new Set(Object.values(ADAPTERS).flatMap((adapter) => [adapter.key, ...adapter.aliases]))];

const text = (value) => (typeof value === 'string' ? value.trim() : '');

export const reasoningKey = (type) => ADAPTERS[type]?.key ?? null;

export const readModel = (config) => text(config?.model);

// The reasoning level a config sets for the adapter, or '' when none.
export function readReasoning(type, config) {
  const adapter = ADAPTERS[type];
  if (!adapter) return '';
  return [adapter.key, ...adapter.aliases].map((key) => text(config?.[key])).find(Boolean) ?? '';
}

// The values a model accepts; none for an adapter type without a reasoning level.
export function reasoningValues(type, model) {
  const adapter = ADAPTERS[type];
  if (!adapter) return [];
  return adapter.values(text(model) || adapter.defaultModel);
}

export function reasoningLabel(value) {
  const name = REASONING_LABELS[value];
  if (name) return name;
  const raw = String(value);
  return raw ? `${raw[0].toUpperCase()}${raw.slice(1)}` : 'Default';
}

export const modelLabel = (models, id) => models.find((model) => model.id === id)?.label ?? id;

// A short stand-in for a model id in a button, so the button stays under Telegram's byte limit.
export const modelHash = (id) => createHash('sha1').update(String(id)).digest('hex').slice(0, 4);

// Model lists per adapter type, kept for a while. A type whose list failed counts as empty for a minute.
export class ModelCache {
  #entries = new Map();
  #pc;
  #companyId;
  #now;
  #log;

  constructor({ pc, companyId, now, log }) {
    this.#pc = pc;
    this.#companyId = companyId;
    this.#now = now;
    this.#log = log;
  }

  // [{ id, label }] from Paperclip. `fresh` reads it again and lets a failure through.
  async list(type, { fresh = false } = {}) {
    if (!type) return [];
    const hit = this.#entries.get(type);
    if (!fresh && hit && this.#now() < hit.until) return hit.models;
    let body;
    try {
      body = await this.#pc.listAdapterModels(this.#companyId, type);
    } catch (err) {
      if (fresh || (err instanceof PaperclipError && err.status === 401)) throw err;
      this.#log.warn('could not load the models', { type, error: err.message });
      this.#entries.set(type, { models: [], until: this.#now() + FAILED_CACHE_MS });
      return [];
    }
    const found = new Map();
    for (const entry of Array.isArray(body) ? body : []) {
      const id = text(entry?.id);
      if (id && !found.has(id)) found.set(id, { id, label: text(entry.label) || id });
    }
    const models = [...found.values()];
    this.#entries.set(type, { models, until: this.#now() + MODEL_CACHE_MS });
    return models;
  }
}

// Model buttons, two to a row, the current one blue with a check mark. `pick(index, id)` and `turn(page)` make the
// callback data; the page holding the current model opens first.
export function modelRows({ models, current, page, pick, turn }) {
  const pages = Math.max(1, Math.ceil(models.length / MODEL_PAGE));
  const shown = page ?? Math.floor(Math.max(0, models.findIndex((model) => model.id === current)) / MODEL_PAGE);
  const at = Math.min(Math.max(shown, 0), pages - 1);
  const rows = [];
  models.slice(at * MODEL_PAGE, (at + 1) * MODEL_PAGE).forEach((model, i) => {
    const index = at * MODEL_PAGE + i;
    const choice = choiceButton(model.label, model.id === current, pick(index, model.id));
    if (i % 2 === 0) rows.push([choice]);
    else rows.at(-1).push(choice);
  });
  if (pages > 1) {
    rows.push([
      ...(at > 0 ? [button('◀', turn(at - 1))] : []),
      button(`${at + 1}/${pages}`, turn(at)),
      ...(at < pages - 1 ? [button('▶', turn(at + 1))] : []),
    ]);
  }
  return rows;
}

// `Default` and the allowed values; `pick(value)` makes the callback data, with '' for Default.
export function reasoningRows({ values, current, pick }) {
  const options = [['', 'Default'], ...values.map((value) => [value, reasoningLabel(value)])];
  const rows = [];
  options.forEach(([value, label], i) => {
    const choice = choiceButton(label, value === current, pick(value));
    if (i % REASONING_PER_ROW === 0) rows.push([choice]);
    else rows.at(-1).push(choice);
  });
  return rows;
}

// The adapterConfig keys to send for an agent's new model: the model, and a cleared reasoning level when the
// current one is not allowed for it.
export function agentModelChange(type, config, modelId) {
  const change = { model: modelId };
  const current = readReasoning(type, config);
  if (current && !reasoningValues(type, modelId).includes(current)) Object.assign(change, clearedReasoning(type, config));
  return change;
}

// The key for an agent's new reasoning level; an empty value (Default) also empties an older name that is still set.
export function agentReasoningChange(type, config, value) {
  const key = reasoningKey(type);
  return value ? { [key]: value } : clearedReasoning(type, config);
}

// Empty strings are how Paperclip's own form clears a level, and every adapter reads an empty string as unset.
function clearedReasoning(type, config) {
  const { key, aliases } = ADAPTERS[type];
  return Object.fromEntries([key, ...aliases.filter((alias) => text(config?.[alias]))].map((name) => [name, '']));
}

// An override from its adapterConfig; `useProjectWorkspace` is kept, and an override with nothing in it is null.
function overrideOf(override, config) {
  const next = {};
  if (Object.keys(config).length > 0) next.adapterConfig = config;
  if (typeof override?.useProjectWorkspace === 'boolean') next.useProjectWorkspace = override.useProjectWorkspace;
  return Object.keys(next).length > 0 ? next : null;
}

// The override without its model and reasoning keys (Agent default).
export function overrideWithoutModel(override) {
  const config = { ...override?.adapterConfig };
  for (const key of ['model', ...ALL_REASONING_KEYS]) delete config[key];
  return overrideOf(override, config);
}

// The override's level under its own key only: older names are folded into it, so a reset or a change reaches them.
function foldReasoning(type, config) {
  const { key, aliases } = ADAPTERS[type];
  const level = readReasoning(type, config);
  for (const name of [key, ...aliases]) delete config[name];
  return level;
}

// The override with a new model. Its own level stays only when the model allows it; an agent level the model
// does not allow is blanked in the override (the agent's older names too, which the adapter would fall back to).
export function overrideWithModel(type, override, agentConfig, modelId) {
  const config = { ...override?.adapterConfig, model: modelId };
  if (ADAPTERS[type]) {
    const allowed = reasoningValues(type, modelId);
    const own = foldReasoning(type, config);
    const inherited = readReasoning(type, agentConfig);
    if (allowed.includes(own)) config[reasoningKey(type)] = own;
    else if (inherited && !allowed.includes(inherited)) Object.assign(config, clearedReasoning(type, agentConfig));
  }
  return overrideOf(override, config);
}

// The override with a new reasoning level; an empty value (Default) hands the level back to the agent, unless the
// agent's level does not suit the override's model.
export function overrideWithReasoning(type, override, agentConfig, value) {
  const config = { ...override?.adapterConfig };
  if (!ADAPTERS[type]) return overrideOf(override, config);
  foldReasoning(type, config);
  const inherited = readReasoning(type, agentConfig);
  if (value) config[reasoningKey(type)] = value;
  else if (inherited && !reasoningValues(type, text(config.model) || readModel(agentConfig)).includes(inherited)) Object.assign(config, clearedReasoning(type, agentConfig));
  return overrideOf(override, config);
}

// What an override sets: its model id and reasoning level ('' for none).
export function overrideSettings(override) {
  const config = override?.adapterConfig ?? {};
  return { model: readModel(config), reasoning: ALL_REASONING_KEYS.map((key) => text(config[key])).find(Boolean) ?? '' };
}
