#!/usr/bin/env node
import { main } from '../src/main.js';

// Unexpected errors are reported by message only, so no stack or request detail reaches the logs.
function fatal(err) {
  process.stderr.write(`paperclip-telegram: unexpected error: ${err?.message ?? 'unknown'}\n`);
  process.exit(1);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

main().then((code) => process.exit(code), fatal);
