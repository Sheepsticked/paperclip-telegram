import assert from 'node:assert/strict';
import test from 'node:test';
import { choiceQuestion, confirmPayload, questionsPayload, startWorld, textQuestion, UI_BASE_URL } from './helpers.js';

// One issue with one pending card, already sent to the fake chat.
async function cardWorld(t, { kind, payload, title = 'Ship v2' }) {
  const w = await startWorld();
  t.after(() => w.close());
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title, status: 'in_review', assigneeAgentId: 'agent-1' });
  const interaction = w.pc.addInteraction(issue.id, { kind, payload });
  await bot.pollOnce();
  const message = w.tg.findMessage(issue.identifier);
  assert.ok(message, 'card message was sent');
  return { w, bot, issue, interaction, message };
}

const posts = (w, suffix) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));
const TASK_BUTTON = 'Open task';
// The answer buttons of a card; the trailing task button is checked on its own.
const labels = (w, message) => w.tg.buttons(message.message_id).map((b) => b.text).filter((text) => text !== TASK_BUTTON);
// Every button's label mapped to its style (null when it has none).
const styles = (w, message) => Object.fromEntries(w.tg.buttons(message.message_id).map((b) => [b.text, b.style ?? null]));

test('confirmation card reads Question, links the task id to the card and has coloured buttons', async (t) => {
  const { w, issue, interaction, message } = await cardWorld(t, { kind: 'request_confirmation', payload: confirmPayload() });
  const link = `<a href="${UI_BASE_URL}/TST/issues/${issue.identifier}#interaction-${interaction.id}">${issue.identifier}</a>`;
  assert.equal(message.text, `<b>Question</b> · ${link} Ship v2\nDeploy the change?`);
  assert.ok(!message.text.includes('Open in Paperclip'));
  assert.deepEqual(labels(w, message), ['Deploy', 'Hold']);
  assert.deepEqual(styles(w, message), { Deploy: 'success', Hold: 'danger', [TASK_BUTTON]: null });
  for (const button of w.tg.buttons(message.message_id)) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
});

test('a pending card ends with a task button that opens the task', async (t) => {
  const { w, issue, message } = await cardWorld(t, { kind: 'request_confirmation', payload: confirmPayload() });
  const rows = message.markup.inline_keyboard;
  assert.deepEqual(rows.at(-1), [{ text: TASK_BUTTON, callback_data: `T:v:${issue.id}` }]);
});

test('confirmation accept: calls accept, drops the keyboard and closes the card', async (t) => {
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'request_confirmation', payload: confirmPayload() });
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Deploy'));

  const accepts = posts(w, '/accept');
  assert.equal(accepts.length, 1);
  assert.deepEqual(accepts[0].body, {});
  assert.equal(w.pc.interactions.get(interaction.id).status, 'accepted');
  assert.deepEqual(w.tg.buttons(message.message_id), []);
  assert.match(w.tg.messages.get(message.message_id).text, /^Confirmed$/m);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Confirmed');
});

test('confirmation decline without a required reason rejects at once', async (t) => {
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'request_confirmation', payload: confirmPayload() });
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Hold'));
  assert.deepEqual(posts(w, '/reject')[0].body, {});
  assert.equal(w.pc.interactions.get(interaction.id).status, 'rejected');
  assert.match(w.tg.messages.get(message.message_id).text, /^Declined$/m);
});

test('decline with a required reason asks for it and sends the reply as the reason', async (t) => {
  const payload = confirmPayload({ rejectRequiresReason: true, rejectReasonLabel: 'Why hold it?' });
  const { w, bot, issue, interaction, message } = await cardWorld(t, { kind: 'request_confirmation', payload });

  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Hold'));
  assert.equal(posts(w, '/reject').length, 0, 'nothing is rejected before the reason arrives');
  const prompt = w.tg.sent().find((m) => m.markup?.force_reply);
  assert.ok(prompt, 'a force-reply prompt was sent');
  assert.match(prompt.text, /Why hold it\?/);
  assert.equal(prompt.replyTo, message.message_id);

  // A second tap does not open a second prompt.
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Hold'));
  assert.equal(w.tg.sent().filter((m) => m.markup?.force_reply).length, 1);
  assert.match(w.tg.callbackAnswers.at(-1).text, /reason prompt/i);

  await bot.handleUpdate(w.tg.message('Too risky before the freeze', { replyTo: prompt.message_id }));
  const rejects = posts(w, '/reject');
  assert.equal(rejects.length, 1);
  assert.deepEqual(rejects[0].body, { reason: 'Too risky before the freeze' });
  assert.equal(w.pc.interactions.get(interaction.id).status, 'rejected');
  assert.equal(posts(w, '/comments').length, 0, 'the reason is not also posted as a comment');
  assert.deepEqual(w.tg.buttons(message.message_id), []);
  assert.match(w.tg.messages.get(message.message_id).text, /^Declined: Too risky before the freeze$/m);
  assert.ok(issue);
});

test('single-question form submits on tap and sends no otherText', async (t) => {
  const payload = questionsPayload([choiceQuestion('env', 'Which environment?', ['Staging', 'Production'])]);
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'ask_user_questions', payload });
  assert.deepEqual(labels(w, message), ['Staging', 'Production']);

  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Production'));
  const responds = posts(w, '/respond');
  assert.equal(responds.length, 1);
  assert.deepEqual(responds[0].body, { answers: [{ questionId: 'env', optionIds: ['env-opt2'] }] });
  assert.equal('otherText' in responds[0].body.answers[0], false);
  assert.equal(w.pc.interactions.get(interaction.id).status, 'answered');
  assert.deepEqual(w.tg.buttons(message.message_id), []);
  assert.match(w.tg.messages.get(message.message_id).text, /^Answered$/m);
});

test('single text question: the reply is submitted as otherText', async (t) => {
  const payload = questionsPayload([textQuestion('why', 'What is the reason?')]);
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'ask_user_questions', payload });
  assert.deepEqual(labels(w, message), []);
  assert.match(message.text, /Reply to this message/);

  await bot.handleUpdate(w.tg.message('Because of the audit', { replyTo: message.message_id }));
  assert.deepEqual(posts(w, '/respond')[0].body, {
    answers: [{ questionId: 'why', optionIds: [], otherText: 'Because of the audit' }],
  });
  assert.equal(w.pc.interactions.get(interaction.id).status, 'answered');
  assert.equal(posts(w, '/comments').length, 0);
});

test('multi-question form: choices, a multi choice and a text reply go out in one respond body', async (t) => {
  const payload = questionsPayload([
    choiceQuestion('region', 'Which region?', ['EU', 'US']),
    choiceQuestion('features', 'Which features?', ['Alpha', 'Beta', 'Gamma'], { multi: true }),
    textQuestion('notes', 'Notes'),
  ]);
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'ask_user_questions', payload });
  const id = message.message_id;
  assert.deepEqual(labels(w, message), ['1 · EU', '1 · US', '2 · Alpha', '2 · Beta', '2 · Gamma', 'Submit']);
  assert.equal(styles(w, message).Submit, 'success');

  await bot.handleUpdate(w.tg.tapButton(id, 'EU'));
  await bot.handleUpdate(w.tg.tapButton(id, 'Gamma'));
  await bot.handleUpdate(w.tg.tapButton(id, 'Alpha'));
  assert.equal(posts(w, '/respond').length, 0, 'a multi-question form waits for Submit');
  assert.deepEqual(labels(w, message).slice(0, 5), ['✓ 1 · EU', '1 · US', '✓ 2 · Alpha', '2 · Beta', '✓ 2 · Gamma']);
  assert.equal(styles(w, message)['✓ 1 · EU'], 'primary');
  assert.equal(styles(w, message)['1 · US'], null);

  // The text question is still open, so Submit is refused with an alert.
  await bot.handleUpdate(w.tg.tapButton(id, 'Submit'));
  assert.deepEqual(w.tg.callbackAnswers.at(-1), {
    id: w.tg.callbackAnswers.at(-1).id,
    text: 'Answer the required question first: Notes',
    alert: true,
  });
  assert.equal(posts(w, '/respond').length, 0);

  await bot.handleUpdate(w.tg.message('ship it', { replyTo: id }));
  assert.match(w.tg.messages.get(id).text, /“ship it”/);
  assert.equal(posts(w, '/respond').length, 0);

  await bot.handleUpdate(w.tg.tapButton(id, 'Submit'));
  const responds = posts(w, '/respond');
  assert.equal(responds.length, 1);
  assert.deepEqual(responds[0].body, {
    answers: [
      { questionId: 'region', optionIds: ['region-opt1'] },
      { questionId: 'features', optionIds: ['features-opt1', 'features-opt3'] },
      { questionId: 'notes', optionIds: [], otherText: 'ship it' },
    ],
  });
  assert.equal(w.pc.interactions.get(interaction.id).status, 'answered');
  assert.deepEqual(w.tg.buttons(id), []);
});

test('a tap on the chosen option again clears it in a multi-question form', async (t) => {
  const payload = questionsPayload([
    choiceQuestion('a', 'First?', ['Yes', 'No']),
    choiceQuestion('b', 'Second?', ['Yes', 'No'], { required: false }),
  ]);
  const { w, bot, message } = await cardWorld(t, { kind: 'ask_user_questions', payload });
  await bot.handleUpdate(w.tg.tapButton(message.message_id, '1 · Yes'));
  assert.deepEqual(labels(w, message).slice(0, 2), ['✓ 1 · Yes', '1 · No']);
  await bot.handleUpdate(w.tg.tapButton(message.message_id, '✓ 1 · Yes'));
  assert.deepEqual(labels(w, message).slice(0, 2), ['1 · Yes', '1 · No']);
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Submit'));
  assert.match(w.tg.callbackAnswers.at(-1).text, /Answer the required question first/);
});

test('checkbox card enforces the minimum and maximum before it calls accept', async (t) => {
  const payload = {
    version: 1,
    prompt: 'Pick the targets',
    options: [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
      { id: 'c', label: 'Gamma' },
    ],
    minSelected: 1,
    maxSelected: 2,
    defaultSelectedOptionIds: [],
  };
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'request_checkbox_confirmation', payload });
  const id = message.message_id;
  assert.deepEqual(labels(w, message), ['Alpha', 'Beta', 'Gamma', 'Confirm', 'Decline']);

  await bot.handleUpdate(w.tg.tapButton(id, 'Confirm'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Select at least 1');
  assert.equal(posts(w, '/accept').length, 0);

  await bot.handleUpdate(w.tg.tapButton(id, 'Alpha'));
  await bot.handleUpdate(w.tg.tapButton(id, 'Beta'));
  await bot.handleUpdate(w.tg.tapButton(id, 'Gamma'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Select at most 2');
  assert.deepEqual(labels(w, message).slice(0, 3), ['✓ Alpha', '✓ Beta', 'Gamma']);

  await bot.handleUpdate(w.tg.tapButton(id, 'Confirm'));
  const accepts = posts(w, '/accept');
  assert.equal(accepts.length, 1);
  assert.deepEqual(accepts[0].body, { selectedOptionIds: ['a', 'b'] });
  assert.equal(w.pc.interactions.get(interaction.id).status, 'accepted');
  assert.deepEqual(w.tg.buttons(id), []);
});

test('checkbox defaults are pre-selected and decline works', async (t) => {
  const payload = {
    version: 1,
    prompt: 'Pick',
    options: [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ],
    defaultSelectedOptionIds: ['b'],
  };
  const { w, bot, message } = await cardWorld(t, { kind: 'request_checkbox_confirmation', payload });
  assert.deepEqual(labels(w, message).slice(0, 2), ['Alpha', '✓ Beta']);
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Decline'));
  assert.deepEqual(posts(w, '/reject')[0].body, {});
});

test('cards the bot cannot render as buttons are text plus a link only', async (t) => {
  const many = Array.from({ length: 31 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
  const big = await cardWorld(t, { kind: 'request_checkbox_confirmation', payload: { version: 1, prompt: 'Too many', options: many } });
  assert.deepEqual(labels(big.w, big.message), []);
  assert.match(big.message.text, /31 options: answer in Paperclip/);
  assert.match(big.message.text, /<a href="[^"]+#interaction-[^"]+">TST-1<\/a>/, 'the task id links to the card');
  assert.ok(!big.message.text.includes('Open in Paperclip'));

  const verdicts = await cardWorld(t, {
    kind: 'request_item_verdicts',
    payload: { version: 1, items: [{ id: 'x', label: 'First item' }, { id: 'y', label: 'Second item' }] },
  });
  assert.deepEqual(labels(verdicts.w, verdicts.message), []);
  assert.match(verdicts.message.text, /Verdicts requested/);
  assert.match(verdicts.message.text, /First item/);
});

test('a form with more than 20 questions is text plus a link only', async (t) => {
  const questions = Array.from({ length: 21 }, (_, i) => choiceQuestion(`q${i}`, `Question ${i}`, ['Yes', 'No']));
  const { w, message } = await cardWorld(t, { kind: 'ask_user_questions', payload: questionsPayload(questions) });
  assert.deepEqual(labels(w, message), []);
  assert.match(message.text, /21 questions: answer in Paperclip/);
});

test('the largest supported cards keep every callback_data within 64 bytes', async (t) => {
  const options = Array.from({ length: 30 }, (_, i) => ({ id: `option-${i}`, label: `Option ${i}` }));
  const checkbox = await cardWorld(t, { kind: 'request_checkbox_confirmation', payload: { version: 1, prompt: 'Many', options } });
  const buttons = checkbox.w.tg.buttons(checkbox.message.message_id);
  assert.equal(buttons.length, 33);
  for (const button of buttons) assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);

  const questions = Array.from({ length: 20 }, (_, i) => choiceQuestion(`question-${i}`, `Question ${i}`, ['One', 'Two', 'Three']));
  const form = await cardWorld(t, { kind: 'ask_user_questions', payload: questionsPayload(questions) });
  const formButtons = form.w.tg.buttons(form.message.message_id);
  assert.equal(formButtons.length, 62);
  for (const button of formButtons) assert.ok(Buffer.byteLength(button.callback_data) <= 64, button.callback_data);
});

test('a card resolved in Paperclip loses its buttons on the next poll', async (t) => {
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'request_confirmation', payload: confirmPayload() });
  assert.equal(labels(w, message).length, 2);

  w.pc.resolveElsewhere(interaction.id, 'accepted');
  await bot.pollOnce();
  assert.deepEqual(w.tg.buttons(message.message_id), []);
  assert.match(w.tg.messages.get(message.message_id).text, /Confirmed in Paperclip/);

  const edits = w.tg.callsTo('editMessageText').length;
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('editMessageText').length, edits, 'a closed card is not edited again');
});

test('a card on an issue that was closed is shown as closed', async (t) => {
  const { w, bot, issue, message } = await cardWorld(t, { kind: 'request_confirmation', payload: confirmPayload() });
  w.pc.setStatus(issue.id, 'cancelled');
  await bot.pollOnce();
  assert.deepEqual(w.tg.buttons(message.message_id), []);
  assert.match(w.tg.messages.get(message.message_id).text, /Closed in Paperclip/);
});

test('a stale tap gets the 409 answer and the message is refreshed', async (t) => {
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'request_confirmation', payload: confirmPayload() });
  w.pc.resolveElsewhere(interaction.id, 'rejected');

  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Deploy'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already answered or closed');
  assert.deepEqual(w.tg.buttons(message.message_id), []);
  assert.match(w.tg.messages.get(message.message_id).text, /Declined in Paperclip/);

  // Tapping the old keyboard again is answered from local state without another call.
  const accepts = posts(w, '/accept').length;
  await bot.handleUpdate(w.tg.tap(message.message_id, `${bot.state.cards.keys().next().value}:a`));
  assert.equal(posts(w, '/accept').length, accepts);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already answered or closed');
});

test('an unreachable Paperclip leaves the card pending and answers with a retry hint', async (t) => {
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'request_confirmation', payload: confirmPayload() });
  w.pc.setDropConnections(true);
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Deploy'));
  w.pc.setDropConnections(false);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Paperclip unreachable, try again');
  assert.equal(labels(w, message).length, 2);

  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Deploy'));
  assert.equal(w.pc.interactions.get(interaction.id).status, 'accepted');
});

test('a failed single-question submit keeps the form usable', async (t) => {
  const payload = questionsPayload([choiceQuestion('env', 'Which environment?', ['Staging', 'Production'])]);
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'ask_user_questions', payload });
  w.pc.setDropConnections(true);
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Staging'));
  w.pc.setDropConnections(false);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Paperclip unreachable, try again');
  assert.deepEqual(labels(w, message), ['Staging', 'Production']);
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Staging'));
  assert.deepEqual(posts(w, '/respond').at(-1).body, { answers: [{ questionId: 'env', optionIds: ['env-opt1'] }] });
  assert.equal(w.pc.interactions.get(interaction.id).status, 'answered');
});

test('a tap on a card the bot no longer knows is answered politely', async (t) => {
  const { w, bot, message } = await cardWorld(t, { kind: 'request_confirmation', payload: confirmPayload() });
  await bot.handleUpdate(w.tg.tap(message.message_id, 'zz:a'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This card is no longer available');
  await bot.handleUpdate(w.tg.tap(message.message_id, 'garbage'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This card is no longer available');
  assert.equal(posts(w, '/accept').length, 0);
});

test('a new request replaces the older pending confirmation on the same issue', async (t) => {
  const { w, bot, issue, interaction, message } = await cardWorld(t, { kind: 'request_confirmation', payload: confirmPayload() });
  w.pc.resolveElsewhere(interaction.id, 'expired', { version: 1, outcome: 'superseded_by_newer_request' });
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'A newer question' }) });
  await bot.pollOnce();
  assert.deepEqual(w.tg.buttons(message.message_id), []);
  const newer = w.tg.findMessage('A newer question');
  assert.ok(newer);
  assert.equal(labels(w, newer).length, 2);
});

test('cards are not sent twice by repeated polls', async (t) => {
  const { w, bot } = await cardWorld(t, { kind: 'request_confirmation', payload: confirmPayload() });
  await bot.pollOnce();
  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendMessage').length, 1);
});

test('a reply to a decline-reason prompt never becomes a comment once the card is closed', async (t) => {
  const payload = confirmPayload({ rejectRequiresReason: true });
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'request_confirmation', payload });
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Hold'));
  const prompt = w.tg.sent().find((m) => m.markup?.force_reply);
  assert.ok(prompt);

  w.pc.resolveElsewhere(interaction.id, 'accepted');
  await bot.pollOnce();
  assert.match(w.tg.messages.get(message.message_id).text, /Confirmed in Paperclip/);

  // A restarted bot keeps the link from the prompt to its card.
  const restarted = w.makeBot();
  await restarted.handleUpdate(w.tg.message('Too risky before the freeze', { replyTo: prompt.message_id }));
  assert.equal(posts(w, '/comments').length, 0);
  assert.equal(posts(w, '/reject').length, 0);
  assert.equal(w.tg.lastMessage().text, 'This card was already answered or closed.');
});

test('a reason sent after the card was settled elsewhere is not posted as a comment either', async (t) => {
  const payload = confirmPayload({ rejectRequiresReason: true });
  const { w, bot, interaction, message } = await cardWorld(t, { kind: 'request_confirmation', payload });
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Hold'));
  const prompt = w.tg.sent().find((m) => m.markup?.force_reply);

  w.pc.resolveElsewhere(interaction.id, 'accepted');
  await bot.handleUpdate(w.tg.message('Too risky', { replyTo: prompt.message_id }));
  assert.equal(posts(w, '/comments').length, 0);
  assert.equal(w.tg.lastMessage().text, 'Already answered or closed');
  assert.deepEqual(w.tg.buttons(message.message_id), []);

  await bot.handleUpdate(w.tg.message('Too risky, really', { replyTo: prompt.message_id }));
  assert.equal(posts(w, '/comments').length, 0);
  assert.equal(w.tg.lastMessage().text, 'This card was already answered or closed.');
});

test('a reply to an old reason prompt whose card is gone is not posted as a comment', async (t) => {
  const payload = confirmPayload({ rejectRequiresReason: true });
  const { w, bot, message } = await cardWorld(t, { kind: 'request_confirmation', payload });
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Hold'));
  const prompt = w.tg.sent().find((m) => m.markup?.force_reply);
  bot.state.cards.clear();
  await bot.handleUpdate(w.tg.message('Too risky', { replyTo: prompt.message_id }));
  assert.equal(posts(w, '/comments').length, 0);
  assert.equal(w.tg.lastMessage().text, "I don't know which task this is");
});

const SQUARES = /[☐-☒]/u;

test('option buttons have no squares: plain when unselected, a check and primary when selected', async (t) => {
  const many = await cardWorld(t, {
    kind: 'ask_user_questions',
    payload: questionsPayload([
      choiceQuestion('region', 'Which region?', ['EU', 'US']),
      choiceQuestion('features', 'Which features?', ['Alpha', 'Beta'], { multi: true }),
    ]),
  });
  const id = many.message.message_id;
  await many.bot.handleUpdate(many.w.tg.tapButton(id, 'Beta'));
  assert.deepEqual(styles(many.w, many.message), {
    '1 · EU': null,
    '1 · US': null,
    '2 · Alpha': null,
    '✓ 2 · Beta': 'primary',
    Submit: 'success',
    [TASK_BUTTON]: null,
  });

  const single = await cardWorld(t, {
    kind: 'ask_user_questions',
    payload: questionsPayload([choiceQuestion('features', 'Which features?', ['Alpha', 'Beta'], { multi: true })]),
  });
  assert.deepEqual(labels(single.w, single.message), ['Alpha', 'Beta', 'Submit'], 'one question needs no number');
  await single.bot.handleUpdate(single.w.tg.tapButton(single.message.message_id, 'Alpha'));
  assert.deepEqual(labels(single.w, single.message), ['✓ Alpha', 'Beta', 'Submit']);

  const checkbox = await cardWorld(t, {
    kind: 'request_checkbox_confirmation',
    payload: { version: 1, prompt: 'Pick', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }], defaultSelectedOptionIds: ['b'] },
  });
  assert.deepEqual(styles(checkbox.w, checkbox.message), {
    Alpha: null,
    '✓ Beta': 'primary',
    Confirm: 'success',
    Decline: 'danger',
    [TASK_BUTTON]: null,
  });

  for (const world of [many, single, checkbox]) {
    for (const button of world.w.tg.buttons(world.message.message_id)) assert.ok(!SQUARES.test(button.text), button.text);
  }
});

test('a form lists numbered questions, marks optional ones and shows Answer only once answered', async (t) => {
  const payload = questionsPayload([
    choiceQuestion('region', 'Which region?', ['EU', 'US']),
    choiceQuestion('features', 'Which features?', ['Alpha', 'Beta', 'Gamma'], { multi: true, required: false }),
    textQuestion('notes', 'Notes'),
  ]);
  const { w, bot, issue, interaction, message } = await cardWorld(t, { kind: 'ask_user_questions', payload });
  const head = `<b>Question</b> · <a href="${UI_BASE_URL}/TST/issues/${issue.identifier}#interaction-${interaction.id}">${issue.identifier}</a> Ship v2`;
  assert.equal(
    message.text,
    `${head}\n\n1. Which region?\n2. Which features? (optional)\n3. Notes\n\nReply to this message to answer the text question.`,
  );

  const id = message.message_id;
  await bot.handleUpdate(w.tg.tapButton(id, 'EU'));
  await bot.handleUpdate(w.tg.tapButton(id, 'Gamma'));
  await bot.handleUpdate(w.tg.message('ship it', { replyTo: id }));
  const text = w.tg.messages.get(id).text;
  assert.equal(text, `${head}\n\n1. Which region?\n   Answer: EU\n2. Which features? (optional)\n   Answer: Gamma\n3. Notes\n   Answer: “ship it”`);
  assert.ok(!text.includes('*'), 'no star marks a required question');
});

test('a single question is not numbered and an unanswered optional one says so', async (t) => {
  const payload = questionsPayload([choiceQuestion('features', 'Which features?', ['Alpha', 'Beta'], { multi: true, required: false })]);
  const { w, bot, message } = await cardWorld(t, { kind: 'ask_user_questions', payload });
  assert.match(message.text, /\n\nWhich features\? \(optional\)$/);
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Beta'));
  assert.match(w.tg.messages.get(message.message_id).text, /\n\nWhich features\? \(optional\)\nAnswer: Beta$/);
});

test('custom accept and reject labels keep the success and danger colours', async (t) => {
  const { w, message } = await cardWorld(t, {
    kind: 'request_confirmation',
    payload: confirmPayload({ acceptLabel: 'Ship it', rejectLabel: 'Not now' }),
  });
  assert.deepEqual(styles(w, message), { 'Ship it': 'success', 'Not now': 'danger', [TASK_BUTTON]: null });
});

test('a card in a task\'s own topic has no task id and no Open task; a subtask card in the parent topic has both', async (t) => {
  const w = await startWorld({ telegram: { chatId: -1001234567890, forum: true }, config: { topics: 'auto' } });
  t.after(() => w.close());
  const bot = await w.primedBot();
  const parent = w.pc.addIssue({ title: 'Big job', status: 'in_progress' });
  const child = w.pc.addIssue({ title: 'Small step', status: 'in_review', parentId: parent.id });
  await bot.pollOnce();
  w.pc.addInteraction(parent.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'Start the job?' }) });
  w.pc.addInteraction(child.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'Ship the step?' }) });
  await bot.pollOnce();

  const thread = bot.state.topics.get(parent.id).thread;
  const own = w.tg.inTopic(thread).find((m) => m.text.includes('Start the job?'));
  const sub = w.tg.inTopic(thread).find((m) => m.text.includes('Ship the step?'));
  assert.match(own.text, /^<b>Question<\/b>\nStart the job\?$/);
  assert.deepEqual(labels(w, own), ['Deploy', 'Hold']);
  assert.ok(!w.tg.buttons(own.message_id).some((b) => b.text === TASK_BUTTON));
  assert.match(sub.text, /^<b>Question<\/b> · <a href="[^"]+#interaction-[^"]+">TST-2<\/a> Small step\nShip the step\?$/);
  assert.equal(w.tg.buttons(sub.message_id).at(-1).text, TASK_BUTTON);
});
