import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TELEGRAM_TOKEN, waitFor, writeTokenFile } from './helpers.js';
import { startFakeTelegram } from './fakes/telegram.js';

const DEMO = fileURLToPath(new URL('../scripts/demo.js', import.meta.url));
const FAKE_TRANSCRIBER = fileURLToPath(new URL('./fakes/transcriber.mjs', import.meta.url));
const GROUP_ID = -1001234567890;
const EXIT_USAGE = 64;
const EXIT_CONFIG = 78;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-telegram-demo-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// An empty folder the demo gets as its temp folder, so what it leaves behind can be listed.
function tmpFor(dir) {
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  return tmp;
}

const demoEnv = (tmp) => ({ PATH: process.env.PATH, TMPDIR: tmp });

function writeInput(dir, content) {
  const file = path.join(dir, 'demo.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

// The demo with a config that stops it before anything starts.
function refused(t, input, args = []) {
  const dir = tempDir(t);
  const tmp = tmpFor(dir);
  const file = writeInput(dir, input);
  const result = spawnSync(process.execPath, [DEMO, '--config', file, ...args], { env: demoEnv(tmp), encoding: 'utf8', timeout: 10_000 });
  assert.deepEqual(fs.readdirSync(tmp), [], 'nothing is left in the temp folder');
  assert.equal(result.stdout, '', 'nothing was started');
  return { ...result, file };
}

const validInput = { telegramTokenFile: '/nowhere/telegram-token', telegramUserId: 1001, telegramChatId: GROUP_ID };

// The demo against a fake Telegram group with topics. `input` and `args` may be functions of the test's folder.
async function startDemo(t, { input = {}, args = [] } = {}) {
  const dir = tempDir(t);
  const tmp = tmpFor(dir);
  const tg = await startFakeTelegram({ token: TELEGRAM_TOKEN, forum: true, chatId: GROUP_ID });
  const telegramTokenFile = writeTokenFile(path.join(dir, 'telegram-token'), TELEGRAM_TOKEN);
  const extra = typeof input === 'function' ? input(dir) : input;
  const config = writeInput(dir, { telegramTokenFile, telegramUserId: tg.userId, telegramChatId: tg.chatId, telegramApiUrl: tg.url, ...extra });
  const child = spawn(process.execPath, [DEMO, '--config', config, ...(typeof args === 'function' ? args(dir) : args)], {
    env: demoEnv(tmp),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { out: '', err: '' };
  child.stdout.on('data', (chunk) => (output.out += chunk));
  child.stderr.on('data', (chunk) => (output.err += chunk));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    child.kill('SIGKILL');
    await exited;
    await tg.close();
  });
  return { dir, tmp, tg, child, output, exited };
}

const labels = (tg, message) => tg.buttons(message.message_id).map((b) => b.text);
const theBoard = (tg) => tg.sent().find((m) => m.thread === null && m.pinned && m.text.includes('Working'));

describe('the demo', { concurrency: true }, () => {
  test('refuses every key it does not allow, so a real Paperclip cannot be passed in', (t) => {
    for (const key of ['paperclipUrl', 'paperclipTokenFile', 'uiBaseUrl', 'companyId', 'leadAgentId', 'pollSeconds', 'topics']) {
      const result = refused(t, { ...validInput, [key]: 'https://paperclip.example.org' });
      assert.equal(result.status, EXIT_CONFIG, key);
      assert.ok(result.stderr.includes(`"${key}" is not allowed`), `${key}: ${result.stderr}`);
      assert.ok(result.stderr.includes(result.file), 'the message names the config file');
    }
  });

  test('lists every problem of a config at once', (t) => {
    const result = refused(t, { telegramUserId: 'abc', paperclipUrl: 'https://paperclip.example.org', voice: 'small' });
    assert.equal(result.status, EXIT_CONFIG);
    for (const part of ['"paperclipUrl" is not allowed', 'telegramChatId must be set', 'telegramUserId must be a positive integer', 'telegramTokenFile must be a non-empty path', 'voice must be an object']) {
      assert.ok(result.stderr.includes(part), `${part}: ${result.stderr}`);
    }
  });

  test('refuses a config file that is missing, not JSON or not an object', (t) => {
    const missing = refused(t, '{}');
    fs.rmSync(missing.file);
    const again = spawnSync(process.execPath, [DEMO, '--config', missing.file], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(again.status, EXIT_CONFIG);
    assert.match(again.stderr, /config file missing/);

    const broken = refused(t, '{ not json');
    assert.equal(broken.status, EXIT_CONFIG);
    assert.match(broken.stderr, /not valid JSON/);

    const list = refused(t, '[]');
    assert.equal(list.status, EXIT_CONFIG);
    assert.match(list.stderr, /must be a JSON object/);
  });

  test('refuses a bad command line and prints the usage', () => {
    const none = spawnSync(process.execPath, [DEMO], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(none.status, EXIT_USAGE);
    assert.match(none.stderr, /missing --config/);
    assert.match(none.stderr, /Usage: node scripts\/demo\.js/);

    const unknown = spawnSync(process.execPath, [DEMO, '--config', 'x.json', '--paperclip-url', 'http://127.0.0.1'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(unknown.status, EXIT_USAGE);

    const help = spawnSync(process.execPath, [DEMO, '--help'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: node scripts\/demo\.js/);
  });

  test('plays the story in order, and each answer brings the agents back', { timeout: 90_000 }, async (t) => {
    const { tg, output } = await startDemo(t);
    const wait = (needle, label, after = 0) =>
      waitFor(() => tg.sent().find((m) => m.message_id > after && m.text.includes(needle)), { timeout: 30_000, label });

    const board = await waitFor(() => theBoard(tg), { timeout: 20_000, label: 'the pinned board in General' });
    const question = await wait('Which theme should be the default?', 'the question card');
    assert.deepEqual(labels(tg, question), ['Follow the system', 'Light', 'Dark']);
    await waitFor(() => /Needs you/.test(board.text), { timeout: 20_000, label: 'the card on the board' });
    assert.ok(board.text.includes('ACME-7'));
    tg.push(tg.tapButton(question.message_id, 'Dark'));

    const confirm = await wait('Deploy 2.0 to staging?', 'the confirm card');
    assert.deepEqual(labels(tg, confirm), ['Deploy', 'Not yet']);
    tg.push(tg.tapButton(confirm.message_id, 'Deploy'));

    const done = await wait('Fixed. The login page', 'the Done message for the login task');
    assert.match(done.text, /Done/);
    assert.ok(done.text.includes('| Unit tests | 42 passed |'), 'the table of the comment is quoted');
    assert.ok(done.text.includes('- Added a test that covers the loop'), 'and its list');
    const failed = await wait('Run failed', 'the failed run alert');
    assert.ok(failed.text.includes('Designer'));

    const ids = [board, question, confirm, done, failed].map((m) => m.message_id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'the board, the cards, the Done message and the alert come in that order');

    const inTopic = (message, needle) => waitFor(() => tg.inTopic(message.thread).find((m) => m.text.includes(needle)), { timeout: 30_000, label: needle });
    const lead = await inTopic(question, 'Going with "Dark"');
    assert.ok(lead.text.includes('Lead'));
    const releaseDone = await waitFor(
      () => tg.inTopic(confirm.thread).find((m) => m.message_id > confirm.message_id && /Done/.test(m.text)),
      { timeout: 30_000, label: 'the Done message after the confirmation' },
    );
    assert.ok(releaseDone);
    const dev = await inTopic(question, 'The dark theme works on the settings page');
    assert.ok(dev.text.includes('Dev'));

    assert.deepEqual(tg.emojiFindings(), [], 'the sample text has no emoji');
    assert.equal(output.err, '');
  });

  test('the commands, pickers and new tasks work on the sample data', { timeout: 60_000 }, async (t) => {
    const { tg } = await startDemo(t);
    await waitFor(() => theBoard(tg), { timeout: 20_000, label: 'the board' });
    const reply = (needle) => waitFor(() => tg.sent().findLast((m) => m.text.includes(needle)), { timeout: 10_000, label: needle });
    const until = (check, label) => waitFor(check, { timeout: 10_000, label });

    tg.push(tg.message('/tasks'));
    const tasks = await reply('Open tasks');
    for (const title of ['Add dark mode to the settings page', 'Write the release notes for 2.0', 'Publish the app to the store', 'Add push notifications to the app']) {
      assert.ok(labels(tg, tasks).some((label) => label.includes(title)), title);
    }
    assert.ok(!labels(tg, tasks).some((label) => label.includes('Create the app icon')), 'finished tasks are not open');

    tg.push(tg.message('/agents'));
    const agents = await reply('Agents');
    assert.deepEqual(['Designer', 'Dev', 'Lead'], labels(tg, agents).map((label) => label.split(' · ')[0]).slice(0, 3));
    tg.push(tg.tapButton(agents.message_id, 'Dev'));
    const dev = await reply('Software engineer');
    assert.ok(labels(tg, dev).includes('Model · GPT-6.1 Sol'));
    assert.ok(labels(tg, dev).includes('Reasoning · High'));
    tg.push(tg.tapButton(dev.message_id, 'Model ·'));
    await until(() => labels(tg, dev).includes('GPT-6 Luna'), 'the model picker');
    tg.push(tg.tapButton(dev.message_id, 'GPT-6 Luna'));
    await until(() => labels(tg, dev).includes('Model · GPT-6 Luna'), 'the picked model');

    tg.push(tg.message('/task ACME-6'));
    const view = await reply('The draft is ready for review');
    tg.push(tg.tapButton(view.message_id, 'More'));
    await until(() => labels(tg, view).includes('Docs'), 'the More row');
    for (const label of ['Assign', 'Project', 'Model', 'Reasoning']) assert.ok(labels(tg, view).includes(label), label);

    tg.push(tg.message('Add a footer with social links to the website'));
    const offer = await reply('Create a task from this?');
    assert.ok(labels(tg, offer).includes('For Lead'));
    tg.push(tg.tapButton(offer.message_id, 'Model ·'));
    await until(() => labels(tg, offer).includes('Claude Sonnet 5.5'), 'the offer model picker');
    tg.push(tg.tapButton(offer.message_id, 'Claude Sonnet 5.5'));
    await until(() => labels(tg, offer).includes('Model · Claude Sonnet 5.5'), 'the picked model');
    tg.push(tg.tapButton(offer.message_id, 'For Lead'));
    await until(() => labels(tg, offer).includes('Website'), 'the project question');
    tg.push(tg.tapButton(offer.message_id, 'Website'));
    // The settled offer also names ACME-10 and comes earlier, so wait for the pinned view in the task's topic.
    const created = await until(() => tg.sent().find((m) => m.pinned && m.text.includes('ACME-10')), 'the new task');
    assert.ok(created.text.includes('To do · Lead · Website'));
    assert.ok(created.text.includes('Model: Claude Sonnet 5.5'), 'the task carries the model picked on the offer');
  });

  test('a voice block in the config reaches the bot: a voice note becomes a task offer', { timeout: 60_000 }, async (t) => {
    const stub = (dir) => {
      const python = path.join(dir, 'python');
      fs.writeFileSync(python, `#!/bin/sh\nshift\nexec "${process.execPath}" "${FAKE_TRANSCRIBER}" "$@"\n`, { mode: 0o755 });
      return { voice: { python, modelsDir: path.join(dir, 'models') } };
    };
    const { tg } = await startDemo(t, { input: stub });
    await waitFor(() => theBoard(tg), { timeout: 20_000, label: 'the board' });
    const note = tg.addFile({ name: 'voice.oga', kind: 'voice', data: JSON.stringify({ mode: 'text', text: 'Add a help page to the website' }) });
    tg.push(tg.voiceUpdate(note));
    const heard = await waitFor(() => tg.sent().find((m) => m.text.includes('Add a help page to the website')), { timeout: 20_000, label: 'the transcript' });
    await waitFor(() => labels(tg, heard).includes('For Lead'), { timeout: 10_000, label: 'the task offer' });
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`${signal} stops the bot and the sample Paperclip and removes the temp folder`, { timeout: 40_000 }, async (t) => {
      const { tg, tmp, child, output, exited } = await startDemo(t);
      const url = await waitFor(() => /sample Paperclip at (http:\/\/127\.0\.0\.1:\d+)/.exec(output.out)?.[1], { label: 'the sample Paperclip address' });
      await waitFor(() => theBoard(tg), { timeout: 20_000, label: 'the board' });
      assert.equal(fs.readdirSync(tmp).length, 1, 'the demo keeps its files in one temp folder while it runs');
      assert.ok((await fetch(`${url}/api/companies/company-1/agents`)).status > 0, 'the sample Paperclip answers');

      child.kill(signal);
      const result = await exited;
      assert.deepEqual(result, { code: 0, signal: null });
      assert.match(output.out, /info stopped/, 'the bot stopped on its own');
      assert.deepEqual(fs.readdirSync(tmp), [], 'the temp folder is gone');
      await assert.rejects(fetch(url), TypeError, 'the sample Paperclip no longer answers');
      assert.equal(output.err, '');
    });
  }

  test('--state keeps the bot state in the folder given; the demo writes private files and talks only to itself', { timeout: 40_000 }, async (t) => {
    const { dir, tg, tmp, child, exited } = await startDemo(t, { args: (folder) => ['--state', path.join(folder, 'kept')] });
    await waitFor(() => theBoard(tg), { timeout: 20_000, label: 'the board' });

    const [name] = fs.readdirSync(tmp);
    const work = path.join(tmp, name);
    assert.equal(fs.statSync(work).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(work, 'paperclip-token')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(work, 'config.json')).mode & 0o777, 0o600);
    const config = JSON.parse(fs.readFileSync(path.join(work, 'config.json'), 'utf8'));
    assert.match(config.paperclipUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(config.uiBaseUrl, 'https://paperclip.example.com');
    assert.ok(config.paperclipTokenFile.startsWith(work), 'the Paperclip token is a file of its own in the temp folder');

    child.kill('SIGTERM');
    assert.equal((await exited).code, 0);
    assert.ok(fs.existsSync(path.join(dir, 'kept', 'state.json')), 'the state is kept where --state says');
    assert.deepEqual(fs.readdirSync(tmp), []);
  });
});
