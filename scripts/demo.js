// Runs the bot against a pretend Paperclip full of sample tasks, so the bot can be tried or photographed with only a
// Telegram bot token and a group. Usage: node scripts/demo.js --config <file> [--state <dir>]
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT_CONFIG, parseConfig } from '../src/config.js';
import { main as runBot } from '../src/main.js';
import { startFakePaperclip } from '../test/fakes/paperclip.js';

const EXIT_USAGE = 64;
const UI_BASE_URL = 'https://paperclip.example.com';
const POLL_SECONDS = 2;
// The only keys a demo config may hold; the demo fills in the rest, so a real Paperclip can never be reached.
const ALLOWED_KEYS = ['telegramTokenFile', 'telegramUserId', 'telegramChatId', 'voice', 'telegramApiUrl'];

const USAGE = `Usage: node scripts/demo.js --config <file> [--state <dir>]

Runs the bot against sample tasks instead of a real Paperclip. The config holds only
${ALLOWED_KEYS.join(', ')} (see scripts/demo.example.json).
--state keeps the bot's state in <dir> (use an empty folder); by default it lives in a temporary folder that is removed on exit.`;

// Milliseconds after the board is out until each story step, and after an answer or a confirmation until what follows.
const STORY = { question: 3000, confirm: 8000, done: 13_000, failedRun: 18_000 };
const AFTER_ANSWER = { leadComment: 5000, devProgress: 20_000 };
const AFTER_CONFIRM = { done: 10_000 };

const MODELS = {
  claude_local: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  ],
  codex_local: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  ],
  pi_local: [
    { id: 'openai-codex/gpt-6.1-sol', label: 'openai-codex/gpt-6.1-sol' },
    { id: 'openai-codex/gpt-5.4', label: 'openai-codex/gpt-5.4' },
    { id: 'anthropic/claude-sonnet-5-5', label: 'anthropic/claude-sonnet-5-5' },
    { id: 'anthropic/claude-haiku-5-5', label: 'anthropic/claude-haiku-5-5' },
  ],
};

// Lead and Dev are the fake's own two agents; Designer is added. `lastRun` is minutes since its last finished run.
const AGENTS = [
  { name: 'Lead', role: 'ceo', title: 'Team lead', adapterType: 'claude_local', adapterConfig: { model: 'claude-opus-5-5', effort: 'high' }, lastRun: 12 },
  { name: 'Dev', role: 'engineer', title: 'Software engineer', adapterType: 'codex_local', adapterConfig: { model: 'gpt-6.1-sol', modelReasoningEffort: 'high' }, lastRun: 35 },
  { name: 'Designer', role: 'designer', title: 'Product designer', adapterType: 'pi_local', adapterConfig: { model: 'anthropic/claude-sonnet-5-5', thinking: 'medium' }, lastRun: 70 },
];

const PROJECTS = ['Website', 'Mobile app'];

const RELEASE_NOTES = `## What is new in 2.0

- **Dark mode.** Pick a light or dark theme in the settings.
- **Faster search.** Results show up as you type.
- **Login fix.** Signing in no longer loops back to the login page.

## Upgrade notes

Nothing to do. The update installs itself.`;

// Oldest first, so the finished ones carry the lowest numbers. `age` is minutes since the last update.
const TASKS = [
  {
    key: 'icon', title: 'Create the app icon', status: 'done', agent: 'Designer', project: 'Mobile app', age: 8640,
    description: 'Design a simple square icon for the mobile app. It has to stay readable at small sizes.',
    comments: [['Designer', 'The icon is done. It uses the brand colours and works on light and dark backgrounds.']],
  },
  {
    key: 'pricing', title: 'Update the pricing page', status: 'done', agent: 'Dev', project: 'Website', age: 4320,
    description: 'Replace the old plan names and prices on the pricing page with the new ones.',
    comments: [['Dev', 'The new plans and prices are live on the pricing page.']],
  },
  {
    key: 'login', title: 'Fix the login redirect loop', status: 'in_progress', agent: 'Dev', project: 'Website', age: 180, priority: 'high',
    description: 'After signing in, some people are sent back to the login page again and again. Find the cause and fix it.',
    comments: [['Dev', 'I can reproduce it when the session cookie is set after the redirect. Working on a fix.']],
  },
  {
    key: 'onboarding', title: 'Design the onboarding screens', status: 'in_progress', agent: 'Designer', project: 'Mobile app', age: 120,
    description: 'Sketch the first three screens a new user sees: welcome, sign-up and a short tour.',
    comments: [['Designer', 'Two of the three screens are drafted. I am working on the tour.']],
  },
  {
    key: 'release', title: 'Prepare the 2.0 release', status: 'in_progress', agent: 'Dev', project: 'Website', age: 50,
    description: 'Get version 2.0 ready: freeze the code, run every check and deploy it to staging.',
  },
  {
    key: 'notes', title: 'Write the release notes for 2.0', status: 'in_review', agent: 'Lead', project: 'Website', age: 25,
    description: 'Summarise what is new in 2.0 in a short, friendly note for the changelog.',
    comments: [['Lead', 'The draft is ready for review. It covers the new theme, faster search and the login fix.']],
    draft: RELEASE_NOTES,
  },
  {
    key: 'darkMode', title: 'Add dark mode to the settings page', status: 'todo', agent: 'Dev', project: 'Website', age: 90,
    description: 'Let people switch between a light and a dark theme from the settings page. The choice should be remembered between visits.',
  },
  {
    key: 'store', title: 'Publish the app to the store', status: 'blocked', agent: 'Lead', project: 'Mobile app', age: 1440,
    description: 'Submit the first version of the mobile app to the app store.',
    comments: [['Lead', 'Blocked until the store account is verified. I will pick this up as soon as it is.']],
  },
  {
    key: 'push', title: 'Add push notifications to the app', status: 'todo', agent: 'Dev', project: 'Mobile app', age: 300,
    description: 'Send a notification when a task changes, and let people turn it off in the settings.',
  },
];

const THEME_OPTIONS = ['Follow the system', 'Light', 'Dark'].map((label, i) => ({ id: `theme-${i + 1}`, label }));
const QUESTION = 'Which theme should be the default?';
const QUESTION_PAYLOAD = {
  version: 1,
  questionSet: { schema: 'paperclip.question_set.v1', questions: [{ id: 'theme', prompt: QUESTION, answerMode: 'single_select', required: true, options: THEME_OPTIONS }] },
  questions: [{ id: 'theme', prompt: QUESTION, selectionMode: 'single', required: true, options: THEME_OPTIONS }],
};
const CONFIRM_PAYLOAD = {
  version: 1,
  prompt: 'Deploy 2.0 to staging?',
  acceptLabel: 'Deploy',
  rejectLabel: 'Not yet',
  detailsMarkdown: 'The 2.0 build passed every check.\n\n- 142 tests passed\n- No open blockers',
};
const DONE_COMMENT = `Fixed. The login page now remembers where the person was going, so a signed-in user is no longer sent back to it.

**What changed**

- The return address is stored before the sign-in redirect
- A return address that points to the login page is ignored
- Added a test that covers the loop

| Check | Result |
| --- | --- |
| Unit tests | 42 passed |
| Sign-in flow | Works in all 3 browsers |`;
const DEV_PROGRESS = 'The dark theme works on the settings page now. Next I will check the colours on the other pages.';
const RUN_ERROR = { errorCode: 'adapter_failed', error: 'The agent process exited with code 1' };

const MINUTE = 60_000;
const say = (message) => process.stdout.write(`demo: ${message}\n`);
const minutesAgo = (minutes) => new Date(Date.now() - minutes * MINUTE).toISOString();

// Parses the command line; a problem is reported by the caller.
function readCommandLine(argv) {
  try {
    const { values } = parseArgs({ args: argv, options: { config: { type: 'string' }, state: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true });
    return values;
  } catch (err) {
    return { problem: err.message };
  }
}

// The input config from its file, or the problems that make it unusable; only the allowed keys are ever returned.
function readInput(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'config file missing' : err instanceof SyntaxError ? 'config file is not valid JSON' : 'config file cannot be read';
    return { problems: [`${why}: ${file}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problems: [`${file}: the config must be a JSON object`] };

  const problems = Object.keys(raw)
    .filter((key) => !ALLOWED_KEYS.includes(key))
    .map((key) => `${file}: "${key}" is not allowed in a demo config (allowed: ${ALLOWED_KEYS.join(', ')})`);
  if (raw.telegramChatId === undefined) problems.push(`${file}: telegramChatId must be set to the group the demo writes to`);

  const given = Object.fromEntries(ALLOWED_KEYS.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]));
  // Stand-ins for the keys the demo fills in, so that only the given ones can fail.
  const stand = { paperclipUrl: 'http://127.0.0.1', uiBaseUrl: UI_BASE_URL, companyId: 'demo', leadAgentId: 'demo', paperclipTokenFile: 'demo' };
  problems.push(...parseConfig({ ...stand, ...given }).problems.map((problem) => `${file}: ${problem}`));
  return { input: given, problems };
}

// Fills the pretend Paperclip: agents with models, projects, tasks with comments, and a document.
function seed(pc) {
  Object.assign(pc.models, MODELS);
  const agents = {};
  for (const { name, lastRun, ...fields } of AGENTS) {
    const agent = Object.assign(pc.agents.find((existing) => existing.name === name) ?? pc.addAgent({ name }), { name, ...fields });
    const run = pc.addRun({ agentId: agent.id, status: 'succeeded' });
    Object.assign(run, { startedAt: minutesAgo(lastRun + 5), finishedAt: minutesAgo(lastRun) });
    agents[name] = agent;
  }
  const projects = Object.fromEntries(PROJECTS.map((name) => [name, pc.addProject({ name })]));

  const tasks = {};
  for (const spec of TASKS) {
    const issue = pc.addIssue({
      title: spec.title,
      description: spec.description,
      status: spec.status,
      assigneeAgentId: agents[spec.agent].id,
      projectId: projects[spec.project].id,
      createdAt: minutesAgo(spec.age + 1440),
      updatedAt: minutesAgo(spec.age),
    });
    for (const [name, body] of spec.comments ?? []) pc.addComment(issue.id, { body, authorAgentId: agents[name].id });
    if (spec.draft) pc.addDocument(issue.id, { key: 'draft', title: 'Release notes', body: spec.draft });
    // A comment counts as an update, so the age is set last.
    Object.assign(issue, { updatedAt: minutesAgo(spec.age), priority: spec.priority ?? 'medium' });
    tasks[spec.key] = issue;
  }
  return { agents, tasks };
}

// Plays the story: cards, a finished task and a failed run at a steady pace, and the agents' reactions to the answers.
function playStory(pc, { agents, tasks }, later) {
  const reactions = new Map();
  pc.onInteractionSettled((interaction) => reactions.get(interaction.id)?.(interaction));

  later(STORY.question, () => {
    const card = pc.addInteraction(tasks.darkMode.id, { kind: 'ask_user_questions', payload: QUESTION_PAYLOAD, createdByAgentId: agents.Lead.id });
    reactions.set(card.id, (settled) => {
      const picked = settled.result?.answers?.[0]?.optionIds?.[0];
      const label = THEME_OPTIONS.find((option) => option.id === picked)?.label;
      later(AFTER_ANSWER.leadComment, () => {
        pc.addComment(tasks.darkMode.id, { body: label ? `Going with "${label}" as the default theme.` : 'Thanks, I have the answer.', authorAgentId: agents.Lead.id });
        pc.setStatus(tasks.darkMode.id, 'in_progress');
        say(`${tasks.darkMode.identifier}: Lead answered and started the task`);
      });
      later(AFTER_ANSWER.devProgress, () => {
        pc.addComment(tasks.darkMode.id, { body: DEV_PROGRESS, authorAgentId: agents.Dev.id });
        say(`${tasks.darkMode.identifier}: Dev posted a progress comment`);
      });
    });
    say(`question card on ${tasks.darkMode.identifier}`);
  });

  later(STORY.confirm, () => {
    const card = pc.addInteraction(tasks.release.id, { kind: 'request_confirmation', payload: CONFIRM_PAYLOAD, createdByAgentId: agents.Dev.id });
    reactions.set(card.id, (settled) => {
      if (settled.status !== 'accepted') return;
      later(AFTER_CONFIRM.done, () => {
        pc.setStatus(tasks.release.id, 'done');
        say(`${tasks.release.identifier}: done after the confirmation`);
      });
    });
    say(`confirm card on ${tasks.release.identifier}`);
  });

  later(STORY.done, () => {
    pc.addComment(tasks.login.id, { body: DONE_COMMENT, authorAgentId: agents.Dev.id });
    pc.setStatus(tasks.login.id, 'done');
    say(`${tasks.login.identifier} is done`);
  });

  later(STORY.failedRun, () => {
    const run = { agentId: agents.Designer.id, issueId: tasks.onboarding.id, ...RUN_ERROR };
    pc.addRun({ ...run, status: 'failed' });
    pc.addFailedRun(run);
    say('failed run for Designer');
  });
}

async function main() {
  const options = readCommandLine(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const usage = options.problem ?? (options.config ? null : 'missing --config <file>');
  if (usage) {
    process.stderr.write(`demo: ${usage}\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  const stateDir = options.state ? path.resolve(options.state) : null;
  const { input, problems } = readInput(options.config);
  // The bot reads its state folder from a colon-separated list.
  if (stateDir?.includes(':')) problems.push('--state must not contain a ":"');
  if (problems.length > 0) {
    process.stderr.write(`${problems.map((problem) => `demo: ${problem}`).join('\n')}\n`);
    return EXIT_CONFIG;
  }

  const timers = new Set();
  let stopping = false;
  let signals = 0;
  let pc = null;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-telegram-demo-'));
  const clearTimers = () => {
    stopping = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const removeWorkDir = () => fs.rmSync(workDir, { recursive: true, force: true });
  const forceExit = (code) => {
    clearTimers();
    removeWorkDir();
    process.exit(code);
  };

  // The bot stops itself on the first signal (see src/main.js); a second one ends the demo at once.
  const onSignal = () => {
    signals += 1;
    clearTimers();
    if (signals > 1) forceExit(1);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const fatal = (err) => {
    process.stderr.write(`demo: unexpected error: ${err?.message ?? 'unknown'}\n`);
    forceExit(1);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);

  // Runs a story step after `ms`, unless the demo is stopping; a failing step is reported and the story goes on.
  const later = (ms, step) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopping) return;
      try {
        step();
      } catch (err) {
        process.stderr.write(`demo: a story step failed: ${err.message}\n`);
      }
    }, ms);
    timers.add(timer);
  };

  try {
    const token = `pcp_board_${randomBytes(16).toString('hex')}`;
    pc = await startFakePaperclip({ token, prefix: 'ACME' });
    const cast = seed(pc);

    const paperclipTokenFile = path.join(workDir, 'paperclip-token');
    const configFile = path.join(workDir, 'config.json');
    fs.writeFileSync(paperclipTokenFile, `${token}\n`, { mode: 0o600 });
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ...input,
        paperclipUrl: pc.url,
        uiBaseUrl: UI_BASE_URL,
        companyId: pc.companyId,
        leadAgentId: cast.agents.Lead.id,
        paperclipTokenFile,
        pollSeconds: POLL_SECONDS,
      }),
      { mode: 0o600 },
    );
    const stateFolder = stateDir ?? path.join(workDir, 'state');
    fs.mkdirSync(stateFolder, { recursive: true, mode: 0o700 });

    if (stopping) return 0;
    say(`sample Paperclip at ${pc.url}; stop with Ctrl-C`);
    let botStopped = false;
    const bot = runBot({ ...process.env, PAPERCLIP_TELEGRAM_CONFIG: configFile, STATE_DIRECTORY: stateFolder });
    const markStopped = () => {
      botStopped = true;
    };
    bot.then(markStopped, markStopped);
    // The story starts once the bot has finished its first poll, so everything in it counts as new.
    const firstPollDone = () => botStopped || stopping || pc.requestsTo('GET', /\/attention$/).length >= 2;
    while (!firstPollDone()) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!botStopped && !stopping) {
      say('the board is out; the story starts');
      playStory(pc, cast, later);
    }
    return await bot;
  } finally {
    clearTimers();
    await pc?.close();
    removeWorkDir();
  }
}

main().then((code) => process.exit(code), (err) => {
  process.stderr.write(`demo: unexpected error: ${err?.message ?? 'unknown'}\n`);
  process.exit(1);
});
