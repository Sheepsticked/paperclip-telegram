import { button, choiceButton, truncate } from './format.js';
import {
  modelHash,
  modelLabel,
  modelRows,
  overrideWithModel,
  overrideWithReasoning,
  readModel,
  readReasoning,
  reasoningLabel,
  reasoningRows,
  reasoningValues,
} from './models.js';

const NAME_MAX = 60;

// What a task made from an offer will run with, and which model and reasoning choices its agent's adapter has.
// The agent is the one picked so far, else Lead. The picks count only for the adapter type they were made for;
// `fresh` reads the agent list again. `model` and `level` are the effective ones ('' for the adapter's default).
export async function offerRun(bot, offer, options) {
  const id = offer.agentId ?? bot.config.leadAgentId;
  const agent = (await bot.agentRecords(options)).find((entry) => entry.id === id) ?? null;
  const run = { agent, models: [], values: [], model: '', level: '', chosenModel: '', chosenReasoning: '' };
  const type = agent?.adapterType;
  if (!type) return run;
  const picked = offer.adapterType === type;
  run.models = await bot.models.list(type);
  run.chosenModel = (picked && offer.model) || '';
  run.model = run.chosenModel || readModel(agent.adapterConfig);
  run.values = reasoningValues(type, run.model);
  run.chosenReasoning = picked && run.values.includes(offer.reasoning) ? offer.reasoning : '';
  const inherited = readReasoning(type, agent.adapterConfig);
  run.level = run.chosenReasoning || (run.values.includes(inherited) ? inherited : '');
  return run;
}

// The Model and Reasoning buttons, each only when there is something to choose from.
export function controlsRow(key, run) {
  const row = [];
  if (run.models.length > 0) row.push(button(`Model · ${run.model ? modelLabel(run.models, run.model) : 'Default'}`, `O:m:${key}`));
  if (run.values.length > 0) row.push(button(`Reasoning · ${run.level ? reasoningLabel(run.level) : 'Default'}`, `O:r:${key}`));
  return row;
}

export function modelPickerRows(key, run, page) {
  return [
    [choiceButton('Agent default', !run.chosenModel, `O:M:${key}:-`)],
    ...modelRows({
      models: run.models,
      current: run.chosenModel,
      page,
      pick: (index, id) => `O:M:${key}:${index}:${modelHash(id)}`,
      turn: (turn) => `O:m:${key}:${turn}`,
    }),
    [button('◀ Back', `O:b:${key}`)],
  ];
}

export function reasoningPickerRows(key, run) {
  return [...reasoningRows({ values: run.values, current: run.chosenReasoning, pick: (value) => `O:R:${key}:${value || '-'}` }), [button('◀ Back', `O:b:${key}`)]];
}

// Saves the picks of the offer; they belong to the adapter type of the agent they were made for.
function save(offer, type, model, reasoning) {
  Object.assign(offer, { model: model || null, reasoning: reasoning || null, adapterType: model || reasoning ? type : null });
}

// The picks that still stand for `type`: none when they were made for another adapter type.
const picksFor = (offer, type) => (offer.adapterType === type ? { model: offer.model ?? '', reasoning: offer.reasoning ?? '' } : { model: '', reasoning: '' });

// Picks a model for the offer ('' is Agent default); a level the model does not allow is dropped.
export function chooseModel(offer, run, model) {
  const type = run.agent.adapterType;
  const { reasoning } = picksFor(offer, type);
  const allowed = reasoningValues(type, model || readModel(run.agent.adapterConfig));
  save(offer, type, model, allowed.includes(reasoning) ? reasoning : '');
}

// Picks a reasoning level for the offer ('' is Default).
export function chooseReasoning(offer, run, reasoning) {
  save(offer, run.agent.adapterType, picksFor(offer, run.agent.adapterType).model, reasoning);
}

// Moves the picks to another agent. Another adapter type drops them; the same type keeps the model, and the level
// as long as the model the task will run with allows it. Returns what the owner is told when something was dropped.
export function carryPicks(offer, agent) {
  if (!offer.model && !offer.reasoning) return null;
  const name = truncate(agent.name, NAME_MAX);
  if (offer.adapterType !== agent.adapterType) {
    save(offer, null, '', '');
    return `Model and reasoning reset for ${name}`;
  }
  if (offer.reasoning && !reasoningValues(agent.adapterType, offer.model || readModel(agent.adapterConfig)).includes(offer.reasoning)) {
    save(offer, agent.adapterType, offer.model, '');
    return `Reasoning reset for ${name}`;
  }
  return null;
}

// The adapter override of the new task for the picks, built the way a task's own override is; null when nothing was picked.
export function offerOverride(run) {
  const type = run.agent?.adapterType;
  if (!type) return null;
  const config = run.agent.adapterConfig;
  let override = null;
  if (run.chosenModel) override = overrideWithModel(type, override, config, run.chosenModel);
  if (run.chosenReasoning) override = overrideWithReasoning(type, override, config, run.chosenReasoning);
  return override;
}

// The model and level picked for this task, as words for the outcome line.
export function pickedWords(run) {
  const words = [];
  if (run.chosenModel) words.push(truncate(modelLabel(run.models, run.chosenModel), NAME_MAX));
  if (run.chosenReasoning) words.push(reasoningLabel(run.chosenReasoning));
  return words;
}
