import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PAPERCLIP_TOKEN, TELEGRAM_TOKEN, confirmPayload, startWorld, waitFor, writeTokenFile } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/paperclip-telegram.js', import.meta.url));
const SECRET = 'do-not-print-this-secret-value';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-telegram-proc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A config whose servers are never contacted: these runs must stop before any network use.
function writeConfig(dir, overrides = {}) {
  const file = path.join(dir, 'config.json');
  const config = {
    paperclipUrl: 'http://127.0.0.1:9',
    uiBaseUrl: 'https://paperclip.example.com',
    companyId: 'company-1',
    leadAgentId: 'agent-lead',
    telegramUserId: 1001,
    telegramTokenFile: path.join(dir, 'telegram-token'),
    paperclipTokenFile: path.join(dir, 'paperclip-token'),
    ...overrides,
  };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return file;
}

function runBin(configFile, dir) {
  return spawnSync(process.execPath, [BIN], {
    env: { PATH: process.env.PATH, PAPERCLIP_TELEGRAM_CONFIG: configFile, STATE_DIRECTORY: path.join(dir, 'state') },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('exits 78 when a token file is readable by group or others', async (t) => {
  const dir = tempDir(t);
  writeTokenFile(path.join(dir, 'telegram-token'), SECRET, 0o644);
  writeTokenFile(path.join(dir, 'paperclip-token'), 'another-secret');
  const result = runBin(writeConfig(dir), dir);
  assert.equal(result.status, 78);
  assert.match(result.stderr, /telegramTokenFile/);
  assert.match(result.stderr, /chmod 600/);
  assert.ok(result.stderr.includes(path.join(dir, 'telegram-token')));
  assert.ok(!(result.stdout + result.stderr).includes(SECRET));
  assert.ok(!(result.stdout + result.stderr).includes('another-secret'));
});

test('exits 78 when a token file is missing, empty, or not a regular file', async (t) => {
  const dir = tempDir(t);
  writeTokenFile(path.join(dir, 'paperclip-token'), SECRET);
  const configFile = writeConfig(dir);

  let result = runBin(configFile, dir);
  assert.equal(result.status, 78);
  assert.match(result.stderr, /token file missing/);
  assert.match(result.stderr, /telegramTokenFile/);

  writeTokenFile(path.join(dir, 'telegram-token'), '   ');
  result = runBin(configFile, dir);
  assert.equal(result.status, 78);
  assert.match(result.stderr, /token file is empty/);

  fs.rmSync(path.join(dir, 'telegram-token'));
  fs.mkdirSync(path.join(dir, 'telegram-token'));
  result = runBin(configFile, dir);
  assert.equal(result.status, 78);
  assert.match(result.stderr, /not a regular file/);
  assert.ok(!(result.stdout + result.stderr).includes(SECRET));
});

test('a FIFO as a token file exits 78 instead of hanging', async (t) => {
  const dir = tempDir(t);
  writeTokenFile(path.join(dir, 'paperclip-token'), SECRET);
  execFileSync('mkfifo', ['-m', '600', path.join(dir, 'telegram-token')]);
  const result = runBin(writeConfig(dir), dir);
  assert.equal(result.status, 78);
  assert.match(result.stderr, /telegramTokenFile: token file is not a regular file/);
});

test('a world-readable Paperclip token file is refused as well', async (t) => {
  const dir = tempDir(t);
  writeTokenFile(path.join(dir, 'telegram-token'), SECRET);
  writeTokenFile(path.join(dir, 'paperclip-token'), SECRET, 0o640);
  const result = runBin(writeConfig(dir), dir);
  assert.equal(result.status, 78);
  assert.match(result.stderr, /paperclipTokenFile/);
});

test('exits 78 for a missing, unreadable or invalid config and lists every problem', async (t) => {
  const dir = tempDir(t);
  let result = runBin(path.join(dir, 'nope.json'), dir);
  assert.equal(result.status, 78);
  assert.match(result.stderr, /config file missing/);

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  result = runBin(broken, dir);
  assert.equal(result.status, 78);
  assert.match(result.stderr, /not valid JSON/);

  const invalid = writeConfig(dir, { telegramUserId: 0, paperclipUrl: 'ftp://nope', pollSeconds: -1 });
  result = runBin(invalid, dir);
  assert.equal(result.status, 78);
  assert.match(result.stderr, /telegramUserId must be a positive integer/);
  assert.match(result.stderr, /paperclipUrl must be an http\(s\) URL/);
  assert.match(result.stderr, /pollSeconds must be a positive number/);
  assert.match(result.stderr, /token file missing/, 'token problems are reported together with config problems');
});

test('a full run serves the owner, never prints a token, and stops cleanly on SIGTERM', async (t) => {
  const w = await startWorld();
  t.after(() => w.close());
  const issue = w.pc.addIssue({ title: 'Needs an answer', status: 'in_review' });
  const interaction = w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload() });

  const output = { out: '', err: '' };
  const child = spawn(process.execPath, [BIN], { env: { PATH: process.env.PATH, ...w.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => (output.out += chunk));
  child.stderr.on('data', (chunk) => (output.err += chunk));
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(() => child.kill('SIGKILL'));

  // The pending card is delivered and a tap on it reaches Paperclip.
  const card = await waitFor(() => w.tg.findMessage('Deploy the change?'), { label: 'card' });
  const tap = w.tg.push(w.tg.tapButton(card.message_id, 'Deploy'));
  await waitFor(() => w.pc.interactions.get(interaction.id).status === 'accepted', { label: 'accept' });

  // Provoke the error paths that log: a rejected Paperclip key, then the Telegram API going away.
  w.pc.setUnauthorized(true);
  await waitFor(() => w.tg.findMessage('Token rejected'), { label: 'token alert' });
  await waitFor(() => output.err.includes('401'), { label: '401 log line' });
  w.pc.setUnauthorized(false);
  await w.tg.close();
  await waitFor(() => output.err.includes('telegram polling failed'), { label: 'telegram error log line' });

  child.kill('SIGTERM');
  const { code, signal } = await exited;
  assert.equal(signal, null);
  assert.equal(code, 0);

  const everything = output.out + output.err;
  assert.ok(everything.includes('started'));
  for (const secret of [TELEGRAM_TOKEN, PAPERCLIP_TOKEN, `bot${TELEGRAM_TOKEN}`, `Bearer ${PAPERCLIP_TOKEN}`]) {
    assert.ok(!everything.includes(secret), `output must not contain ${secret.slice(0, 8)}…`);
  }
  for (const request of w.pc.requests) assert.equal(request.headers['x-paperclip-run-id'], undefined);

  const state = JSON.parse(fs.readFileSync(path.join(w.env.STATE_DIRECTORY, 'state.json'), 'utf8'));
  assert.equal(state.offset, tap.update_id + 1);
  assert.equal(fs.statSync(path.join(w.env.STATE_DIRECTORY, 'state.json')).mode & 0o777, 0o600);
});

test('SIGTERM during the long poll exits promptly with status 0', async (t) => {
  const w = await startWorld({ telegram: { holdMs: 30_000 } });
  t.after(() => w.close());
  const child = spawn(process.execPath, [BIN], { env: { PATH: process.env.PATH, ...w.env }, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)));
  await waitFor(() => w.tg.callsTo('getUpdates').length > 0, { label: 'long poll' });
  const started = Date.now();
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.ok(Date.now() - started < 5000);
});
