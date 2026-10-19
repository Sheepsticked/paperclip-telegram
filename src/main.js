import { Bot } from './bot.js';
import { ConfigError, EXIT_CONFIG, defaultStatePath, loadSettings } from './config.js';
import { createLogger } from './log.js';
import { State } from './state.js';

// Starts the bot and resolves with the process exit code.
export async function main(env = process.env) {
  let settings;
  try {
    settings = loadSettings(env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`paperclip-telegram: ${err.message}\n`);
    return EXIT_CONFIG;
  }

  const { config, tokens } = settings;
  const log = createLogger({ secrets: [tokens.telegram, tokens.paperclip] });
  const state = State.load(defaultStatePath(env), log);
  const bot = new Bot({ config, tokens, state, log });

  const stop = () => {
    log.info('stopping');
    bot.stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  log.info('started', { pollSeconds: config.pollSeconds });
  try {
    await bot.run();
  } catch (err) {
    log.error('fatal error', { error: err.message });
    return 1;
  }
  log.info('stopped');
  return 0;
}
