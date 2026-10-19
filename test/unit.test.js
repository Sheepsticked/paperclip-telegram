import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCard, renderCard } from '../src/cards.js';
import { DEFAULT_ROUTINE_RUN_ERROR_CODES, defaultStatePath, parseConfig, readTokenFile } from '../src/config.js';
import { isBoardComment } from '../src/comments.js';
import { MESSAGE_LIMIT, QUOTE_LEVELS, QUOTE_MAX, ago, button, chunkLines, escapeHtml, fitMessage, firstLine, headline, issueUrl, cardUrl, openRows, quote, runUrl, truncate, truncateLines } from '../src/format.js';
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
  assert.ok(text.startsWith('<b>Question</b> · <a href="https://paperclip.example.com/TST/issues/TST-1#interaction-interaction-1">TST-1</a> '), 'line 1 links the card');
  assert.ok(!text.includes('Open in Paperclip'));
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

test('parseConfig defaults closedTopicDays to 7 and accepts 0 or more only', () => {
  assert.equal(parseConfig(baseConfig).config.closedTopicDays, 7);
  assert.equal(parseConfig({ ...baseConfig, closedTopicDays: 0 }).config.closedTopicDays, 0);
  assert.equal(parseConfig({ ...baseConfig, closedTopicDays: 30 }).config.closedTopicDays, 30);
  for (const bad of [-1, '7', null, Number.NaN]) {
    const result = parseConfig({ ...baseConfig, closedTopicDays: bad });
    assert.equal(result.config, null, String(bad));
    assert.match(result.problems.join('\n'), /closedTopicDays must be a number of days/);
  }
});

test('forgetTopic drops the topic and the offers made in its thread', (t) => {
  const state = new State(path.join(tempDir(t), 'state.json'));
  state.topics.set('root-1', { thread: 77, identifier: 'TST-1', title: 'A task', closed: null, suffixed: false, closedAt: null, projectId: null, iconId: '' });
  const inside = state.addOffer('inside', 1, 2, 0, 77);
  const outside = state.addOffer('outside', 3, 4, 0, 78);
  state.forgetTopic('root-1');
  assert.equal(state.topics.has('root-1'), false);
  assert.equal(state.offers.has(inside), false);
  assert.equal(state.offers.has(outside), true);
  state.forgetTopic('missing');
});

test('State keeps topics and the issue to root cache across a save, capped at 2000 roots', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  const state = new State(file);
  const topic = { thread: 77, identifier: 'TST-1', title: 'A task', closed: 'done', suffixed: false, closedAt: 1_000, projectId: 'project-1', iconId: 'icon-1' };
  state.topics.set('root-1', topic);
  for (let i = 0; i < 2100; i += 1) state.noteRoot(`issue-${i}`, 'root-1');
  assert.equal(state.roots.size, 2000);
  assert.ok(!state.roots.has('issue-0'));
  state.addOffer('text', 5, 6, 0, 42);
  state.save();

  const loaded = State.load(file);
  assert.deepEqual(loaded.topics.get('root-1'), topic);
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
  assert.equal(state.topics.get('good').suffixed, false);
  assert.deepEqual([...state.roots], [['a', 'good']]);
  assert.equal(State.load(path.join(tempDir(t), 'none.json')).topics.size, 0);
});

test('a closed topic from an old state file is taken to carry the status suffix', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  const entry = (extra) => ({ thread: 1, identifier: 'TST-1', title: 'T', ...extra });
  fs.writeFileSync(
    file,
    JSON.stringify({
      topics: {
        open: entry({ closed: null }),
        closedOld: entry({ closed: 'done' }),
        closedNew: entry({ closed: 'cancelled', suffixed: false }),
        flagged: entry({ closed: null, suffixed: true }),
        junk: entry({ closed: null, suffixed: 'yes' }),
      },
    }),
  );
  const { topics } = State.load(file);
  const flags = Object.fromEntries([...topics].map(([id, topic]) => [id, topic.suffixed]));
  assert.deepEqual(flags, { open: false, closedOld: true, closedNew: false, flagged: true, junk: false });
});

test('State keeps the shown comments in order, newest 500, across a save', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  const state = new State(file);
  state.noteShown(null);
  state.noteShown('');
  state.noteShown('a');
  state.noteShown('b');
  state.noteShown('a');
  assert.deepEqual([...state.shownComments], ['b', 'a'], 'a comment shown again moves to the newest place');
  assert.equal(state.hasShown('a'), true);
  assert.equal(state.hasShown('zzz'), false);
  state.save();
  assert.deepEqual([...State.load(file).shownComments], ['b', 'a']);

  for (let i = 0; i < 600; i += 1) state.noteShown(`c-${i}`);
  assert.equal(state.shownComments.size, 500);
  assert.equal(state.hasShown('a'), false);
  assert.equal(state.hasShown('c-99'), false);
  assert.equal(state.hasShown('c-100'), true);
});

test('State loads the shown comments from a hand-edited file and an old file has none', (t) => {
  const dir = tempDir(t);
  assert.equal(State.load(path.join(dir, 'none.json')).shownComments.size, 0);
  const old = path.join(dir, 'old.json');
  fs.writeFileSync(old, JSON.stringify({ version: 2 }));
  assert.equal(State.load(old).shownComments.size, 0);

  const edited = path.join(dir, 'edited.json');
  const many = Array.from({ length: 700 }, (_, i) => `c-${i}`);
  fs.writeFileSync(edited, JSON.stringify({ shownComments: ['x', 5, null, ...many] }));
  const loaded = State.load(edited);
  assert.equal(loaded.shownComments.size, 500);
  assert.equal(loaded.hasShown('x'), false, 'the oldest go first');
  assert.equal(loaded.hasShown('c-699'), true);
  fs.writeFileSync(edited, JSON.stringify({ shownComments: 'nope' }));
  assert.equal(State.load(edited).shownComments.size, 0);
});

// A fetch stand-in that answers each call from `replies` (a status and a JSON body) and records the calls.
function stubFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body } = replies[Math.min(calls.length, replies.length) - 1];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

test('attentionFeed says whether the walk reached the end of the feed', async () => {
  const page = (ids, nextCursor) => ({ body: { items: ids.map((id) => ({ id })), nextCursor } });
  const make = (replies) => {
    const stub = stubFetch(replies);
    return { client: new PaperclipClient({ baseUrl: 'http://paperclip.test', token: 'pcp_board_x', fetchImpl: stub.fetchImpl }), calls: stub.calls };
  };

  const whole = make([page(['a'], 'c1'), page(['b'], null)]);
  assert.deepEqual(await whole.client.attentionFeed('c'), { items: [{ id: 'a' }, { id: 'b' }], complete: true });
  assert.ok(whole.calls[1].url.includes('cursor=c1'));

  const stale = make([page(['a'], 'c1'), { status: 400, body: { error: 'cursor no longer matches' } }]);
  assert.deepEqual(await stale.client.attentionFeed('c'), { items: [{ id: 'a' }], complete: false });

  const capped = make([page(['a'], 'c1'), page(['b'], 'c2'), page(['c'], 'c3')]);
  const result = await capped.client.attentionFeed('c', { maxPages: 2 });
  assert.equal(result.items.length, 2);
  assert.equal(result.complete, false);
  assert.deepEqual(await make([page(['a'], null)]).client.listAttention('c'), [{ id: 'a' }]);
});

test('uploadAttachment sends one multipart file part and postComment sends the attachment ids', async () => {
  const stub = stubFetch([{ status: 201, body: { id: 'att-1' } }, { status: 201, body: { id: 'com-1' } }, { status: 201, body: { id: 'com-2' } }]);
  const client = new PaperclipClient({ baseUrl: 'http://paperclip.test', token: 'pcp_board_x', fetchImpl: stub.fetchImpl });

  await client.uploadAttachment('c', 'i', { name: 'a.png', type: 'image/png', data: Buffer.from('abc') });
  const { init } = stub.calls[0];
  assert.equal(init.method, 'POST');
  assert.ok(init.body instanceof FormData);
  assert.ok(!('content-type' in init.headers), 'fetch sets the multipart boundary itself');
  const file = init.body.get('file');
  assert.deepEqual([file.name, file.type, file.size], ['a.png', 'image/png', 3]);
  assert.deepEqual([...init.body.keys()], ['file']);

  await client.postComment('i', 'Hello', { attachmentIds: ['att-1'] });
  assert.deepEqual(JSON.parse(stub.calls[1].init.body), { body: 'Hello', attachmentIds: ['att-1'] });
  await client.postComment('i', 'Plain');
  assert.deepEqual(JSON.parse(stub.calls[2].init.body), { body: 'Plain' });
});

test('State keeps inbox records and skipped items across a save and drops unusable entries', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  const state = new State(file);
  const record = { key: state.nextInboxKey(), kind: 'approval', dedupKey: 'approval:1', status: 'open', messageIds: [5], facts: ['Type: Hire agent'], options: [], resolvedAt: null };
  state.inbox.set(record.key, record);
  state.skipInbox('join:2');
  state.skipInbox('join:2');
  state.save();

  const loaded = State.load(file);
  assert.deepEqual(loaded.inbox.get('1'), record);
  assert.equal(loaded.nextInboxKey(), '2');
  assert.deepEqual(loaded.skippedInbox, ['join:2']);
  assert.equal(loaded.inboxByDedupKey('approval:1').key, '1');
  assert.equal(loaded.inboxByDedupKey('approval:9'), null);

  fs.writeFileSync(file, JSON.stringify({ inbox: { a: null, b: { kind: 'approval' }, c: { ...record, messageIds: 'x' }, d: { ...record, status: 'odd' }, e: record }, inboxCounter: 'x', skippedInbox: ['ok', 3, null] }));
  const hand = State.load(file);
  assert.deepEqual([...hand.inbox.keys()], ['e']);
  assert.equal(hand.inboxCounter, 0);
  assert.deepEqual(hand.skippedInbox, ['ok']);
});

test('State prunes resolved inbox records after a week and keeps open ones', (t) => {
  const state = new State(path.join(tempDir(t), 'state.json'));
  const now = Date.parse('2030-01-10T00:00:00Z');
  const base = { kind: 'approval', messageIds: [], facts: [], options: [] };
  state.inbox.set('1', { ...base, dedupKey: 'a', status: 'resolved', resolvedAt: '2030-01-01T00:00:00Z' });
  state.inbox.set('2', { ...base, dedupKey: 'b', status: 'resolved', resolvedAt: '2030-01-09T00:00:00Z' });
  state.inbox.set('3', { ...base, dedupKey: 'c', status: 'open', resolvedAt: null });
  state.pruneInbox(now);
  assert.deepEqual([...state.inbox.keys()], ['2', '3']);
  assert.deepEqual(state.openInbox().map((record) => record.dedupKey), ['c']);
});

test('State keeps the file and the chosen agent of an offer', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  const state = new State(file);
  const key = state.addOffer('text', 5, 6, 0, null, { file: { fileId: 'f', name: 'a.png', mime: 'image/png', size: 3 }, agentId: 'agent-1' });
  state.save();
  const offer = State.load(file).offers.get(key);
  assert.deepEqual(offer.file, { fileId: 'f', name: 'a.png', mime: 'image/png', size: 3 });
  assert.equal(offer.agentId, 'agent-1');
});

test('State drops unusable entries of the follow list, the offers and the counters when it loads', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  const offer = { text: 'x', messageId: 5, updateId: 3, at: 10, thread: null, file: null, agentId: null };
  fs.writeFileSync(
    file,
    JSON.stringify({
      following: {
        a: null,
        b: { title: 'no identifier' },
        c: { identifier: 'TST-1', title: 'T', status: 'todo', lastSeenCommentId: 7, lastSeenAt: 3, retry: -2 },
        d: 'text',
        e: { identifier: 'TST-2', title: 'U', status: 'todo', lastSeenCommentId: 'k', lastSeenAt: '2030-01-01T00:00:00Z', retry: 2 },
      },
      offers: {
        1: offer,
        2: { ...offer, text: 5 },
        3: { ...offer, messageId: 'x' },
        4: { ...offer, file: { fileId: 3 } },
        5: null,
        6: { ...offer, at: 'late' },
        7: { ...offer, thread: 'a' },
      },
      offerCounter: -1,
      prefixCounts: { TST: 3, BAD: 'x', NEG: -2, ZERO: 0 },
      reviewSent: ['a', 5, null],
      statusRetries: { a: { status: 'done', tries: 2 }, b: { status: 3, tries: 1 }, c: { status: 'done', tries: 0 }, d: 'x' },
    }),
  );
  const state = State.load(file);
  assert.deepEqual([...state.following.keys()], ['c', 'e']);
  assert.deepEqual(state.following.get('c'), { identifier: 'TST-1', title: 'T', status: 'todo', lastSeenCommentId: null, lastSeenAt: null, retry: 0 });
  assert.deepEqual(state.following.get('e'), { identifier: 'TST-2', title: 'U', status: 'todo', lastSeenCommentId: 'k', lastSeenAt: '2030-01-01T00:00:00Z', retry: 2 });
  assert.deepEqual([...state.offers.keys()], ['1']);
  assert.equal(state.offerCounter, 0);
  assert.deepEqual(state.prefixCounts, { TST: 3 });
  assert.deepEqual([...state.reviewSent], ['a']);
  assert.deepEqual([...state.statusRetries], [['a', { status: 'done', tries: 2 }]]);

  fs.writeFileSync(file, JSON.stringify({ following: [1, 2], offers: 'x', prefixCounts: [3], reviewSent: 'x', statusRetries: 3, offerCounter: 'x' }));
  const hand = State.load(file);
  assert.equal(hand.following.size + hand.offers.size + hand.reviewSent.size + hand.statusRetries.size, 0);
  assert.deepEqual(hand.prefixCounts, {});
  assert.equal(hand.offerCounter, 0);
});

test('State remembers review messages and failed status messages with a cap and a try count', (t) => {
  const state = new State(path.join(tempDir(t), 'state.json'));
  for (let i = 0; i < 2005; i += 1) state.noteReviewSent(`issue-${i}`);
  assert.equal(state.reviewSent.size, 2000);
  assert.equal(state.reviewSent.has('issue-4'), false);
  assert.equal(state.reviewSent.has('issue-2004'), true);

  assert.equal(state.noteStatusFailure('a', 'done'), 1);
  assert.equal(state.noteStatusFailure('a', 'done'), 2);
  assert.equal(state.noteStatusFailure('a', 'in_review'), 1, 'a different status starts again');
  for (let i = 0; i < 205; i += 1) state.noteStatusFailure(`issue-${i}`, 'done');
  assert.equal(state.statusRetries.size, 200);
});

test('State takes the configured chat and drops what depends on the old chat when it changes', (t) => {
  const file = path.join(tempDir(t), 'state.json');
  const state = new State(file);
  const record = { key: '1', kind: 'approval', dedupKey: 'approval:1', status: 'open', messageIds: [5], facts: [], options: [], resolvedAt: null };
  state.offset = 42;
  state.mapMessage(7, 'issue-1', 'TST-1');
  state.cards.set('1', { key: '1', interactionId: 'i-1', status: 'pending', messageId: 8 });
  state.inbox.set('1', record);
  state.addOffer('text', 5, 6, 0, null);
  state.topics.set('root-1', { thread: 9, identifier: 'TST-1', title: 'T', closed: null });
  state.noteRoot('issue-1', 'root-1');
  state.statuses.set('issue-1', 'done');
  state.alertedRuns.push('run-1');
  state.skipCard('i-9');
  state.skipInbox('join:1');
  state.noteReviewSent('issue-1');
  state.follow('issue-1', { identifier: 'TST-1', title: 'T', status: 'todo', lastSeenCommentId: 'c', lastSeenAt: '2030-01-01T00:00:00Z', retry: 0 });
  state.noteShown('comment-1');
  state.inboxSyncDone = true;

  assert.equal(state.adoptChat(10), false, 'a state without a chat only takes it');
  assert.equal(state.messages.size, 1);
  assert.equal(state.hasShown('comment-1'), true);
  assert.equal(state.adoptChat(10), false);
  assert.equal(state.inboxSyncDone, true);
  state.save();
  assert.equal(State.load(file).chatId, 10);

  assert.equal(state.adoptChat(-100), true);
  assert.equal(state.chatId, -100);
  for (const dropped of [state.messages, state.identifiers, state.cards, state.inbox, state.offers, state.topics, state.shownComments]) assert.equal(dropped.size, 0);
  assert.equal(state.inboxSyncDone, false);
  assert.equal(state.cardResync, true);
  assert.equal(state.offset, 42);
  assert.equal(state.statuses.get('issue-1'), 'done');
  assert.equal(state.roots.get('issue-1'), 'root-1');
  assert.deepEqual(state.alertedRuns, ['run-1']);
  assert.deepEqual(state.skippedCards, ['i-9']);
  assert.deepEqual(state.skippedInbox, ['join:1']);
  assert.ok(state.reviewSent.has('issue-1'));
  assert.equal(state.following.get('issue-1').lastSeenCommentId, 'c');

  state.save();
  const loaded = State.load(file);
  assert.equal(loaded.chatId, -100);
  assert.equal(loaded.cardResync, true);
  assert.equal(loaded.inboxSyncDone, false);
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

test('button carries a colour only when one is given, and only one of the three Telegram allows', () => {
  for (const style of ['primary', 'success', 'danger']) assert.deepEqual(button('Go', 'a', style), { text: 'Go', callback_data: 'a', style });
  assert.equal('style' in button('Go', 'a'), false, 'no style key without a colour');
  assert.equal('style' in button('Go', 'a', undefined), false);
  for (const bad of ['default', 'red', 'Primary', '']) assert.throws(() => button('Go', 'a', bad), /unknown button style/, bad);
});

test('openRows is the Open task button, and nothing inside the own topic', () => {
  assert.deepEqual(openRows('i1', false), [[{ text: 'Open task', callback_data: 'T:v:i1' }]]);
  assert.deepEqual(openRows('i1', true), []);
});

test('headline names the kind, links the id and drops the title in the own topic', () => {
  const issue = { identifier: 'TST-1', title: 'A <b> task' };
  const url = 'https://ui.example.com/TST/issues/TST-1';
  assert.equal(headline('Done', issue), '<b>Done</b> · TST-1 A &lt;b&gt; task');
  assert.equal(headline('Done', issue, { url }), `<b>Done</b> · <a href="${url}">TST-1</a> A &lt;b&gt; task`);
  assert.equal(headline('Done', issue, { own: true, url }), '<b>Done</b>');
  assert.equal(headline('Dev', { identifier: 'TST-1' }, { url }), `<b>Dev</b> · <a href="${url}">TST-1</a>`, 'no title, no trailing space');
  assert.equal(headline('A & B', issue, { own: true }), '<b>A &amp; B</b>', 'any kind is allowed and escaped');
  assert.equal(headline('Done', { identifier: 'TST-1', title: 'T'.repeat(300) }, { titleMax: 10 }), `<b>Done</b> · TST-1 ${'T'.repeat(9)}…`);

  const run = 'https://ui.example.com/TST/agents/a/runs/r';
  assert.equal(headline('Run failed', issue, { url, kindUrl: run }), `<b><a href="${run}">Run failed</a></b> · TST-1 A &lt;b&gt; task`, 'the kind link replaces the id link');
  assert.equal(headline('Run failed', issue, { own: true, kindUrl: run }), `<b><a href="${run}">Run failed</a></b>`);
});

test('quote puts escaped text in a block quote and folds a long one', () => {
  assert.equal(quote('Hello <b> & you'), '<blockquote>Hello &lt;b&gt; &amp; you</blockquote>');
  for (const empty of ['', '  \n \n', null, undefined]) assert.equal(quote(empty), '');
  assert.equal(quote('text', 0), '', 'a budget of zero leaves no quote');
  assert.equal(quote('a  \r\nb'), '<blockquote>a\nb</blockquote>', 'line ends are tidied');
  assert.equal(quote('a\n\n\n\nb'), '<blockquote>a\n\nb</blockquote>', 'blank lines collapse to one');

  assert.equal(quote('a\nb\nc'), '<blockquote>a\nb\nc</blockquote>', 'three lines stay open');
  assert.equal(quote('a\nb\nc\nd'), '<blockquote expandable>a\nb\nc\nd</blockquote>', 'four lines fold');
  assert.equal(quote('a\n\nb\n\nc'), '<blockquote>a\n\nb\n\nc</blockquote>', 'blank lines do not count');
  assert.equal(quote('x'.repeat(300)), `<blockquote>${'x'.repeat(300)}</blockquote>`);
  assert.equal(quote('x'.repeat(301)), `<blockquote expandable>${'x'.repeat(301)}</blockquote>`);
  assert.equal(quote('é'.repeat(300)).startsWith('<blockquote>'), true, 'characters are counted, not bytes');

  assert.equal(quote('y'.repeat(500), 200), `<blockquote>${'y'.repeat(199)}…</blockquote>`);
  assert.equal(quote('y'.repeat(5000)), `<blockquote expandable>${'y'.repeat(QUOTE_MAX - 1)}…</blockquote>`);
  for (const sample of [quote('a\nb\nc\nd'), quote('<&>'.repeat(200)), quote('plain')]) assert.equal(validateTelegramHtml(sample), null);
});

test('a quote is cut level by level until the whole message fits', () => {
  assert.deepEqual(QUOTE_LEVELS, [...QUOTE_LEVELS].sort((a, b) => b - a));
  assert.equal(QUOTE_LEVELS[0], QUOTE_MAX);
  assert.equal(QUOTE_LEVELS.at(-1), 0);
  const head = headline('Dev', { identifier: 'TST-1', title: 'Title' });
  const build = (body) => (max) => [head, quote(body, max)].filter(Boolean).join('\n');
  assert.equal(fitMessage(build('short'), QUOTE_LEVELS), `${head}\n<blockquote>short</blockquote>`);
  const long = fitMessage(build('<'.repeat(6000)), QUOTE_LEVELS);
  assert.ok(long.length <= MESSAGE_LIMIT && long.includes('…'));
  assert.equal(validateTelegramHtml(long), null);
  const tight = fitMessage((max) => [head, 'x'.repeat(4000), quote('word '.repeat(100), max)].filter(Boolean).join('\n'), QUOTE_LEVELS);
  assert.equal(tight, `${head}\n${'x'.repeat(4000)}`, 'the quote is the first thing to go');
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
