import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCard, renderCard } from '../src/cards.js';
import { ALERT_LIMIT, MENTION_ROOM, MESSAGE_LIMIT, withMention } from '../src/format.js';
import { PaperclipError } from '../src/paperclip.js';
import { mentionProblems, mentioned, unmentioned } from './alerts.js';
import { mentionEntities } from './fakes/telegram.js';
import { UI_BASE_URL, startWorld } from './helpers.js';

const GROUP_ID = -1001234567890;
const GROUP = { telegram: { chatId: GROUP_ID }, config: { topics: 'off' } };

const sendTexts = (w) => w.tg.callsTo('sendMessage').map((call) => call.params.text);
const WARN_MISSING = 'warn alert without an owner mention\n';
const WARN_DROPPED = 'warn Telegram dropped the owner mention\n';
const INFO_ACCEPTED = 'info owner mention accepted\n';
const count = (lines, line) => lines.filter((entry) => entry === line).length;

async function setup(t, options = GROUP) {
  const w = await startWorld(options);
  t.after(() => w.close());
  return { w, bot: await w.primedBot() };
}

test('the fake reports an inline user link as a text_mention entity, counted in UTF-16 units of the plain text', () => {
  const entities = mentionEntities('x &lt; \u{1F600}<b><a href="tg://user?id=7">Hi &amp; you</a></b> <a href="https://example.com">site</a>');
  assert.deepEqual(entities, [{ type: 'text_mention', offset: 6, length: 8, user: { id: 7, is_bot: false, first_name: 'Owner' } }]);
  assert.deepEqual(mentionEntities('<b>Done</b>'), []);
});

test('withMention turns the leading bold word into a mention and adds at most MENTION_ROOM characters', () => {
  assert.equal(withMention('<b>Run failed</b> · Dev\nboom', 1001), `<b><a href="tg://user?id=1001">Run failed</a></b> · Dev\nboom`);
  const html = '<b>Done</b> · TST-1';
  assert.equal(withMention(html, Number.MAX_SAFE_INTEGER).length - html.length, MENTION_ROOM);
  assert.equal(ALERT_LIMIT, MESSAGE_LIMIT - MENTION_ROOM);
  for (const bad of ['Plain text', '<b><a href="https://example.com">Linked</a></b> · Dev', ' <b>Late</b>', '<b></b>']) assert.equal(withMention(bad, 1001), null, bad);
  assert.equal(withMention(`<b>Done</b>${'x'.repeat(MESSAGE_LIMIT - 11)}`, 1001), null, 'a result over the limit is refused');
});

test('an alert in a group mentions the owner; a silent message and an edit do not', async (t) => {
  const { w, bot } = await setup(t);
  const id = await bot.send('<b>Question</b>\nDeploy?', { alert: true });
  await bot.send('<b>Dev</b>\nA comment');
  await bot.edit(id, '<b>Question</b>\nDeploy?\n\nConfirmed');

  assert.deepEqual(sendTexts(w), [`${mentioned('Question', w.tg.userId)}\nDeploy?`, '<b>Dev</b>\nA comment']);
  assert.equal(w.tg.callsTo('editMessageText')[0].params.text, '<b>Question</b>\nDeploy?\n\nConfirmed');
  assert.deepEqual(mentionProblems(w.tg.calls, w.tg.userId), []);
});

test('an alert in a private chat gets no mention and no mention log line', async (t) => {
  const { w, bot } = await setup(t, {});
  await bot.send('<b>Question</b>\nDeploy?', { alert: true });

  assert.equal(w.tg.lastMessage().text, '<b>Question</b>\nDeploy?');
  assert.ok(!w.allLogText().includes('mention'));
});

test('an alert that cannot carry the mention is sent unchanged with one warning and no message text in the log', async (t) => {
  const w = await startWorld(GROUP);
  const bot = await w.primedBot();
  const inputs = ['<b><a href="https://example.com/run">Run failed</a></b> · Dev', 'Plain alert text', `<b>Done</b>${'x'.repeat(MESSAGE_LIMIT - 11)}`];
  for (const html of inputs) await bot.send(html, { alert: true });

  assert.deepEqual(sendTexts(w), inputs);
  assert.equal(count(w.logs.err, WARN_MISSING), 3);
  assert.ok(!w.allLogText().includes('Plain alert text') && !w.allLogText().includes('example.com'));
  assert.equal(mentionProblems(w.tg.calls, w.tg.userId).length, 3, 'the suite-wide check reports each of them');
  await assert.rejects(w.close());
});

test('a mention Telegram drops gives one warning per process and a kept one gives one info line', async (t) => {
  const { w, bot } = await setup(t);
  w.tg.dropMentions();
  await bot.send('<b>Question</b>\nCanary one', { alert: true });
  await bot.send('<b>Question</b>\nCanary two', { alert: true });
  await bot.send('<b>Dev</b>\nA silent message');
  assert.equal(count(w.logs.err, WARN_DROPPED), 1);
  assert.equal(count(w.logs.out, INFO_ACCEPTED), 0);

  w.tg.dropMentions(false);
  await bot.send('<b>Question</b>\nCanary three', { alert: true });
  await bot.send('<b>Question</b>\nCanary four', { alert: true });
  assert.equal(count(w.logs.out, INFO_ACCEPTED), 1);
  assert.equal(count(w.logs.err, WARN_DROPPED), 1, 'the warning is not repeated');
  assert.ok(!w.allLogText().includes('Canary'));
});

test('a mention that comes through right away logs the info line once and no warning', async (t) => {
  const { w, bot } = await setup(t);
  await bot.send('<b>Question</b>\nCanary one', { alert: true });
  await bot.send('<b>Done</b>', { alert: true });
  assert.equal(count(w.logs.out, INFO_ACCEPTED), 1);
  assert.equal(count(w.logs.err, WARN_DROPPED) + count(w.logs.err, WARN_MISSING), 0);
});

test('an inbox item without a task or a title keeps its link on a last line', async (t) => {
  const { w, bot } = await setup(t);
  const join = w.pc.addJoinRequest({ name: '' });
  await bot.pollOnce();

  const link = `<a href="${UI_BASE_URL}/TST/settings/access">Open in Paperclip</a>`;
  const message = w.tg.findMessage('Join request');
  assert.equal(message.text, `${mentioned('Join request', w.tg.userId)}\nJoin request is pending approval.\n\n${link}`);

  join.close();
  await bot.pollOnce();
  assert.equal(w.tg.messages.get(message.message_id).text, `<b>Join request</b>\nJoin request is pending approval.\n\nResolved\n\n${link}`);
});

test('the token alert is a bold word and an instruction, and the summary starts with a bold count', async (t) => {
  const { w, bot } = await setup(t);
  await bot.paperclipFailed(new PaperclipError('GET', '/x', { status: 401 }));
  assert.equal(w.tg.lastMessage().text, `${mentioned('Token rejected', w.tg.userId)}\nCreate a new Paperclip board key`);

  for (let i = 0; i < 11; i += 1) w.pc.addIssue({ title: `Finished ${i}`, status: 'done' });
  await bot.pollOnce();
  assert.equal(w.tg.lastMessage().text, `${mentioned('11 done', w.tg.userId)}, 0 in review since the last check, see /status`);
});

test('a card built to the alert limit still carries the mention within the Telegram limit', () => {
  const lengths = [];
  for (let angles = 0; angles <= 1000; angles += 1) {
    const prompt = 'a'.repeat(1000 - angles) + '<'.repeat(angles);
    const interaction = { id: 'i-1', kind: 'request_confirmation', payload: { prompt, detailsMarkdown: 'd'.repeat(800) } };
    const card = buildCard({ interaction, issue: { id: 'issue-1', identifier: 'TST-1', title: 'Ship the release' }, key: '1' });
    const { text } = renderCard(card, UI_BASE_URL);
    const sent = withMention(text, Number.MAX_SAFE_INTEGER);
    assert.ok(sent && sent.length <= MESSAGE_LIMIT, `${angles} angle brackets: ${text.length} characters`);
    lengths.push(text.length);
  }
  assert.ok(Math.max(...lengths) >= ALERT_LIMIT - 3, 'the sweep reaches the limit');
});

test('a top-level Done near the length limit is cut to a smaller quote and still sends with the mention', async (t) => {
  const { w, bot } = await setup(t);
  // Each "<" is four characters once escaped, so the count tunes the length of the quote.
  const quoted = (angles) => 'a'.repeat(2000 - angles) + '<'.repeat(angles);
  const finish = async (title, angles) => {
    const issue = w.pc.addIssue({ title, status: 'in_progress' });
    await bot.pollOnce();
    w.pc.addComment(issue.id, { body: quoted(angles) });
    w.pc.setStatus(issue.id, 'done');
    await bot.pollOnce();
    return w.tg.lastMessage();
  };
  const base = unmentioned((await finish('Calibrate', 0)).text).length;
  const angles = Math.floor((MESSAGE_LIMIT - 6 - base) / 3);
  assert.ok(base + 3 * angles > ALERT_LIMIT && base + 3 * angles <= MESSAGE_LIMIT, 'the full quote is longer than the alert limit');

  const sent = await finish('Near the limit', angles);
  assert.ok(sent.text.startsWith(mentioned('Done', w.tg.userId)));
  assert.ok(sent.text.length <= MESSAGE_LIMIT && sent.text.includes('…'));
  assert.equal(count(w.logs.err, WARN_MISSING), 0);
  assert.equal(sent.silent, false);
});
