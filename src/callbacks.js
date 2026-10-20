import { handleCallback } from './actions.js';
import { handleAgentCallback } from './agents.js';
import { deliverText } from './commands.js';
import { handleOfferCallback } from './create.js';
import { handleInboxCallback } from './inbox.js';
import { handleListCallback } from './lists.js';
import { handleSettingsCallback } from './settings.js';
import { handleTaskCallback } from './tasks.js';
import { handleVoiceCallback } from './voice.js';

// Card callbacks start with a lowercase key; the other buttons start with one uppercase letter and a colon.
const HANDLERS = {
  T: handleTaskCallback,
  L: handleListCallback,
  S: handleSettingsCallback,
  O: handleOfferCallback,
  I: handleInboxCallback,
  G: handleAgentCallback,
  V: (bot, cq) => handleVoiceCallback(bot, cq, deliverText),
};

export function routeCallback(bot, cq) {
  const namespace = /^([A-Z]):/.exec(String(cq.data ?? ''))?.[1];
  if (!namespace) return handleCallback(bot, cq);
  const handler = HANDLERS[namespace];
  return handler ? handler(bot, cq) : bot.answer(cq.id, 'Unknown action');
}
