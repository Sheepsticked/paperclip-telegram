import assert from 'node:assert/strict';
import test from 'node:test';
import { ALERT_LIMIT } from '../src/format.js';
import { fitSettled } from '../src/outcome.js';
import { TelegramError } from '../src/telegram.js';
import { timeEntities, validateRichMarkdown, validateTelegramHtml } from './fakes/telegram.js';
import { choiceQuestion, confirmPayload, questionsPayload, startWorld, textQuestion, UI_BASE_URL } from './helpers.js';

// The instant every settle in this file happens at, as the bot's test clock says.
const SETTLED_AT = Date.parse('2026-05-01T12:34:56Z');
const UNIX = SETTLED_AT / 1000;
const TIME = `<tg-time unix="${UNIX}" format="r">12:34 UTC</tg-time>`;
const RICH_TIME = `![12:34 UTC](tg://time?unix=${UNIX}&format=r)`;
// The outcome block, given the kind and detail as source text.
const classic = (body) => `<blockquote>${body} · ${TIME}</blockquote>`;
const marked = (body) => `==${body} · ${RICH_TIME}==`;
const block = (rich, body) => (rich ? marked(body) : classic(body));
// A message as it was sent, then the outcome block (`body` is its kind and detail) as the last block.
const settled = (rich, before, body) => `${before}\n\n${block(rich, body)}`;

async function setup(t, { rich = false } = {}) {
  const w = await startWorld({ config: { richMessages: rich ? 'auto' : 'off' } });
  t.after(() => w.close());
  const clock = { at: Date.now() };
  const bot = await w.primedBot({ now: () => clock.at });
  return { w, bot, clock, rich };
}

const sends = (w) => w.tg.callsTo('sendMessage').length + w.tg.callsTo('sendRichMessage').length;
const edits = (w) => w.tg.callsTo('editMessageText').length;
const textOf = (w, message) => w.tg.messages.get(message.message_id).text;
const tap = (w, bot, message, label) => bot.handleUpdate(w.tg.tapButton(message.message_id, label));
const posts = (w, suffix) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));

// A world with one pending card of this kind, already sent.
async function cardWorld(t, rich, { kind, payload }) {
  const world = await setup(t, { rich });
  const { w, bot } = world;
  const issue = w.pc.addIssue({ title: 'Ship v2', status: 'in_review', assigneeAgentId: 'agent-1' });
  // A question card only has Markdown to send as rich when its set has a description.
  if (payload.questionSet) payload.questionSet.description = 'Pick the target.';
  const interaction = w.pc.addInteraction(issue.id, { kind, payload });
  await bot.pollOnce();
  const message = w.tg.findMessage(issue.identifier);
  assert.ok(message, 'the card was sent');
  assert.equal(Boolean(message.rich), rich);
  const head = `<b>Question</b> · <a href="${UI_BASE_URL}/TST/issues/TST-1#interaction-${interaction.id}">TST-1</a> Ship v2`;
  const intro = rich ? '> Pick the target.\n\n' : 'Pick the target.\n\n';
  return { ...world, issue, interaction, message, head, gap: rich ? '\n\n' : '\n', intro };
}

const MODES = [false, true];

// --- the fake knows date-time entities and marked text ---------------------------------------

test('the fake accepts a date-time entity with a valid unix time and refuses one without', async (t) => {
  assert.equal(validateTelegramHtml(`<blockquote><b>Done</b> · ${TIME}</blockquote>`), null);
  assert.equal(validateTelegramHtml('<tg-time unix="1647531900">22:45</tg-time>'), null);
  for (const bad of ['<tg-time>x</tg-time>', '<tg-time format="r">x</tg-time>', '<tg-time unix="soon" format="r">x</tg-time>', '<tg-time unix="" format="r">x</tg-time>', '<tg-time unix="12" format="rr">x</tg-time>', '<tg-time unix="12" zone="utc">x</tg-time>']) {
    assert.match(validateTelegramHtml(bad), /Date-time entity|Unsupported attribute/, bad);
  }
  assert.match(validateTelegramHtml('<tg-time unix="12">x'), /end tag/);

  assert.equal(validateRichMarkdown(marked('<b>Done</b>')), null);
  assert.equal(validateRichMarkdown(`Posted ${RICH_TIME} ago and <tg-time unix="12" format="t">late</tg-time>`), null);
  assert.equal(validateRichMarkdown('==marked text== and ![22:45](tg://time?unix=1647531900&format=wDT)'), null);
  for (const bad of ['![x](tg://time?format=r)', '![x](tg://time?unix=soon&format=r)', '![x](tg://time?unix=12&format=zz)', '<tg-time format="r">x</tg-time>']) {
    assert.match(validateRichMarkdown(bad), /Date-time entity/, bad);
  }
  // Other images stay refused.
  assert.match(validateRichMarkdown('![x](https://example.com/a.png)'), /media/);

  assert.deepEqual(timeEntities(`a ${TIME} b ${RICH_TIME}`), [
    { unix: UNIX, format: 'r', text: '12:34 UTC' },
    { unix: UNIX, format: 'r', text: '12:34 UTC' },
  ]);
});

test('a send or an edit with a date-time entity that has no valid unix time is refused over the wire', async (t) => {
  const { w, bot } = await setup(t, { rich: true });
  const id = await bot.send('<b>Card</b>');
  await assert.rejects(bot.send('<tg-time format="r">now</tg-time>'), (err) => err instanceof TelegramError && /Date-time entity/.test(err.description));
  await assert.rejects(bot.edit(id, '<tg-time unix="x" format="r">now</tg-time>'), (err) => err instanceof TelegramError && /Date-time entity/.test(err.description));
  await assert.rejects(
    bot.tg.sendRichMessage({ chat_id: w.tg.chatId, rich_message: { markdown: '==<b>Done</b> · ![t](tg://time?format=r)==' } }),
    (err) => err instanceof TelegramError && /Date-time entity/.test(err.description),
  );
  await bot.edit(id, `<b>Card</b>\n\n${classic('<b>Done</b>')}`);
  assert.equal(w.tg.messages.get(id).text, `<b>Card</b>\n\n${classic('<b>Done</b>')}`);
});

// --- cards -------------------------------------------------------------------------------------

for (const rich of MODES) {
  const mode = rich ? 'rich' : 'classic';

  test(`${mode}: a confirm card tapped with a custom label ends with Confirmed and the label`, async (t) => {
    const { w, bot, clock, interaction, message, head, gap } = await cardWorld(t, rich, { kind: 'request_confirmation', payload: confirmPayload() });
    const before = `${head}${gap}Deploy the change?`;
    assert.equal(message.text, before);

    clock.at = SETTLED_AT;
    const calls = sends(w);
    await tap(w, bot, message, 'Deploy');
    assert.equal(textOf(w, message), settled(rich, before, '<b>Confirmed</b> · Deploy'));
    assert.deepEqual(w.tg.buttons(message.message_id), []);
    assert.equal(w.tg.callbackAnswers.at(-1).text, 'Confirmed');
    assert.equal(sends(w), calls, 'settling sends nothing new');
    assert.equal(w.tg.messages.get(message.message_id).rich, rich);
    assert.deepEqual(timeEntities(textOf(w, message)), [{ unix: UNIX, format: 'r', text: '12:34 UTC' }]);
    assert.deepEqual([...bot.state.cards.values()][0].outcome, { kind: 'Confirmed', detail: 'Deploy', at: '2026-05-01T12:34:56.000Z' });
    assert.equal(w.pc.interactions.get(interaction.id).status, 'accepted');
  });

  test(`${mode}: a confirm card with a plain Confirm label has no detail`, async (t) => {
    for (const label of ['Confirm', 'confirm', 'Yes', 'OK']) {
      const { w, bot, clock, message, head, gap } = await cardWorld(t, rich, { kind: 'request_confirmation', payload: confirmPayload({ acceptLabel: label }) });
      const before = `${head}${gap}Deploy the change?`;
      clock.at = SETTLED_AT;
      await tap(w, bot, message, label);
      assert.equal(textOf(w, message), settled(rich, before, '<b>Confirmed</b>'), label);
    }
  });

  test(`${mode}: a decline with a reason ends with Declined and the reason, cut to 200`, async (t) => {
    const payload = confirmPayload({ rejectRequiresReason: true, rejectReasonLabel: 'Why hold it?' });
    const { w, bot, clock, message, head, gap } = await cardWorld(t, rich, { kind: 'request_confirmation', payload });
    const before = `${head}${gap}Deploy the change?`;
    await tap(w, bot, message, 'Hold');
    const prompt = w.tg.sent().find((m) => m.markup?.force_reply);
    // While the prompt waits, the card is a live view: no outcome yet.
    assert.equal(textOf(w, message), `${before}\n\nWaiting for the decline reason (reply to the prompt below).`);

    clock.at = SETTLED_AT;
    const calls = sends(w);
    await bot.handleUpdate(w.tg.message('Too risky <before> the & freeze', { replyTo: prompt.message_id }));
    assert.equal(textOf(w, message), settled(rich, before, `<b>Declined</b> · Too risky &lt;before&gt; the &amp; freeze`));
    assert.equal(sends(w), calls);
    assert.deepEqual(w.tg.buttons(message.message_id), []);
    assert.deepEqual(posts(w, '/reject')[0].body, { reason: 'Too risky <before> the & freeze' });
  });

  test(`${mode}: a long decline reason is cut to 200 characters in the outcome`, async (t) => {
    const payload = confirmPayload({ rejectRequiresReason: true });
    const { w, bot, clock, message } = await cardWorld(t, rich, { kind: 'request_confirmation', payload });
    await tap(w, bot, message, 'Hold');
    const prompt = w.tg.sent().find((m) => m.markup?.force_reply);
    clock.at = SETTLED_AT;
    await bot.handleUpdate(w.tg.message('x'.repeat(500), { replyTo: prompt.message_id }));
    assert.ok(textOf(w, message).endsWith(block(rich, `<b>Declined</b> · ${'x'.repeat(199)}…`)));
    assert.equal(posts(w, '/reject')[0].body.reason.length, 500, 'Paperclip gets the whole reason');
  });

  test(`${mode}: a decline without a reason shows the decline label unless it only repeats the kind`, async (t) => {
    const named = await cardWorld(t, rich, { kind: 'request_confirmation', payload: confirmPayload() });
    named.clock.at = SETTLED_AT;
    await tap(named.w, named.bot, named.message, 'Hold');
    assert.equal(textOf(named.w, named.message), settled(rich, `${named.head}${named.gap}Deploy the change?`, '<b>Declined</b> · Hold'));

    for (const label of ['Decline', 'No']) {
      const plain = await cardWorld(t, rich, { kind: 'request_confirmation', payload: confirmPayload({ rejectLabel: label }) });
      plain.clock.at = SETTLED_AT;
      await tap(plain.w, plain.bot, plain.message, label);
      assert.equal(textOf(plain.w, plain.message), settled(rich, `${plain.head}${plain.gap}Deploy the change?`, '<b>Declined</b>'), label);
    }
  });

  test(`${mode}: a single-choice question tapped ends with Answered and the option`, async (t) => {
    const payload = questionsPayload([choiceQuestion('env', 'Which environment?', ['Staging', 'Production'])]);
    const { w, bot, clock, message, head, intro } = await cardWorld(t, rich, { kind: 'ask_user_questions', payload });
    const before = `${head}\n\n${intro}Which environment?`;
    assert.equal(message.text, before);

    clock.at = SETTLED_AT;
    const calls = sends(w);
    await tap(w, bot, message, 'Production');
    // The outcome line names the answer, so the card no longer shows it under the question.
    assert.equal(textOf(w, message), settled(rich, before, '<b>Answered</b> · Production'));
    assert.equal(textOf(w, message).split('Production').length - 1, 1, 'the answer is said once');
    assert.deepEqual(w.tg.buttons(message.message_id), []);
    assert.equal(w.tg.callbackAnswers.at(-1).text, 'Answered');
    assert.equal(sends(w), calls);
  });

  test(`${mode}: a form with several questions keeps each answer under its question and the outcome has no detail`, async (t) => {
    const payload = questionsPayload([
      choiceQuestion('env', 'Which environment?', ['Staging', 'Production']),
      choiceQuestion('regions', 'Which regions?', ['EU', 'US', 'Asia'], { multi: true }),
      textQuestion('why', 'Why now?', { required: false }),
    ]);
    const { w, bot, clock, message } = await cardWorld(t, rich, { kind: 'ask_user_questions', payload });
    await tap(w, bot, message, '1 · Production');
    await tap(w, bot, message, '2 · EU');
    await tap(w, bot, message, '2 · Asia');
    await bot.handleUpdate(w.tg.message('Because the freeze ends', { replyTo: message.message_id }));
    assert.equal(posts(w, '/respond').length, 0, 'nothing is sent before Submit');
    assert.ok(!textOf(w, message).includes('tg-time') && !textOf(w, message).includes('=='));

    clock.at = SETTLED_AT;
    const calls = sends(w);
    await tap(w, bot, message, 'Submit');
    const after = textOf(w, message);
    assert.ok(after.endsWith(`\n\n${block(rich, '<b>Answered</b>')}`), after);
    for (const answer of ['Answer: Production', 'Answer: EU, Asia', 'Answer: “Because the freeze ends”']) assert.ok(after.includes(answer), answer);
    assert.equal(after.split('Production').length - 1, 1, 'each answer is said once');
    assert.ok(!after.includes('Reply to this message'), 'the reply hint is gone');
    assert.deepEqual(w.tg.buttons(message.message_id), []);
    assert.equal(sends(w), calls);
    assert.equal(posts(w, '/respond').length, 1);
  });

  test(`${mode}: a form closed before it was sent keeps the options picked so far`, async (t) => {
    const payload = questionsPayload([choiceQuestion('regions', 'Which regions?', ['EU', 'US'], { multi: true })]);
    const { w, bot, clock, interaction, message } = await cardWorld(t, rich, { kind: 'ask_user_questions', payload });
    await tap(w, bot, message, 'EU');
    w.pc.resolveElsewhere(interaction.id, 'expired', { version: 1, outcome: 'superseded_by_comment' });
    clock.at = SETTLED_AT;
    await bot.pollOnce();
    const after = textOf(w, message);
    assert.ok(after.includes('Answer: EU'), after);
    assert.ok(after.endsWith(`\n\n${block(rich, '<b>Closed</b> · replaced by a comment')}`), after);
  });

  test(`${mode}: an answer that is only written has no detail`, async (t) => {
    const payload = questionsPayload([textQuestion('why', 'What is the reason?')]);
    const { w, bot, clock, message } = await cardWorld(t, rich, { kind: 'ask_user_questions', payload });
    clock.at = SETTLED_AT;
    await bot.handleUpdate(w.tg.message('Because I said so', { replyTo: message.message_id }));
    assert.ok(textOf(w, message).endsWith(`\n\n${block(rich, '<b>Answered</b>')}`), textOf(w, message));
  });

  test(`${mode}: picked labels are cut to 120 characters`, async (t) => {
    const labels = ['A'.repeat(70), 'B'.repeat(70)];
    const payload = questionsPayload([choiceQuestion('pick', 'Pick any', labels, { multi: true })]);
    const { w, bot, clock, message } = await cardWorld(t, rich, { kind: 'ask_user_questions', payload });
    await tap(w, bot, message, 'A');
    await tap(w, bot, message, 'B');
    clock.at = SETTLED_AT;
    await tap(w, bot, message, 'Submit');
    assert.ok(textOf(w, message).endsWith(block(rich, `<b>Answered</b> · ${'A'.repeat(70)}, ${'B'.repeat(47)}…`)), textOf(w, message));
  });

  test(`${mode}: a checkbox card lists the chosen options`, async (t) => {
    const payload = confirmPayload({ options: [{ id: 'a', label: 'Docs' }, { id: 'b', label: 'Tests' }, { id: 'c', label: 'Release notes' }], acceptLabel: 'Go' });
    const { w, bot, clock, message, head, gap } = await cardWorld(t, rich, { kind: 'request_checkbox_confirmation', payload });
    await tap(w, bot, message, 'Docs');
    await tap(w, bot, message, 'Release notes');
    clock.at = SETTLED_AT;
    await tap(w, bot, message, 'Go');
    assert.equal(textOf(w, message), settled(rich, `${head}${gap}Deploy the change?`, '<b>Confirmed</b> · Docs, Release notes'));
    assert.deepEqual(posts(w, '/accept')[0].body, { selectedOptionIds: ['a', 'c'] });
  });

  test(`${mode}: a card answered in Paperclip shows the answer from the result`, async (t) => {
    const payload = questionsPayload([choiceQuestion('env', 'Which environment?', ['Staging', 'Production'])]);
    const { w, bot, clock, interaction, message, head, intro } = await cardWorld(t, rich, { kind: 'ask_user_questions', payload });
    w.pc.resolveElsewhere(interaction.id, 'answered', { version: 1, answers: [{ questionId: 'env', optionIds: ['env-opt2'] }], summaryMarkdown: null });
    clock.at = SETTLED_AT;
    const calls = sends(w);
    await bot.pollOnce();
    assert.equal(textOf(w, message), settled(rich, `${head}\n\n${intro}Which environment?`, '<b>Answered in Paperclip</b> · Production'));
    assert.deepEqual(w.tg.buttons(message.message_id), []);
    assert.equal(sends(w), calls, 'settling elsewhere sends nothing new either');
    assert.deepEqual([...bot.state.cards.values()][0].outcome, { kind: 'Answered in Paperclip', detail: 'Production', at: '2026-05-01T12:34:56.000Z' });
  });

  test(`${mode}: a confirm card settled in Paperclip says Confirmed or Declined in Paperclip with the reason`, async (t) => {
    const accepted = await cardWorld(t, rich, { kind: 'request_confirmation', payload: confirmPayload() });
    accepted.w.pc.resolveElsewhere(accepted.interaction.id, 'accepted');
    accepted.clock.at = SETTLED_AT;
    await accepted.bot.pollOnce();
    assert.equal(textOf(accepted.w, accepted.message), settled(rich, `${accepted.head}${accepted.gap}Deploy the change?`, '<b>Confirmed in Paperclip</b>'));

    const rejected = await cardWorld(t, rich, { kind: 'request_confirmation', payload: confirmPayload() });
    rejected.w.pc.resolveElsewhere(rejected.interaction.id, 'rejected', { version: 1, outcome: 'rejected', reason: 'Not this week' });
    rejected.clock.at = SETTLED_AT;
    await rejected.bot.pollOnce();
    assert.equal(textOf(rejected.w, rejected.message), settled(rich, `${rejected.head}${rejected.gap}Deploy the change?`, '<b>Declined in Paperclip</b> · Not this week'));
  });

  test(`${mode}: a checkbox card accepted in Paperclip lists the options of the result`, async (t) => {
    const payload = confirmPayload({ options: [{ id: 'a', label: 'Docs' }, { id: 'b', label: 'Tests' }] });
    const { w, bot, clock, interaction, message, head, gap } = await cardWorld(t, rich, { kind: 'request_checkbox_confirmation', payload });
    w.pc.resolveElsewhere(interaction.id, 'accepted', { version: 1, outcome: 'accepted', selectedOptionIds: ['b'] });
    clock.at = SETTLED_AT;
    await bot.pollOnce();
    assert.equal(textOf(w, message), settled(rich, `${head}${gap}Deploy the change?`, '<b>Confirmed in Paperclip</b> · Tests'));
  });

  test(`${mode}: a card replaced by a comment, expired or on a closed task says Closed with why`, async (t) => {
    const cases = [
      ['replaced by a comment', 'expired', { version: 1, outcome: 'superseded_by_comment' }],
      ['task closed', 'expired', { version: 1, outcome: 'issue_closed' }],
      ['expired', 'expired', { version: 1, outcome: 'stale_target' }],
      [null, 'cancelled', { version: 1, outcome: 'withdrawn' }],
    ];
    for (const [detail, status, result] of cases) {
      const { w, bot, clock, interaction, message, head, gap } = await cardWorld(t, rich, { kind: 'request_confirmation', payload: confirmPayload() });
      w.pc.resolveElsewhere(interaction.id, status, result);
      clock.at = SETTLED_AT;
      await bot.pollOnce();
      assert.equal(textOf(w, message), settled(rich, `${head}${gap}Deploy the change?`, `<b>Closed</b>${detail ? ` · ${detail}` : ''}`), String(detail));
    }
  });

  test(`${mode}: a question replaced by a comment keeps the reason in expirationReason`, async (t) => {
    const payload = questionsPayload([choiceQuestion('env', 'Which environment?', ['Staging', 'Production'])]);
    const { w, bot, clock, interaction, message, head, intro } = await cardWorld(t, rich, { kind: 'ask_user_questions', payload });
    w.pc.resolveElsewhere(interaction.id, 'expired', { version: 1, answers: [], expirationReason: 'superseded_by_comment' });
    clock.at = SETTLED_AT;
    await bot.pollOnce();
    assert.equal(textOf(w, message), settled(rich, `${head}\n\n${intro}Which environment?`, '<b>Closed</b> · replaced by a comment'));
  });

  test(`${mode}: a card whose task is closed in Paperclip says Closed with task closed`, async (t) => {
    const { w, bot, clock, issue, message, head, gap } = await cardWorld(t, rich, { kind: 'request_confirmation', payload: confirmPayload() });
    w.pc.setStatus(issue.id, 'cancelled');
    clock.at = SETTLED_AT;
    await bot.pollOnce();
    assert.equal(textOf(w, message), settled(rich, `${head}${gap}Deploy the change?`, '<b>Closed</b> · task closed'));
  });
}

test('classic: a card settled in Paperclip shows the time Paperclip recorded, never a later one', async (t) => {
  const recorded = Date.parse('2026-05-01T12:30:00Z');
  for (const [resolvedAt, shownMs] of [['2026-05-01T12:30:00.000Z', recorded], ['2026-05-01T13:30:00.000Z', Date.parse('2026-05-01T13:00:00Z')], ['not a time', Date.parse('2026-05-01T13:00:00Z')]]) {
    const { w, bot, clock, interaction, message, head, gap } = await cardWorld(t, false, { kind: 'request_confirmation', payload: confirmPayload() });
    w.pc.resolveElsewhere(interaction.id, 'accepted');
    w.pc.interactions.get(interaction.id).resolvedAt = resolvedAt;
    clock.at = Date.parse('2026-05-01T13:00:00Z');
    await bot.pollOnce();
    const shown = new Date(shownMs).toISOString().slice(11, 16);
    assert.equal(
      textOf(w, message),
      `${head}${gap}Deploy the change?\n\n<blockquote><b>Confirmed in Paperclip</b> · <tg-time unix="${shownMs / 1000}" format="r">${shown} UTC</tg-time></blockquote>`,
      resolvedAt,
    );
  }
});

// --- size limit --------------------------------------------------------------------------------

test('fitSettled drops the outcome detail before it leaves a level, and only then shortens the text', () => {
  const build = (item, level) => `${'x'.repeat(level)}${item.outcome ? `|${item.outcome.detail ?? ''}` : ''}`;
  const settledItem = { outcome: { kind: 'K', detail: 'dddd', at: '2026-05-01T12:00:00.000Z' } };
  assert.equal(fitSettled(build, [10, 5], 20, settledItem), 'xxxxxxxxxx|dddd');
  assert.equal(fitSettled(build, [10, 5], 12, settledItem), 'xxxxxxxxxx|');
  assert.equal(fitSettled(build, [10, 5], 10, settledItem), 'xxxxx|dddd');
  assert.equal(fitSettled(build, [10, 5], 10, {}), 'xxxxxxxxxx');
  assert.throws(() => fitSettled(build, [10, 5], 3, settledItem), /does not fit/);
});

// A form of 20 questions whose pending text is `room` characters short of the alert limit.
async function nearLimitForm(t, room) {
  const form = (lengths) => questionsPayload(lengths.map((length, i) => choiceQuestion(`q${i}`, 'x'.repeat(length), ['Yes', 'No'])));
  const probe = await cardWorld(t, false, { kind: 'ask_user_questions', payload: form(Array(20).fill(100)) });
  const spare = ALERT_LIMIT - room - probe.message.text.length + 20 * 100;
  assert.ok(spare / 20 <= 200, 'the questions can be that long');
  const lengths = Array.from({ length: 20 }, (_, i) => Math.floor(spare / 20) + (i < spare % 20 ? 1 : 0));
  const world = await cardWorld(t, false, { kind: 'ask_user_questions', payload: form(lengths) });
  assert.equal(world.message.text.length, ALERT_LIMIT - room);
  return world;
}

test('classic: a card close to the size limit keeps all its text when it is settled and drops the answer detail instead', async (t) => {
  const { w, bot, clock, interaction, message } = await nearLimitForm(t, 130);
  const pending = message.text;
  assert.ok(!pending.includes('…'), 'nothing of the pending card was cut');

  const answers = Array.from({ length: 20 }, (_, i) => ({ questionId: `q${i}`, optionIds: [`q${i}-opt1`] }));
  w.pc.resolveElsewhere(interaction.id, 'answered', { version: 1, answers });
  clock.at = SETTLED_AT;
  await bot.pollOnce();
  assert.equal(textOf(w, message), `${pending}\n\n${classic('<b>Answered in Paperclip</b>')}`);
  assert.ok(textOf(w, message).length <= ALERT_LIMIT);
});

test('classic: a card with room for the whole outcome keeps its detail', async (t) => {
  const { w, bot, clock, interaction, message } = await nearLimitForm(t, 400);
  const pending = message.text;
  w.pc.resolveElsewhere(interaction.id, 'answered', { version: 1, answers: [{ questionId: 'q0', optionIds: ['q0-opt2'] }] });
  clock.at = SETTLED_AT;
  await bot.pollOnce();
  assert.equal(textOf(w, message), `${pending}\n\n${classic('<b>Answered in Paperclip</b> · No')}`);
});

// --- inbox items -------------------------------------------------------------------------------

const startsWith = (w, head) => w.tg.sent().find((m) => m.text.replace(/<a href="[^"]*">|<\/a>/g, '').startsWith(head));

test('classic: an approval that is approved ends with Approved', async (t) => {
  const { w, bot, clock } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Staffing', status: 'in_progress' });
  const approval = w.pc.addApproval({ type: 'hire_agent', issueId: issue.id, payload: { title: 'Hire a designer' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  const beforeText = message.text;

  await tap(w, bot, message, 'Approve');
  clock.at = SETTLED_AT;
  const calls = sends(w);
  await tap(w, bot, message, 'Tap again to confirm');
  assert.equal(textOf(w, message), settled(false, beforeText, '<b>Approved</b>'));
  assert.deepEqual(w.tg.buttons(message.message_id), []);
  assert.equal(sends(w), calls);
  assert.equal(w.pc.approvals.get(approval.id).status, 'approved');
  assert.deepEqual([...bot.state.inbox.values()][0].outcome, { kind: 'Approved', detail: null, at: '2026-05-01T12:34:56.000Z' });
});

test('classic: an approval that is rejected ends with Rejected', async (t) => {
  const { w, bot, clock } = await setup(t);
  w.pc.addApproval({ type: 'budget_override_required', payload: { title: 'More budget' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  const beforeText = message.text;
  await tap(w, bot, message, 'Reject');
  clock.at = SETTLED_AT;
  await tap(w, bot, message, 'Tap again to confirm');
  assert.equal(textOf(w, message), settled(false, beforeText, '<b>Rejected</b>'));
});

for (const rich of MODES) {
  test(`${rich ? 'rich' : 'classic'}: a decision that is decided ends with Decided and the option`, async (t) => {
    const { w, bot, clock } = await setup(t, { rich });
    const issue = w.pc.addIssue({ title: 'Pick a stack', status: 'in_progress' });
    const decision = w.pc.addDecision({
      issueId: issue.id,
      title: 'Database choice',
      body: 'Which database should we use?',
      options: [
        { id: 'pg', label: 'Postgres', description: 'Reliable and boring', effects: [] },
        { id: 'lite', label: 'SQLite', effects: [] },
      ],
    });
    await bot.pollOnce();
    const message = startsWith(w, '<b>Decision</b>');
    assert.equal(Boolean(message.rich), rich);
    assert.ok(message.text.includes(`decisionId=${decision.id}`) && message.text.includes('Which database should we use?'));
    const beforeText = message.text;

    clock.at = SETTLED_AT;
    const calls = sends(w);
    await tap(w, bot, message, 'SQLite');
    assert.equal(textOf(w, message), settled(rich, beforeText, '<b>Decided</b> · SQLite'));
    assert.equal(w.tg.callbackAnswers.at(-1).text, 'Decided: SQLite');
    assert.equal(sends(w), calls);
    assert.equal(w.tg.messages.get(message.message_id).rich, rich);
    assert.deepEqual(w.tg.buttons(message.message_id), []);
  });
}

test('classic: a stalled review that is sent back ends with Sent back; Approve and Request changes have their own kinds', async (t) => {
  for (const [label, kind] of [['Send back', 'Sent back'], ['Approve', 'Approved']]) {
    const { w, bot, clock } = await setup(t);
    const issue = w.pc.addIssue({ title: 'Stuck in review', status: 'in_progress' });
    await bot.pollOnce();
    w.pc.setStatus(issue.id, 'in_review');
    w.pc.addReview(issue.id, { stalled: true });
    await bot.pollOnce();
    const message = startsWith(w, '<b>Review</b>');
    const beforeText = message.text;
    await tap(w, bot, message, label);
    clock.at = SETTLED_AT;
    const calls = sends(w);
    await tap(w, bot, message, 'Tap again to confirm');
    assert.equal(textOf(w, message), settled(false, beforeText, `<b>${kind}</b>`), label);
    assert.equal(sends(w), calls);
  }

  const { w, bot, clock } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Stuck in review', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  w.pc.addReview(issue.id, { stalled: true });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Review</b>');
  const beforeText = message.text;
  await tap(w, bot, message, 'Request changes');
  const prompt = w.tg.sent().find((m) => m.markup?.force_reply);
  clock.at = SETTLED_AT;
  await bot.handleUpdate(w.tg.message('Add tests', { replyTo: prompt.message_id }));
  assert.equal(textOf(w, message), settled(false, beforeText, '<b>Changes requested</b>'));
});

test('classic: an item settled in Paperclip, or dismissed, is Resolved in Paperclip or Dismissed', async (t) => {
  const { w, bot, clock } = await setup(t);
  const join = w.pc.addJoinRequest({ name: 'Newcomer' });
  await bot.pollOnce();
  const message = w.tg.lastMessage();
  const beforeText = message.text;
  join.close();
  clock.at = SETTLED_AT;
  const calls = sends(w);
  await bot.pollOnce();
  assert.equal(textOf(w, message), settled(false, beforeText, '<b>Resolved in Paperclip</b>'));
  assert.equal(sends(w), calls);

  const second = await setup(t);
  second.w.pc.addDecision({ issueId: second.w.pc.addIssue({ title: 'T', status: 'in_progress' }).id, title: 'Pick', body: 'Which?', options: [{ id: 'a', label: 'A', effects: [] }] });
  await second.bot.pollOnce();
  const decision = startsWith(second.w, '<b>Decision</b>');
  const decisionText = decision.text;
  second.clock.at = SETTLED_AT;
  await tap(second.w, second.bot, decision, 'Dismiss');
  assert.equal(textOf(second.w, decision), settled(false, decisionText, '<b>Dismissed</b>'));
});

// --- offers ------------------------------------------------------------------------------------

const OFFER = 'Create a task from this?';

async function offerWorld(t, options) {
  const world = await setup(t);
  const { w, bot } = world;
  w.pc.addAgent({ name: 'Dev' });
  const project = options?.project ? w.pc.addProject({ name: options.project }) : null;
  await bot.handleUpdate(w.tg.message('Fix the login page'));
  const offer = w.tg.lastMessage();
  return { ...world, offer, project };
}

test('an offer that is created keeps its text and ends with Created, the linked task and who and where', async (t) => {
  const { w, bot, clock, offer } = await offerWorld(t, { project: 'Web' });
  assert.equal(offer.text, OFFER);

  await tap(w, bot, offer, 'Other agent');
  await tap(w, bot, offer, 'Dev');
  await tap(w, bot, offer, 'For Dev');
  assert.equal(textOf(w, offer), `${OFFER}\n\nWhich project?`, 'the question goes below the offer text');
  assert.ok(!textOf(w, offer).includes('tg-time'));

  clock.at = SETTLED_AT;
  const calls = sends(w);
  await tap(w, bot, offer, 'Web');
  const link = `<a href="${UI_BASE_URL}/TST/issues/TST-1">TST-1</a>`;
  assert.equal(textOf(w, offer), settled(false, OFFER, `<b>Created</b> · ${link} for Dev in Web`));
  assert.deepEqual(w.tg.buttons(offer.message_id), []);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Created');
  assert.equal(sends(w) - calls, 1, 'only the task view that creating a task has always sent');
});

test('an offer that is created without a project ends with who only', async (t) => {
  const { w, bot, clock, offer } = await offerWorld(t);
  clock.at = SETTLED_AT;
  await tap(w, bot, offer, 'For Lead');
  const link = `<a href="${UI_BASE_URL}/TST/issues/TST-1">TST-1</a>`;
  assert.equal(textOf(w, offer), settled(false, OFFER, `<b>Created</b> · ${link} for Lead`));
});

test('an offer with a file has the attach line under the outcome', async (t) => {
  const { w, bot, clock } = await setup(t);
  const file = w.tg.addFile({ name: 'spec.pdf', data: 'SPEC' });
  await bot.handleUpdate(w.tg.documentUpdate(file, { caption: 'Review the spec', mime: 'application/pdf' }));
  const offer = w.tg.lastMessage();
  clock.at = SETTLED_AT;
  await tap(w, bot, offer, 'For Lead');
  const link = `<a href="${UI_BASE_URL}/TST/issues/TST-1">TST-1</a>`;
  assert.equal(textOf(w, offer), `${settled(false, OFFER, `<b>Created</b> · ${link} for Lead`)}\nAttached: spec.pdf`);
});

test('an offer that is cancelled keeps its text and ends with Cancelled', async (t) => {
  const { w, bot, clock, offer } = await offerWorld(t);
  clock.at = SETTLED_AT;
  const calls = sends(w);
  await tap(w, bot, offer, 'Cancel');
  assert.equal(textOf(w, offer), settled(false, OFFER, '<b>Cancelled</b>'));
  assert.deepEqual(w.tg.buttons(offer.message_id), []);
  assert.equal(sends(w), calls);
  assert.equal(bot.state.offers.size, 0);
});

test('an offer cancelled from the project question drops the question and keeps the offer text', async (t) => {
  const { w, bot, clock, offer } = await offerWorld(t, { project: 'Web' });
  await tap(w, bot, offer, 'For Lead');
  assert.equal(textOf(w, offer), `${OFFER}\n\nWhich project?`);
  clock.at = SETTLED_AT;
  await tap(w, bot, offer, 'Cancel');
  assert.equal(textOf(w, offer), settled(false, OFFER, '<b>Cancelled</b>'));
});

test('an offer that has expired keeps its text and ends with Expired', async (t) => {
  const { w, bot, clock, offer } = await offerWorld(t);
  const [, saved] = [...bot.state.offers][0];
  clock.at = SETTLED_AT;
  saved.at = SETTLED_AT - 25 * 60 * 60 * 1000;
  const calls = sends(w);
  await tap(w, bot, offer, 'For Lead');
  assert.equal(textOf(w, offer), settled(false, OFFER, '<b>Expired</b>'));
  assert.deepEqual(w.tg.buttons(offer.message_id), []);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This offer has expired');
  assert.equal(sends(w), calls);
});

test('taps that were queued before an offer was settled do not overwrite its outcome', async (t) => {
  for (const settle of ['For Lead', 'Cancel']) {
    const { w, bot, clock, offer } = await offerWorld(t);
    clock.at = SETTLED_AT;
    const queued = ['For Lead', 'Cancel', 'For Lead'].map((label) => w.tg.tapButton(offer.message_id, label));
    await bot.handleUpdate(w.tg.tapButton(offer.message_id, settle));
    const done = textOf(w, offer);
    assert.match(done, settle === 'Cancel' ? /<b>Cancelled<\/b>/ : /<b>Created<\/b>/);
    const count = edits(w);
    for (const update of queued) await bot.handleUpdate(update);
    assert.equal(textOf(w, offer), done, settle);
    assert.equal(edits(w), count, settle);
    assert.equal(w.tg.callbackAnswers.at(-1).text, 'This offer has expired');
  }
});

test('a second tap on a settled offer changes nothing', async (t) => {
  const { w, bot, clock, offer } = await offerWorld(t);
  clock.at = SETTLED_AT;
  await tap(w, bot, offer, 'Cancel');
  const done = textOf(w, offer);
  const count = edits(w);
  await bot.handleUpdate(w.tg.tap(offer.message_id, 'O:y:1'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This offer has expired');
  assert.equal(textOf(w, offer), done);
  assert.equal(edits(w), count);
});

test('the /new project question keeps its text when it is settled', async (t) => {
  const { w, bot, clock } = await setup(t);
  w.pc.addProject({ name: 'Web' });
  await bot.handleUpdate(w.tg.message('/new Draw the logo'));
  const question = w.tg.lastMessage();
  assert.equal(question.text, 'Which project?');
  clock.at = SETTLED_AT;
  await tap(w, bot, question, 'Web');
  const link = `<a href="${UI_BASE_URL}/TST/issues/TST-1">TST-1</a>`;
  assert.equal(textOf(w, question), settled(false, 'Which project?', `<b>Created</b> · ${link} for Lead in Web`));
});

test('an offer saved by an older version, without its text, is settled with the text it shows', async (t) => {
  const { w, bot, clock, offer } = await offerWorld(t);
  const [, saved] = [...bot.state.offers][0];
  delete saved.prompt;
  bot.state.save();
  const restarted = w.makeBot({ now: () => clock.at });
  clock.at = SETTLED_AT;
  await restarted.handleUpdate(w.tg.tapButton(offer.message_id, 'Cancel'));
  assert.equal(textOf(w, offer), settled(false, OFFER, '<b>Cancelled</b>'));
});

// --- state from an older version and live views ------------------------------------------------

test('a card saved with a plain resolution line still renders it highlighted, with no time', async (t) => {
  const { w, bot, message, head, gap } = await cardWorld(t, false, { kind: 'request_confirmation', payload: confirmPayload() });
  const card = [...bot.state.cards.values()][0];
  Object.assign(card, { status: 'resolved', resolvedAt: new Date().toISOString(), resolution: 'Declined: Too risky' });
  delete card.outcome;
  bot.state.save();

  const restarted = w.makeBot();
  assert.equal([...restarted.state.cards.values()][0].resolution, 'Declined: Too risky');
  await restarted.handleUpdate(w.tg.tapButton(message.message_id, 'Deploy'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already answered or closed');
  assert.equal(textOf(w, message), `${head}${gap}Deploy the change?\n\n<blockquote>Declined: Too risky</blockquote>`);
});

test('a rich card saved with a plain resolution line renders it as marked text', async (t) => {
  const { w, bot, message, head } = await cardWorld(t, true, { kind: 'request_confirmation', payload: confirmPayload() });
  const card = [...bot.state.cards.values()][0];
  Object.assign(card, { status: 'resolved', resolvedAt: new Date().toISOString(), resolution: 'Confirmed' });
  delete card.outcome;
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Deploy'));
  assert.equal(textOf(w, message), `${head}\n\nDeploy the change?\n\n==Confirmed==`);
  assert.equal(validateRichMarkdown(textOf(w, message)), null);
});

test('an inbox item saved with a plain resolution line still renders it', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addApproval({ type: 'hire_agent', payload: { title: 'Hire' } });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  const beforeText = message.text;
  const record = [...bot.state.inbox.values()][0];
  Object.assign(record, { status: 'resolved', resolvedAt: new Date().toISOString(), resolution: 'Approved' });
  delete record.outcome;
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Approve'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already resolved');
  assert.equal(textOf(w, message), `${beforeText}\n\n<blockquote>Approved</blockquote>`);
});

test('live views get no outcome: an armed button, a task view and the redraws around them', async (t) => {
  const { w, bot } = await setup(t);
  w.pc.addApproval({ type: 'hire_agent', payload: { title: 'Hire' } });
  const issue = w.pc.addIssue({ title: 'Plan', status: 'in_progress' });
  await bot.pollOnce();
  const message = startsWith(w, '<b>Approval</b>');
  await tap(w, bot, message, 'Approve');
  assert.deepEqual(w.tg.buttons(message.message_id).map((b) => b.text), ['Tap again to confirm', 'Reject']);

  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  const view = w.tg.lastMessage();
  await tap(w, bot, view, 'Done');
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Refresh');
  for (const shown of w.tg.sent()) {
    assert.ok(!shown.text.includes('tg-time') && !shown.text.includes('<blockquote><b>') && !/^==/m.test(shown.text), shown.text);
  }
});
