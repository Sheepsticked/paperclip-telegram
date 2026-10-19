import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCard, renderCard } from '../src/cards.js';
import { DEFAULT_ROUTINE_RUN_ERROR_CODES, defaultStatePath, parseConfig, readTokenFile } from '../src/config.js';
import { isBoardComment } from '../src/comments.js';
import { MESSAGE_LIMIT, ago, button, chunkLines, escapeHtml, fitMessage, firstLine, issueUrl, cardUrl, runUrl, truncate, truncateLines } from '../src/format.js';
import { createLogger } from '../src/log.js';
import { PaperclipClient, PaperclipError } from '../src/paperclip.js';
import { SerialQueue } from '../src/queue.js';
import { State } from '../src/state.js';
import { parseNewArgs } from '../src/create.js';
import { parseTaskRef } from '../src/tasks.js';
import { TelegramClient, TelegramError } from '../src/telegram.js';
import { validateTelegramHtml } from './fakes/telegram.js';
import { writeTokenFile } from './helpers.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-telegram-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const baseConfig = {
  paperclipUrl: 'http://localhost:3100/',
  uiBaseUrl: 'https://paperclip.example.com//',
  companyId: 'company-1',
  leadAgentId: 'agent-lead',
  telegramUserId: 1001,
  telegramTokenFile: '~/telegram-token',
  paperclipTokenFile: '/tmp/paperclip-token',
};

test('escapeHtml escapes the three characters Telegram needs', () => {
  assert.equal(escapeHtml('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
});

test('truncate counts code points and never splits an emoji', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('😀'.repeat(10), 5), `${'😀'.repeat(4)}…`);
  assert.equal(truncate('abc', 1), '…');
  assert.equal(truncate('abc', 0), '');
  assert.equal(truncate(undefined, 5), '');
});

test('truncateLines keeps the first non-empty lines and caps the length', () => {
  assert.equal(truncateLines('a\n\nb\nc', 5, 100), 'a\nb\nc');
  assert.equal(truncateLines('1\n2\n3\n4', 3, 100), '1\n2\n3…');
  assert.equal(Array.from(truncateLines('x'.repeat(50), 5, 10)).length, 10);
  assert.equal(truncateLines('', 5, 10), '');
  assert.equal(firstLine('\n  \n  second  \nthird'), 'second');
});

test('chunkLines never exceeds the limit and never cuts a line', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(30)}`);
  const chunks = chunkLines(lines, 200);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 200);
  assert.equal(chunks.join('\n'), lines.join('\n'));
  assert.deepEqual(chunkLines([], 100), []);
});

test('fitMessage picks the first level that fits and fails when none does', () => {
  const levels = [{ n: 5000 }, { n: 100 }];
  assert.equal(fitMessage((level) => 'a'.repeat(level.n), levels).length, 100);
  assert.throws(() => fitMessage(() => 'a'.repeat(MESSAGE_LIMIT + 1), levels), /does not fit/);
});

test('links use the documented url shapes', () => {
  assert.equal(issueUrl('https://ui.example.com', 'ABC-12'), 'https://ui.example.com/ABC/issues/ABC-12');
  assert.equal(cardUrl('https://ui.example.com', 'ABC-12', 'i1'), 'https://ui.example.com/ABC/issues/ABC-12#interaction-i1');
  assert.equal(runUrl('https://ui.example.com', 'ABC', 'agent', 'run'), 'https://ui.example.com/ABC/agents/agent/runs/run');
});

test('very long card text is cut before escaping, so the HTML stays valid and under the limit', () => {
  const interaction = {
    id: 'interaction-1',
    kind: 'request_confirmation',
    payload: {
      prompt: '<&>'.repeat(5000),
      detailsMarkdown: '&'.repeat(9000),
      toolAction: { toolDisplayName: 'Run <script>', risk: 'high', previewMarkdown: '>'.repeat(5000) },
    },
  };
  const card = buildCard({ interaction, issue: { id: 'issue-1', identifier: 'TST-1', title: '<'.repeat(500) }, key: '1' });
  const { text } = renderCard(card, 'https://paperclip.example.com');
  assert.ok(text.length <= MESSAGE_LIMIT, `length ${text.length}`);
  assert.equal(validateTelegramHtml(text), null);
  assert.match(text, /<a href="https:\/\/paperclip\.example\.com\/TST\/issues\/TST-1#interaction-interaction-1">Open in Paperclip<\/a>/);
  assert.match(text, /…/);
});

test('a text of emoji at the cut point stays valid', () => {
  const interaction = { id: 'i', kind: 'request_confirmation', payload: { prompt: '😀&'.repeat(3000) } };
  const card = buildCard({ interaction, issue: { id: 'x', identifier: 'TST-2', title: 'Emoji' }, key: '2' });
  const { text } = renderCard(card, 'https://paperclip.example.com');
  assert.ok(text.length <= MESSAGE_LIMIT);
  assert.equal(validateTelegramHtml(text), null);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), 'no lone high surrogate');
});

test('validateTelegramHtml rejects what Telegram rejects', () => {
  assert.equal(validateTelegramHtml('<b>ok</b> &amp; <a href="https://x.example">l</a>'), null);
  assert.notEqual(validateTelegramHtml('a < b'), null);
  assert.notEqual(validateTelegramHtml('<b>open'), null);
  assert.notEqual(validateTelegramHtml('a & b'), null);
  assert.notEqual(validateTelegramHtml('<script>x</script>'), null);
});

test('parseConfig applies the documented defaults', () => {
  const { config, problems } = parseConfig(baseConfig);
  assert.deepEqual(problems, []);
  assert.equal(config.telegramChatId, 1001);
  assert.equal(config.telegramApiUrl, 'https://api.telegram.org');
  assert.equal(config.pollSeconds, 15);
  assert.equal(config.newTaskProjectId, null);
  assert.equal(config.paperclipUrl, 'http://localhost:3100');
  assert.equal(config.uiBaseUrl, 'https://paperclip.example.com');
  assert.equal(config.telegramTokenFile, path.join(os.homedir(), 'telegram-token'));
  assert.deepEqual(config.routineRunErrorCodes, DEFAULT_ROUTINE_RUN_ERROR_CODES);
  for (const code of ['cancelled', 'agent_paused', 'budget_paused', 'workspace_busy', 'paused']) assert.ok(config.routineRunErrorCodes.includes(code));
});

test('parseConfig keeps explicit values and reports each invalid key', () => {
  const ok = parseConfig({ ...baseConfig, telegramChatId: -100123, pollSeconds: 5, routineRunErrorCodes: ['x'], newTaskProjectId: 'p', telegramApiUrl: 'http://127.0.0.1:1/' });
  assert.equal(ok.config.telegramChatId, -100123);
  assert.equal(ok.config.pollSeconds, 5);
  assert.deepEqual(ok.config.routineRunErrorCodes, ['x']);
  assert.equal(ok.config.telegramApiUrl, 'http://127.0.0.1:1');

  const bad = parseConfig({ ...baseConfig, telegramUserId: '1001', telegramChatId: 0, companyId: '', pollSeconds: 0, routineRunErrorCodes: 'cancelled' });
  assert.equal(bad.config, null);
  assert.equal(bad.problems.length, 5);
  assert.equal(parseConfig(null).config, null);
  assert.equal(parseConfig([]).config, null);
});

test('defaultStatePath prefers STATE_DIRECTORY and falls back to the home state dir', () => {
  assert.equal(defaultStatePath({ STATE_DIRECTORY: '/run/state-dir' }), '/run/state-dir/state.json');
  assert.equal(defaultStatePath({ STATE_DIRECTORY: '/a:/b' }), '/a/state.json');
  assert.equal(defaultStatePath({}), path.join(os.homedir(), '.local', 'state', 'paperclip-telegram', 'state.json'));
});

test('readTokenFile trims, and refuses loose permissions without quoting the content', (t) => {
  const dir = tempDir(t);
  const file = writeTokenFile(path.join(dir, 'token'), 'abc-token-value');
  assert.deepEqual(readTokenFile(file, 'label'), { token: 'abc-token-value' });

  fs.chmodSync(file, 0o640);
  const loose = readTokenFile(file, 'label');
  assert.match(loose.problem, /must not be accessible by group or others/);
  assert.ok(!loose.problem.includes('abc-token-value'));

  fs.chmodSync(file, 0o604);
  assert.match(readTokenFile(file, 'label').problem, /must not be accessible/);
  assert.match(readTokenFile(path.join(dir, 'missing'), 'label').problem, /token file missing/);
  assert.match(readTokenFile(dir, 'label').problem, /not a regular file/);
});

test('the logger masks known secrets and anything shaped like one', () => {
  const out = [];
  const err = [];
  const log = createLogger({ secrets: ['my-secret-value'], out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) } });
  log.info('hello my-secret-value', { url: 'https://api.telegram.org/bot123456:ABCDEFGHIJKL/getUpdates', key: 'pcp_board_abcDEF123' });
  log.error('line one\nline two');
  log.warn('careful');
  assert.equal(out.length, 1);
  assert.equal(err.length, 2);
  assert.equal(out[0], 'info hello [redacted] url=https://api.telegram.org/[redacted]/getUpdates key=[redacted]\n');
  assert.equal(err[0], 'error line one line two\n');
});

test('Telegram errors never carry the request url or token', async () => {
  const token = '123456:SECRET-token-value';
  const client = new TelegramClient({ baseUrl: 'http://127.0.0.1:1', token });
  await assert.rejects(client.sendMessage({ chat_id: 1, text: 'x' }), (err) => {
    assert.ok(err instanceof TelegramError);
    assert.equal(err.network, true);
    assert.ok(!err.message.includes(token));
    assert.ok(!JSON.stringify(err).includes(token));
    assert.ok(!String(err.stack).includes(token));
    return true;
  });
});

test('Paperclip errors never carry the bearer token', async () => {
  const token = 'pcp_board_SECRETVALUE';
  const client = new PaperclipClient({ baseUrl: 'http://127.0.0.1:1', token });
  await assert.rejects(client.listAgents('company-1'), (err) => {
    assert.ok(err instanceof PaperclipError);
    assert.equal(err.network, true);
    assert.ok(!err.message.includes(token));
    assert.ok(!String(err.stack).includes(token));
    return true;
  });
});

test('State saves atomically with private permissions and prunes old data', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'state.json');
  const state = new State(file);
  state.offset = 42;
  const key = state.nextCardKey();
  state.cards.set(key, { key, interactionId: 'i1', issueId: 'x', status: 'pending', messageId: 1 });
  state.cards.set('old', { key: 'old', interactionId: 'i2', issueId: 'x', status: 'resolved', resolvedAt: '2020-01-01T00:00:00.000Z' });
  state.cards.set('new', { key: 'new', interactionId: 'i3', issueId: 'x', status: 'resolved', resolvedAt: new Date().toISOString() });
  state.pruneCards(Date.now());
  state.save();

  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
  const loaded = State.load(file);
  assert.equal(loaded.offset, 42);
  assert.deepEqual([...loaded.cards.keys()].sort(), ['1', 'new']);
  assert.equal(loaded.cardByInteraction('i1').key, '1');
  assert.equal(loaded.pendingCards().length, 1);
});

test('State keeps only the newest 2000 messages and 500 alerted runs', (t) => {
  const state = new State(path.join(tempDir(t), 'state.json'));
  for (let i = 0; i < 2100; i += 1) state.mapMessage(i, `issue-${i}`, `TST-${i}`);
  assert.equal(state.messages.size, 2000);
  assert.equal(state.issueForMessage(99), null);
  assert.deepEqual(state.issueForMessage(2099), { id: 'issue-2099', identifier: 'TST-2099' });
  for (let i = 0; i < 600; i += 1) state.markRunAlerted(`run-${i}`);
  state.markRunAlerted('run-599');
  assert.equal(state.alertedRuns.length, 500);
  assert.ok(!state.alertedRuns.includes('run-0'));
  assert.ok(state.alertedRuns.includes('run-599'));
});

test('a corrupt state file is set aside and the bot starts fresh', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{ broken');
  const warnings = [];
  const state = State.load(file, { warn: (message) => warnings.push(message) });
  assert.equal(state.offset, 0);
  assert.ok(fs.existsSync(`${file}.corrupt`));
  assert.equal(warnings.length, 1);
  assert.equal(State.load(path.join(dir, 'missing.json')).offset, 0);
});

test('SerialQueue runs jobs one at a time, in order, and survives a failing job', async () => {
  const queue = new SerialQueue();
  const events = [];
  const slow = queue.run(async () => {
    events.push('a:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push('a:end');
  });
  const failing = queue.run(async () => {
    events.push('b');
    throw new Error('boom');
  });
  const last = queue.run(async () => events.push('c'));
  await slow;
  await assert.rejects(failing, /boom/);
  await last;
  await queue.idle();
  assert.deepEqual(events, ['a:start', 'a:end', 'b', 'c']);
});

test('an old state file loads with default settings and nothing followed', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, offset: 7, cards: {}, messages: [[5, 'issue-1']], statuses: { 'issue-1': 'done' } }));
  const state = State.load(file);
  assert.equal(state.offset, 7);
  assert.deepEqual(state.settings, { done: true, inReview: true, runFailed: true, followedComments: true, autoFollowCreated: true });
  assert.equal(state.following.size, 0);
  assert.equal(state.offers.size, 0);
  assert.equal(state.muteUntil, null);
  assert.equal(state.hiddenCounts(), null);
  assert.equal(JSON.parse(JSON.stringify(state)).version, 2);
});

test('State ignores malformed settings and counts from a hand-edited file', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ settings: { done: 'no', inReview: false, extra: true }, mutedCounts: { done: -3, comments: 2.5, runFailed: 4 } }));
  const state = State.load(file);
  assert.deepEqual(state.settings, { done: true, inReview: false, runFailed: true, followedComments: true, autoFollowCreated: true });
  assert.deepEqual(state.mutedCounts, { done: 0, inReview: 0, runFailed: 4, comments: 0 });
});

test('parseConfig defaults topics to auto and accepts only auto or off', () => {
  assert.equal(parseConfig(baseConfig).config.topics, 'auto');
  assert.equal(parseConfig({ ...baseConfig, topics: 'off' }).config.topics, 'off');
  const bad = parseConfig({ ...baseConfig, topics: 'on' });
  assert.equal(bad.config, null);
  assert.match(bad.problems.join('\n'), /topics must be "auto" or "off"/);
});

test('State keeps topics and the issue to root cache across a save, capped at 2000 roots', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  const state = new State(file);
  state.topics.set('root-1', { thread: 77, identifier: 'TST-1', title: 'A task', closed: 'done' });
  for (let i = 0; i < 2100; i += 1) state.noteRoot(`issue-${i}`, 'root-1');
  assert.equal(state.roots.size, 2000);
  assert.ok(!state.roots.has('issue-0'));
  state.addOffer('text', 5, 6, 0, 42);
  state.save();

  const loaded = State.load(file);
  assert.deepEqual(loaded.topics.get('root-1'), { thread: 77, identifier: 'TST-1', title: 'A task', closed: 'done' });
  assert.equal(loaded.roots.size, 2000);
  assert.equal(loaded.rootForThread(77), 'root-1');
  assert.equal(loaded.rootForThread(78), null);
  assert.equal([...loaded.offers.values()][0].thread, 42);
  assert.equal(JSON.parse(JSON.stringify(loaded)).version, 2);
});

test('State drops malformed topic entries from a hand-edited file', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ topics: { good: { thread: 3, identifier: 'TST-1', title: 'T', closed: 'oops' }, bad: { thread: 'x' }, worse: null }, roots: { a: 'good', b: 5 } }),
  );
  const state = State.load(file);
  assert.deepEqual([...state.topics.keys()], ['good']);
  assert.equal(state.topics.get('good').closed, null);
  assert.deepEqual([...state.roots], [['a', 'good']]);
  assert.equal(State.load(path.join(tempDir(t), 'none.json')).topics.size, 0);
});

test('parseTaskRef accepts identifiers in any case and bare numbers with a default prefix', () => {
  assert.equal(parseTaskRef('TST-12'), 'TST-12');
  assert.equal(parseTaskRef(' tst-012 '), 'TST-12');
  assert.equal(parseTaskRef('#12', 'TST'), 'TST-12');
  assert.equal(parseTaskRef('12'), null, 'a bare number needs a prefix');
  for (const bad of ['', 'TST-', 'TST-1a', 'two words', '-5', 'TST--5']) assert.equal(parseTaskRef(bad, 'TST'), null, bad);
});

test('parseNewArgs takes one leading agent and one leading project', () => {
  assert.deepEqual(parseNewArgs('@dev #web Do it'), { agent: 'dev', project: 'web', text: 'Do it' });
  assert.deepEqual(parseNewArgs('#web @dev Do it'), { agent: 'dev', project: 'web', text: 'Do it' });
  assert.deepEqual(parseNewArgs('@dev @lead Do it'), { agent: 'dev', project: null, text: '@lead Do it' });
  assert.deepEqual(parseNewArgs('Do it @dev'), { agent: null, project: null, text: 'Do it @dev' });
  assert.deepEqual(parseNewArgs('@dev'), { agent: 'dev', project: null, text: '' });
});

test('button refuses callback data over 64 bytes and cuts long labels', () => {
  assert.deepEqual(button('Go', 'T:v:abc'), { text: 'Go', callback_data: 'T:v:abc' });
  assert.throws(() => button('Go', 'x'.repeat(65)), /callback data over 64 bytes/);
  assert.doesNotThrow(() => button('Go', 'x'.repeat(64)));
  assert.equal(Array.from(button('L'.repeat(200), 'a').text).length, 60);
});

test('ago names minutes, hours and days', () => {
  const now = Date.parse('2030-01-10T12:00:00Z');
  assert.equal(ago('2030-01-10T11:59:50Z', now), 'just now');
  assert.equal(ago('2030-01-10T11:15:00Z', now), '45 min ago');
  assert.equal(ago('2030-01-10T07:00:00Z', now), '5 h ago');
  assert.equal(ago('2030-01-07T12:00:00Z', now), '3 d ago');
  assert.equal(ago('2030-01-11T12:00:00Z', now), 'just now', 'a time in the future is not negative');
  assert.equal(ago('garbage', now), 'unknown time ago');
});

test('isBoardComment tells the owner from agents and the system', () => {
  assert.equal(isBoardComment({ authorType: 'user', authorUserId: 'board-user-1' }), true);
  assert.equal(isBoardComment({ authorType: 'agent', authorAgentId: 'a1' }), false);
  assert.equal(isBoardComment({ authorType: 'system' }), false);
  assert.equal(isBoardComment({ authorType: 'user', authorUserId: 'local-board' }), false);
  assert.equal(isBoardComment({ authorType: 'user', authorUserId: 'local-board', derivedAuthorAgentId: 'a1' }), false);
  assert.equal(isBoardComment({ authorType: 'user', authorUserId: 'board-user-1', authorAgentId: 'a1' }), false);
});
