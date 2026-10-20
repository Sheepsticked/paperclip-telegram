import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXIT_CONFIG = 78;

export const DEFAULT_ROUTINE_RUN_ERROR_CODES = [
  'cancelled',
  'agent_paused',
  'server_shutdown_interrupted',
  'issue_reassigned',
  'lock_released_on_reassignment',
  'queued_comment_discarded',
  'agent_not_invokable',
  'issue_dependencies_blocked',
  'issue_not_in_progress',
  'issue_execution_lock_changed',
  'queued_run_claim_rejected',
  'workspace_busy',
  'ai_connection_busy',
  'budget_paused',
  'paused',
];

export class ConfigError extends Error {
  constructor(problems) {
    const list = Array.isArray(problems) ? problems : [problems];
    super(list.length === 1 ? list[0] : `configuration problems:\n  - ${list.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = list;
  }
}

export function defaultConfigPath(env = process.env) {
  return env.PAPERCLIP_TELEGRAM_CONFIG || path.join(os.homedir(), '.config', 'paperclip-telegram', 'config.json');
}

export function defaultStatePath(env = process.env) {
  const dir = env.STATE_DIRECTORY
    ? env.STATE_DIRECTORY.split(':')[0]
    : path.join(os.homedir(), '.local', 'state', 'paperclip-telegram');
  return path.join(dir, 'state.json');
}

function expandHome(file) {
  if (file === '~') return os.homedir();
  if (file.startsWith('~/')) return path.join(os.homedir(), file.slice(2));
  return file;
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

export const VOICE_DEFAULTS = { model: 'small', language: null, beamSize: 1, threads: 4, maxSeconds: 300 };

// Checks the optional `voice` block and returns it with its defaults; the problems are pushed to `problems`.
function parseVoice(raw, problems) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('voice must be an object when set');
    return null;
  }
  const before = problems.length;
  const need = (ok, message) => {
    if (!ok) problems.push(message);
  };
  need(nonEmpty(raw.python), 'voice.python must be a non-empty path');
  need(nonEmpty(raw.modelsDir), 'voice.modelsDir must be a non-empty path');
  need(raw.model === undefined || nonEmpty(raw.model), 'voice.model must be a non-empty string when set');
  need(raw.language === undefined || raw.language === null || nonEmpty(raw.language), 'voice.language must be a language code or null');
  need(raw.beamSize === undefined || isPositiveInteger(raw.beamSize), 'voice.beamSize must be a positive integer when set');
  need(raw.threads === undefined || isPositiveInteger(raw.threads), 'voice.threads must be a positive integer when set');
  need(
    raw.maxSeconds === undefined || (typeof raw.maxSeconds === 'number' && Number.isFinite(raw.maxSeconds) && raw.maxSeconds > 0),
    'voice.maxSeconds must be a positive number of seconds when set',
  );
  if (problems.length > before) return null;
  return {
    python: expandHome(raw.python.trim()),
    modelsDir: expandHome(raw.modelsDir.trim()),
    model: raw.model?.trim() ?? VOICE_DEFAULTS.model,
    language: raw.language?.trim() ?? VOICE_DEFAULTS.language,
    beamSize: raw.beamSize ?? VOICE_DEFAULTS.beamSize,
    threads: raw.threads ?? VOICE_DEFAULTS.threads,
    maxSeconds: raw.maxSeconds ?? VOICE_DEFAULTS.maxSeconds,
  };
}

// Returns { config, problems }; the config is only usable when problems is empty.
export function parseConfig(raw) {
  const problems = [];
  const need = (ok, message) => {
    if (!ok) problems.push(message);
    return ok;
  };

  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'config must be a JSON object');
  const c = raw && typeof raw === 'object' ? raw : {};

  need(isHttpUrl(c.paperclipUrl), 'paperclipUrl must be an http(s) URL');
  need(isHttpUrl(c.uiBaseUrl), 'uiBaseUrl must be an http(s) URL');
  need(nonEmpty(c.companyId), 'companyId must be a non-empty string');
  need(nonEmpty(c.leadAgentId), 'leadAgentId must be a non-empty string');
  need(
    c.newTaskProjectId === undefined || c.newTaskProjectId === null || nonEmpty(c.newTaskProjectId),
    'newTaskProjectId must be a string or null',
  );
  need(Number.isSafeInteger(c.telegramUserId) && c.telegramUserId > 0, 'telegramUserId must be a positive integer');
  need(
    c.telegramChatId === undefined || (Number.isSafeInteger(c.telegramChatId) && c.telegramChatId !== 0),
    'telegramChatId must be a non-zero integer when set',
  );
  need(nonEmpty(c.telegramTokenFile), 'telegramTokenFile must be a non-empty path');
  need(nonEmpty(c.paperclipTokenFile), 'paperclipTokenFile must be a non-empty path');
  need(
    c.telegramApiUrl === undefined || isHttpUrl(c.telegramApiUrl),
    'telegramApiUrl must be an http(s) URL when set',
  );
  need(
    c.pollSeconds === undefined || (typeof c.pollSeconds === 'number' && Number.isFinite(c.pollSeconds) && c.pollSeconds > 0),
    'pollSeconds must be a positive number when set',
  );
  need(c.topics === undefined || c.topics === 'auto' || c.topics === 'off', 'topics must be "auto" or "off" when set');
  need(c.richMessages === undefined || c.richMessages === 'auto' || c.richMessages === 'off', 'richMessages must be "auto" or "off" when set');
  need(
    c.closedTopicDays === undefined || (typeof c.closedTopicDays === 'number' && Number.isFinite(c.closedTopicDays) && c.closedTopicDays >= 0),
    'closedTopicDays must be a number of days (0 or more) when set',
  );
  need(
    c.routineRunErrorCodes === undefined ||
      (Array.isArray(c.routineRunErrorCodes) && c.routineRunErrorCodes.every((code) => typeof code === 'string')),
    'routineRunErrorCodes must be an array of strings when set',
  );

  const voice = parseVoice(c.voice, problems);

  if (problems.length > 0) return { config: null, problems };

  const trimSlash = (url) => url.replace(/\/+$/, '');
  return {
    problems,
    config: {
      paperclipUrl: trimSlash(c.paperclipUrl),
      uiBaseUrl: trimSlash(c.uiBaseUrl),
      companyId: c.companyId.trim(),
      leadAgentId: c.leadAgentId.trim(),
      newTaskProjectId: c.newTaskProjectId ?? null,
      telegramUserId: c.telegramUserId,
      telegramChatId: c.telegramChatId ?? c.telegramUserId,
      telegramTokenFile: expandHome(c.telegramTokenFile),
      paperclipTokenFile: expandHome(c.paperclipTokenFile),
      telegramApiUrl: trimSlash(c.telegramApiUrl ?? 'https://api.telegram.org'),
      pollSeconds: c.pollSeconds ?? 15,
      topics: c.topics ?? 'auto',
      richMessages: c.richMessages ?? 'auto',
      closedTopicDays: c.closedTopicDays ?? 7,
      routineRunErrorCodes: c.routineRunErrorCodes ?? DEFAULT_ROUTINE_RUN_ERROR_CODES,
      voice,
    },
  };
}

// Reads a token file; the problem text names the file but never quotes its content.
export function readTokenFile(file, label) {
  let fd;
  try {
    // O_NONBLOCK keeps a FIFO from blocking the open; the type is checked on the descriptor below.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'token file missing' : `token file cannot be read (${err.code ?? 'error'})`;
    return { problem: `${label}: ${why}: ${file}` };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { problem: `${label}: token file is not a regular file: ${file}` };
    if (stat.mode & 0o077) {
      return { problem: `${label}: token file must not be accessible by group or others (run chmod 600): ${file}` };
    }
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (!token) return { problem: `${label}: token file is empty: ${file}` };
    return { token };
  } finally {
    fs.closeSync(fd);
  }
}

// Loads the config and both token files, reporting every problem at once.
export function loadSettings(env = process.env) {
  const file = defaultConfigPath(env);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'config file missing' : err instanceof SyntaxError ? 'config file is not valid JSON' : 'config file cannot be read';
    throw new ConfigError(`${why}: ${file}`);
  }

  const { config, problems } = parseConfig(raw);
  const all = problems.map((problem) => `${file}: ${problem}`);

  // Token files are checked even when other keys are wrong, so one run lists everything to fix.
  const tokens = {};
  for (const [key, name] of [['telegramTokenFile', 'telegram'], ['paperclipTokenFile', 'paperclip']]) {
    if (!nonEmpty(raw?.[key])) continue;
    const result = readTokenFile(expandHome(raw[key]), key);
    if (result.problem) all.push(result.problem);
    else tokens[name] = result.token;
  }

  if (all.length > 0) throw new ConfigError(all);
  return { config, tokens };
}
