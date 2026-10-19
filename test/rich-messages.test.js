import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseConfig } from '../src/config.js';
import { followIssue } from '../src/follow.js';
import { State } from '../src/state.js';
import { mentionProblems, mentioned } from './alerts.js';
import { validateRichMarkdown } from './fakes/telegram.js';
import { UI_BASE_URL, confirmPayload, startWorld } from './helpers.js';

const GROUP_ID = -1001234567890;
const ISSUE_URL = `${UI_BASE_URL}/TST/issues/TST-1`;
const HEAD = `<b>Dev</b> · <a href="${ISSUE_URL}">TST-1</a> Followed work`;
const RICH = { config: { richMessages: 'auto' } };
const GROUP = { telegram: { chatId: GROUP_ID }, config: { topics: 'off', richMessages: 'auto' } };
const FORUM = { telegram: { chatId: GROUP_ID, forum: true }, config: { richMessages: 'auto' } };
const HOUR = 60 * 60 * 1000;
const REFUSED = 'rich message refused, sent as plain text';
// A character outside the BMP: one code point, two UTF-16 units.
const ASTRAL = '\u{20000}';
const SWITCHED_OFF = 'rich messages refused 3 times in a row, sending plain messages from now on';

async function setup(t, options = RICH, botOptions) {
  const w = await startWorld(options);
  t.after(() => w.close());
  return { w, bot: await w.primedBot(botOptions) };
}

const times = (w, text) => w.allLogText().split(text).length - 1;
const richSends = (w) => w.tg.callsTo('sendRichMessage');
const plainSends = (w) => w.tg.callsTo('sendMessage');
const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const tap = (w, bot, message, label, options) => bot.handleUpdate(w.tg.tapButton(message.message_id, label, options));
const refusal = { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" };

async function followed(w, bot, fields = {}) {
  const issue = w.pc.addIssue({ title: 'Followed work', status: 'in_progress', assigneeAgentId: 'agent-1', ...fields });
  await followIssue(bot, issue);
  return issue;
}

// The rich message the bot sends for one comment.
async function commentMessage(w, bot, issue, body) {
  const before = w.tg.sent().length;
  const comment = w.pc.addComment(issue.id, { body });
  await bot.pollOnce();
  const [message] = w.tg.sent().slice(before);
  assert.ok(message, 'a message was sent');
  return { message, comment };
}

// --- exact Markdown of sample comments ----------------------------------------------------------

const SAMPLES = [
  ['bold text', 'Fixed **the bug** now.', '> Fixed **the bug** now.'],
  ['italic text', 'Looks *fine* and _good_.', '> Looks *fine* and _good_.'],
  ['a list', '- one\n- two\n- three', '> - one  \n> - two  \n> - three'],
  ['a task list', '- [x] write\n- [ ] ship', '> - [x] write  \n> - [ ] ship'],
  ['a heading', '## Result\n\nAll good.', '> ## Result\n>\n> All good.'],
  ['a code block', '```js\nconst a = 1;\n```', '> ```js\n> const a = 1;\n> ```'],
  ['a table', '| a | b |\n|---|---|\n| 1 | 2 |', '> | a | b |  \n> |---|---|  \n> | 1 | 2 |'],
  ['a quote', '> quoted words', '> > quoted words'],
  ['a relative Paperclip link', 'See [the task](/TST/issues/TST-2).', `> See [the task](${UI_BASE_URL}/TST/issues/TST-2).`],
  ['an absolute link', 'See [docs](https://example.com/a?b=c).', '> See [docs](https://example.com/a?b=c).'],
  ['an agent link', 'Ask [Dev](agent://abc) first.', '> Ask Dev first.'],
  ['an image', 'Look: ![shot](/api/assets/1/content)', `> Look: [shot](${UI_BASE_URL}/api/assets/1/content)`],
  ['an image without a description', '![](https://example.com/a.png)', '> [image](https://example.com/a.png)'],
  ['raw HTML', 'A <b>bold</b> and <script>alert(1)</script> & more', '> A &lt;b>bold&lt;/b> and &lt;script>alert(1)&lt;/script> &amp; more'],
  ['HTML in a code span', 'Use `<b>` here', '> Use `<b>` here'],
  ['HTML in a code block', '```html\n<script>x</script>\n```', '> ```html\n> <script>x</script>\n> ```'],
];

for (const [name, body, expected] of SAMPLES) {
  test(`a comment with ${name} is sent as this rich Markdown`, async (t) => {
    const { w, bot } = await setup(t);
    const issue = await followed(w, bot);
    const { message } = await commentMessage(w, bot, issue, body);

    assert.equal(message.rich, true);
    assert.equal(message.text, `${HEAD}\n\n${expected}`);
    assert.equal(validateRichMarkdown(message.text), null);
    assert.equal(plainSends(w).length, 0);
  });
}

test('a title with Markdown characters is escaped in the header line', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot, { title: 'Fix * _ [ ] # <b> & more' });
  const { message } = await commentMessage(w, bot, issue, 'ok');

  assert.equal(message.text, `<b>Dev</b> · <a href="${ISSUE_URL}">TST-1</a> Fix \\* \\_ \\[ \\] \\# &lt;b&gt; &amp; more\n\n> ok`);
  assert.equal(validateRichMarkdown(message.text), null);
});

test('a comment over 3 lines folds under its first line', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const lines = ['**Summary** of the work', 'line two', 'line three', 'line four', 'line five'];
  const { message } = await commentMessage(w, bot, issue, lines.join('\n'));

  assert.equal(message.text, `${HEAD}\n\n<details><summary>Summary of the work</summary>\n\nline two  \nline three  \nline four  \nline five\n\n</details>`);
  assert.equal(validateRichMarkdown(message.text), null);
});

test('a comment over 300 characters folds, and the summary is the first line cut to 80 characters', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const first = 'a long first line '.repeat(8).trim();
  const { message } = await commentMessage(w, bot, issue, `${first}\n${'x'.repeat(300)}`);

  const summary = /<summary>(.*)<\/summary>/.exec(message.text)[1];
  assert.ok(Array.from(summary).length <= 80 && summary.endsWith('…'), summary);
  assert.ok(message.text.includes(`\n\n${first}  \n${'x'.repeat(300)}\n\n</details>`), 'the whole first line is inside as well');
});

test('a long comment that starts with a code block folds under Show all', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const body = '```\nrow 1\nrow 2\nrow 3\n```\nand after the code';
  const { message } = await commentMessage(w, bot, issue, body);

  assert.equal(message.text, `${HEAD}\n\n<details><summary>Show all</summary>\n\n${body}\n\n</details>`);
});

test('a comment cut inside a code block closes the block and ends with a link to the full text', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const rows = Array.from({ length: 600 }, (_, i) => `row number ${i + 1}`);
  const { message, comment } = await commentMessage(w, bot, issue, ['```', ...rows, '```'].join('\n'));

  let used = '```'.length + 1;
  const kept = rows.filter((row) => (used += row.length + 1) <= 4000);
  assert.ok(kept.length > 100 && kept.length < rows.length);
  assert.equal(
    message.text,
    `${HEAD}\n\n<details><summary>Show all</summary>\n\n\`\`\`\n${kept.join('\n')}\n\`\`\`\n\n[Full text in Paperclip](${ISSUE_URL}#comment-${comment.id})\n\n</details>`,
  );
  assert.equal(validateRichMarkdown(message.text), null);
});

// --- line breaks --------------------------------------------------------------------------------

test('a comment with single newlines keeps each line on its own line', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const { message } = await commentMessage(w, bot, issue, 'Cause: the cache\nDid: cleared it\nBack to Lead');

  assert.equal(message.text, `${HEAD}\n\n> Cause: the cache  \n> Did: cleared it  \n> Back to Lead`);
  assert.equal(validateRichMarkdown(message.text), null);
});

test('a folded comment breaks its lines inside the fold and keeps the summary as it was', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const { message } = await commentMessage(w, bot, issue, '**Summary** of the work\nCause: a\nDid: b\n\nNext: c\nThen: d');

  assert.equal(message.text, `${HEAD}\n\n<details><summary>Summary of the work</summary>\n\nCause: a  \nDid: b\n\nNext: c  \nThen: d\n\n</details>`);
  assert.equal(validateRichMarkdown(message.text), null);
});

test('a comment adds no spaces inside fenced or indented code and breaks the lines around it', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const { message: fenced } = await commentMessage(w, bot, issue, 'Ran:\n```sh\nls -l\npwd\n```\nand then:\n- one\n- two');
  assert.equal(fenced.text, `${HEAD}\n\n<details><summary>Ran:</summary>\n\n\`\`\`sh\nls -l\npwd\n\`\`\`\nand then:  \n- one  \n- two\n\n</details>`);

  const { message: indented } = await commentMessage(w, bot, issue, 'Output:\n\n    first line\n    second line\n\nDone\nfine');
  assert.equal(indented.text, `${HEAD}\n\n<details><summary>Output:</summary>\n\n    first line\n    second line\n\nDone  \nfine\n\n</details>`);
  for (const message of [fenced, indented]) assert.equal(validateRichMarkdown(message.text), null);
});

test('a comment cut with a link to the full text keeps the link apart from the last broken line', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const rows = Array.from({ length: 800 }, (_, i) => `line ${i + 1} of the report`);
  const { message, comment } = await commentMessage(w, bot, issue, `Report\n${rows.join('\n')}`);

  assert.ok(message.text.includes('\n\nline 1 of the report  \nline 2 of the report  \n'));
  assert.ok(message.text.endsWith(`\n\n[Full text in Paperclip](${ISSUE_URL}#comment-${comment.id})\n\n</details>`));
  assert.equal(validateRichMarkdown(message.text), null);
});

test('a Done message quotes its comment with line breaks', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Write the docs', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.pollOnce();
  w.pc.addComment(issue.id, { body: 'Did: a\nNext: b' });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  const done = w.tg.sent().find((message) => message.text.startsWith('<b>Done</b>'));
  assert.ok(done.text.endsWith('\n\n> Did: a  \n> Next: b'), done.text);
});

test('a task view breaks the lines of its last comment but not of its description', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot, { description: 'Goal one\nGoal two' });
  w.pc.addComment(issue.id, { body: 'Cause: a\nDid: b' });
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  const view = w.tg.lastMessage();

  assert.equal(view.rich, true);
  assert.ok(view.text.includes('\n\n> Goal one\n> Goal two\n'), view.text);
  assert.ok(view.text.endsWith('\n> Cause: a  \n> Did: b'), view.text);
  assert.equal(validateRichMarkdown(view.text), null);
});

test('a card breaks the lines of its prompt and details, and a decision those of its text', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Ship v2', status: 'in_review', assigneeAgentId: 'agent-1' });
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'Deploy now?\nIt is ready.', detailsMarkdown: 'Build: ok\nTests: ok' }) });
  w.pc.addDecision({ issueId: issue.id, title: 'Pick', body: 'Way A\nWay B' });
  await bot.pollOnce();

  const card = w.tg.findMessage('Deploy now?');
  assert.ok(card.text.endsWith('Deploy now?  \nIt is ready.\n\n> Build: ok  \n> Tests: ok'), card.text);
  const decision = w.tg.findMessage('Way A');
  assert.ok(decision.text.includes('\n\n> Way A  \n> Way B'), decision.text);
  for (const message of [card, decision]) assert.equal(validateRichMarkdown(message.text), null);
});

// --- which messages go rich ---------------------------------------------------------------------

test('a followed comment, a done message with a comment and a task view with a description are rich messages', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot, { description: 'Write **all** the docs' });
  const { message: comment } = await commentMessage(w, bot, issue, 'Docs are being written');
  const other = w.pc.addIssue({ title: 'Other work', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.pollOnce();
  w.pc.addComment(other.id, { body: 'Docs are written' });
  w.pc.setStatus(other.id, 'done');
  await bot.pollOnce();
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));

  const [done, view] = w.tg.sent().slice(1);
  assert.deepEqual([comment.rich, done.rich, view.rich], [true, true, true]);
  assert.equal(plainSends(w).length, 0);
  assert.ok(comment.text.endsWith('\n\n> Docs are being written'));
  assert.ok(done.text.startsWith(`<b>Done</b> · <a href="${UI_BASE_URL}/TST/issues/TST-2">TST-2</a> Other work\n\n> Docs are written`), done.text);
  assert.ok(view.text.includes('\n\n> Write **all** the docs'));
  for (const message of w.tg.sent()) assert.equal(validateRichMarkdown(message.text), null);
});

test('a done message without a comment, a task view without Markdown, lists and notices stay classic', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Bare task', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  await bot.handleUpdate(w.tg.message('/status'));
  await bot.handleUpdate(w.tg.message('/help'));

  assert.ok(w.tg.sent().length >= 4);
  assert.equal(richSends(w).length, 0);
  assert.equal(w.tg.richMessages().length, 0);
});

test('a card, a decision and the document of a task are rich messages; an approval is not', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Ship v2', status: 'in_review', assigneeAgentId: 'agent-1' });
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'Deploy **now**?', detailsMarkdown: 'Some `details`' }) });
  w.pc.addDecision({ issueId: issue.id, title: 'Pick', body: 'Which *way* should we go?' });
  w.pc.addApproval({ issueId: issue.id, payload: { title: 'Hire a designer' } });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: '# Plan\n\nStep one' });
  await bot.pollOnce();

  const card = w.tg.findMessage('Deploy **now**?');
  assert.equal(card.rich, true);
  assert.ok(card.text.endsWith('Deploy **now**?\n\n> Some `details`'));
  const decision = w.tg.findMessage('Which *way* should we go?');
  assert.equal(decision.rich, true);
  assert.ok(decision.text.includes('\n\n> Which *way* should we go?'));
  const approval = w.tg.sent().find((m) => m.text.startsWith('<b>Approval</b>'));
  assert.ok(approval && !approval.rich);

  const view = await (async () => {
    await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
    return w.tg.lastMessage();
  })();
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Docs');
  const before = w.tg.sent().length;
  await tap(w, bot, view, 'Plan');
  const [document] = w.tg.sent().slice(before);
  assert.equal(document.rich, true);
  assert.equal(document.text, '<b>Plan</b>\n\n# Plan\n\nStep one');
});

// --- the owner mention -------------------------------------------------------------------------

test('an alert in a group mentions the owner on its first word and the rich reply confirms it', async (t) => {
  const { w, bot } = await setup(t, GROUP);
  const issue = w.pc.addIssue({ title: 'Ship v2', status: 'in_review', assigneeAgentId: 'agent-1' });
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'Deploy?' }) });
  await bot.pollOnce();

  const [call] = richSends(w);
  assert.ok(call, 'the card went out as a rich message');
  assert.ok(call.params.rich_message.markdown.startsWith(`${mentioned('Question', w.tg.userId)} · `));
  assert.equal(call.params.disable_notification, undefined, 'an alert has a sound');
  assert.equal(call.params.rich_message.markdown.split('tg://user?id=').length - 1, 1);
  assert.equal(times(w, 'info owner mention accepted\n'), 1);
  assert.equal(times(w, 'Telegram dropped the owner mention'), 0);
  assert.deepEqual(mentionProblems(w.tg.calls, w.tg.userId), []);
});

test('a done message with a quoted comment in a group mentions the owner on its first word', async (t) => {
  const { w, bot } = await setup(t, GROUP);
  const issue = w.pc.addIssue({ title: 'Write the docs', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.pollOnce();
  w.pc.addComment(issue.id, { body: 'All **done**' });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  const [call] = richSends(w);
  assert.equal(call.params.rich_message.markdown, `${mentioned('Done', w.tg.userId)} · <a href="${UI_BASE_URL}/TST/issues/TST-1">TST-1</a> Write the docs\n\n> All **done**`);
  assert.equal(call.params.disable_notification, undefined);
  assert.deepEqual(mentionProblems(w.tg.calls, w.tg.userId), []);
});

test('a rich reply without the text mention logs that Telegram dropped it', async (t) => {
  const { w, bot } = await setup(t, GROUP);
  w.tg.dropMentions();
  await bot.send('<b>Question</b>\nDeploy?', { alert: true, rich: '<b>Question</b>\n\nDeploy?' });

  assert.equal(times(w, 'warn Telegram dropped the owner mention\n'), 1);
  assert.equal(times(w, 'owner mention accepted'), 0);
});

test('a silent rich message and a rich edit carry no mention', async (t) => {
  const { w, bot } = await setup(t, GROUP);
  const issue = await followed(w, bot);
  await commentMessage(w, bot, issue, 'A quiet note');
  const id = await bot.send('<b>Question</b>\nDeploy?', { alert: true, rich: '<b>Question</b>\n\nDeploy?' });
  await bot.edit(id, '<b>Question</b>\nDeploy?\n\nDone', [], '<b>Question</b>\n\nDeploy?\n\nDone');

  assert.equal(richSends(w).length, 2);
  assert.equal(w.tg.callsTo('editMessageText')[0].params.rich_message.markdown.includes('tg://user'), false);
  assert.deepEqual(mentionProblems(w.tg.calls, w.tg.userId), []);
});

// --- fallback ----------------------------------------------------------------------------------

test('a refused rich message goes out as the classic message and the refusal is logged', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  w.tg.refuseRich({ times: 1 });
  const { message } = await commentMessage(w, bot, issue, 'Found the <root> cause');

  assert.equal(message.rich, undefined);
  assert.equal(message.text, `<b>Dev</b> · ${HEAD.replace('<b>Dev</b> · ', '')}\n<blockquote>Found the &lt;root&gt; cause</blockquote>`);
  assert.equal(richSends(w).length, 1);
  assert.equal(plainSends(w).length, 1);
  assert.equal(times(w, REFUSED), 1);
  assert.match(w.allLogText(), /rich message refused, sent as plain text.*can't parse rich message/);
  assert.equal(bot.state.isRich(message.message_id), false);
});

test('the refusal warning comes at most once an hour', async (t) => {
  const clock = { at: Date.now() };
  const { w, bot } = await setup(t, RICH, { now: () => clock.at });
  const send = async () => {
    w.tg.refuseRich({ times: 1 });
    await bot.send('classic', { rich: 'rich' });
    await bot.send('classic', { rich: 'rich' });
  };
  await send();
  await send();
  assert.equal(times(w, REFUSED), 1, 'four refusals, two of them answered by a success in between, one warning');
  clock.at += HOUR + 1000;
  await send();
  assert.equal(times(w, REFUSED), 2);
  assert.equal(times(w, SWITCHED_OFF), 0, 'a success between the refusals resets the count');
});

test('three refusals in a row switch rich messages off for the rest of the run', async (t) => {
  const { w, bot } = await setup(t);
  w.tg.refuseRich();
  for (let i = 0; i < 3; i += 1) await bot.send(`classic ${i}`, { rich: `rich ${i}` });
  assert.equal(richSends(w).length, 3);
  assert.equal(times(w, SWITCHED_OFF), 1);

  w.tg.allowRich();
  const id = await bot.send('classic 3', { rich: 'rich 3' });
  assert.equal(richSends(w).length, 3, 'no more tries');
  assert.equal(w.tg.messages.get(id).rich, undefined);
  assert.equal(plainSends(w).length, 4);
  assert.equal(times(w, SWITCHED_OFF), 1, 'logged once');

  const restarted = w.makeBot();
  await restarted.send('classic 4', { rich: 'rich 4' });
  assert.equal(richSends(w).length, 4, 'a new run tries again');
});

test('a message sent rich is edited as a classic message once rich messages are off', async (t) => {
  const { w, bot } = await setup(t);
  const id = await bot.send('classic', { rich: 'rich' });
  bot.richOff = true;
  await bot.edit(id, 'classic two', [], 'rich two');

  assert.equal(w.tg.messages.get(id).text, 'classic two');
  assert.equal(w.tg.messages.get(id).rich, false);
  assert.equal(bot.state.isRich(id), false);
});

test('other failures are not taken for a refusal of the rich format', async (t) => {
  const { w, bot } = await setup(t);
  const fail = (status, description) => ({ ok: false, error_code: status, description });
  const cases = [
    [500, 'Internal Server Error'],
    [429, 'Too Many Requests: retry after 1'],
    [403, 'Forbidden: bot was blocked by the user'],
    [400, 'Bad Request: not enough rights to send text messages to the chat'],
    [400, 'Bad Request: chat not found'],
  ];
  for (const [status, description] of cases) {
    w.tg.failNext('sendRichMessage', status, fail(status, description));
    await assert.rejects(bot.send('classic', { rich: 'rich' }), (err) => err.code === status, description);
  }
  assert.equal(plainSends(w).length, 0);
  assert.equal(bot.richRefusals, 0);
  assert.equal(times(w, REFUSED), 0);
});

test('a rich message sent to a deleted topic makes the topic again and is still a rich message', async (t) => {
  const { w, bot } = await setup(t, FORUM);
  const issue = await followed(w, bot);
  await commentMessage(w, bot, issue, 'First note');
  w.tg.deleteTopic(bot.state.topics.get(issue.id).thread);
  w.pc.addComment(issue.id, { body: 'Second note' });
  await bot.pollOnce();

  const message = w.tg.lastMessage();
  assert.ok(message.text.endsWith('> Second note'));
  assert.equal(message.rich, true);
  assert.equal(w.tg.callsTo('createForumTopic').length, 2);
  assert.equal(plainSends(w).filter((call) => call.params.text.includes('note')).length, 0);
  assert.equal(bot.richRefusals, 0);
});

test('a rich message into a closed topic goes to the main chat once, still rich', async (t) => {
  const { w, bot } = await setup(t, FORUM);
  const issue = await followed(w, bot);
  await commentMessage(w, bot, issue, 'First note');
  w.tg.failNext('sendRichMessage', 400, { ok: false, error_code: 400, description: 'Bad Request: TOPIC_CLOSED' }, Infinity, (params) => params.message_thread_id !== undefined);
  const { message } = await commentMessage(w, bot, issue, 'Second note');

  assert.equal(message.rich, true);
  assert.equal(message.thread, null);
  assert.equal(bot.richRefusals, 0);
  assert.equal(times(w, REFUSED), 0);
});

test('a refused rich edit changes the message with a classic edit', async (t) => {
  const { w, bot } = await setup(t);
  const id = await bot.send('classic', { rich: 'rich' });
  w.tg.refuseRich({ times: 1 });
  await bot.edit(id, 'classic two', [], 'rich two');

  assert.equal(w.tg.messages.get(id).text, 'classic two');
  assert.equal(w.tg.messages.get(id).rich, false);
  assert.equal(bot.state.isRich(id), false);
  assert.equal(times(w, REFUSED), 1);
});

test('an edit that changes nothing is neither an error nor a refusal', async (t) => {
  const { w, bot } = await setup(t);
  const id = await bot.send('classic', { rich: 'rich' });
  await bot.edit(id, 'classic', [], 'rich');

  assert.equal(w.tg.callsTo('editMessageText').length, 1);
  assert.equal(bot.richRefusals, 0);
  assert.equal(times(w, REFUSED), 0);
  assert.equal(bot.state.isRich(id), true);
});

// --- richMessages: "off" -----------------------------------------------------------------------

test('with richMessages off every message is the classic one', async (t) => {
  const { w, bot } = await setup(t, { config: { richMessages: 'off' } });
  const issue = await followed(w, bot, { description: 'A **description**' });
  const { message } = await commentMessage(w, bot, issue, 'Found the <root> cause & fixed it.');
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'Deploy?', detailsMarkdown: 'Details' }) });
  w.pc.addDecision({ issueId: issue.id, body: 'Which way?' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: 'Step one' });
  await bot.pollOnce();
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));

  assert.equal(message.text, `${HEAD}\n<blockquote>Found the &lt;root&gt; cause &amp; fixed it.</blockquote>`);
  assert.equal(richSends(w).length, 0);
  assert.equal(w.tg.richMessages().length, 0);
  assert.ok(w.tg.sent().length >= 4);
  assert.equal(bot.richOff, true);
});

test('richMessages is "auto" by default and must be "auto" or "off"', () => {
  const base = {
    paperclipUrl: 'http://localhost:3100/',
    uiBaseUrl: 'https://paperclip.example.com',
    companyId: 'company-1',
    leadAgentId: 'agent-lead',
    telegramUserId: 1001,
    telegramTokenFile: '~/telegram-token',
    paperclipTokenFile: '/tmp/paperclip-token',
  };
  assert.equal(parseConfig(base).config.richMessages, 'auto');
  assert.equal(parseConfig({ ...base, richMessages: 'off' }).config.richMessages, 'off');
  assert.equal(parseConfig({ ...base, richMessages: 'auto' }).config.richMessages, 'auto');
  for (const bad of ['on', true, 1, '', null]) {
    const result = parseConfig({ ...base, richMessages: bad });
    assert.equal(result.config, null, String(bad));
    assert.match(result.problems.join('\n'), /richMessages must be "auto" or "off"/);
  }
});

// --- edits of rich messages --------------------------------------------------------------------

test('a card that is answered is edited as a rich message with its closing line', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Ship v2', status: 'in_review', assigneeAgentId: 'agent-1' });
  w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload({ prompt: 'Deploy **now**?', detailsMarkdown: 'Some details' }) });
  await bot.pollOnce();
  const card = w.tg.findMessage('Deploy **now**?');
  await tap(w, bot, card, 'Deploy');

  const [edit] = w.tg.callsTo('editMessageText');
  assert.ok(edit.params.rich_message, 'the edit carries a rich message');
  assert.equal(edit.params.text, undefined);
  const after = w.tg.messages.get(card.message_id);
  assert.equal(after.rich, true);
  assert.ok(after.text.endsWith('Deploy **now**?\n\n> Some details\n\nConfirmed'), after.text);
  assert.deepEqual(rowsOf(w, card.message_id), []);
  assert.equal(validateRichMarkdown(after.text), null);
});

test('a task view is refreshed as a rich message and a keyboard change stays a keyboard edit', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Plan the launch', description: 'First **draft**', status: 'todo' });
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  const view = w.tg.lastMessage();
  assert.equal(view.rich, true);

  await tap(w, bot, view, 'More');
  assert.equal(w.tg.callsTo('editMessageText').length, 0, 'More only changes the buttons');
  assert.equal(w.tg.callsTo('editMessageReplyMarkup').length, 1);

  w.pc.issues.get(issue.id).description = 'Second **draft**';
  await tap(w, bot, view, 'Refresh');
  const [edit] = w.tg.callsTo('editMessageText');
  assert.ok(edit.params.rich_message.markdown.includes('> Second **draft**'));
  assert.equal(w.tg.messages.get(view.message_id).rich, true);
  assert.equal(validateRichMarkdown(w.tg.messages.get(view.message_id).text), null);
});

test('an inbox decision is resolved with a rich edit', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Pick a stack', status: 'in_progress' });
  w.pc.addDecision({
    issueId: issue.id,
    title: 'Database choice',
    body: 'Which **database** should we use?',
    options: [
      { id: 'pg', label: 'Postgres', description: 'Reliable and boring', effects: [] },
      { id: 'lite', label: 'SQLite', effects: [] },
    ],
  });
  await bot.pollOnce();
  const message = w.tg.sent().find((m) => m.text.startsWith('<b>Decision</b>'));
  assert.equal(message.rich, true);
  assert.ok(message.text.includes('\n\n> Which **database** should we use?\n\n- Postgres: Reliable and boring\n- SQLite'));
  assert.equal(validateRichMarkdown(message.text), null);

  await tap(w, bot, message, 'SQLite');
  const after = w.tg.messages.get(message.message_id);
  assert.equal(after.rich, true);
  assert.ok(w.tg.callsTo('editMessageText').every((call) => call.params.rich_message && call.params.text === undefined));
  assert.ok(after.text.endsWith('\n\nDecided: SQLite'), after.text);
  assert.deepEqual(rowsOf(w, message.message_id), []);
});

test('a message that was sent classic is edited classic even when rich messages are on', async (t) => {
  const { w, bot } = await setup(t, { config: { richMessages: 'off' } });
  const issue = w.pc.addIssue({ title: 'Plan the launch', description: 'First **draft**', status: 'todo' });
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  const view = w.tg.lastMessage();
  bot.richOff = false;
  await tap(w, bot, view, 'More');
  w.pc.issues.get(issue.id).description = 'Second **draft**';
  await tap(w, bot, view, 'Refresh');

  const [edit] = w.tg.callsTo('editMessageText');
  assert.equal(edit.params.rich_message, undefined);
  assert.ok(edit.params.text.includes('Second **draft**'));
  assert.equal(edit.params.parse_mode, 'HTML');
  assert.equal(w.tg.messages.get(view.message_id).rich, false);
});

test('a rich message is still edited as one after a restart', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Plan the launch', description: 'First **draft**', status: 'todo' });
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  const view = w.tg.lastMessage();
  bot.state.save();

  const restarted = w.makeBot();
  assert.equal(restarted.state.isRich(view.message_id), true);
  await tap(w, restarted, view, 'More');
  w.pc.issues.get(issue.id).description = 'Second **draft**';
  await tap(w, restarted, view, 'Refresh');
  assert.ok(w.tg.callsTo('editMessageText')[0].params.rich_message);
});

test('the rich message ids are saved, bounded and forgotten with the chat', (t) => {
  const file = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'rich-state-')), 'state.json');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const state = new State(file);
  state.adoptChat(-100);
  state.noteRich(5);
  state.noteRich(6);
  state.dropRich(5);
  state.save();

  const loaded = State.load(file);
  assert.equal(loaded.isRich(5), false);
  assert.equal(loaded.isRich(6), true);
  for (let i = 0; i < 2100; i += 1) loaded.noteRich(1000 + i);
  assert.ok(loaded.richMessages.size <= 2000);
  assert.equal(loaded.isRich(1000 + 2099), true);
  assert.equal(loaded.isRich(6), false, 'the oldest ids go first');
  loaded.adoptChat(-200);
  assert.equal(loaded.richMessages.size, 0);
});

// --- documents ---------------------------------------------------------------------------------

async function openDocument(w, bot, issue, label) {
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  const view = w.tg.lastMessage();
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Docs');
  const before = w.tg.sent().length;
  await tap(w, bot, view, label);
  return w.tg.sent().slice(before);
}

const section = (title, paragraphs) => `## ${title}\n\n${Array.from({ length: paragraphs }, (_, i) => `${title} paragraph ${i} ${'x'.repeat(100)}`).join('\n\n')}`;

test('a document that fits is one rich message under its title', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Docs', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan & scope', body: '# Heading\n\nSee [the task](/TST/issues/TST-2)\n\n```\n<b>code</b>\n```' });
  const parts = await openDocument(w, bot, issue, 'Plan');

  assert.equal(parts.length, 1);
  assert.equal(parts[0].rich, true);
  assert.equal(parts[0].text, `<b>Plan &amp; scope</b>\n\n# Heading\n\nSee [the task](${UI_BASE_URL}/TST/issues/TST-2)\n\n\`\`\`\n<b>code</b>\n\`\`\``);
  assert.equal(validateRichMarkdown(parts[0].text), null);
  assert.deepEqual(parts[0].markup, null);
});

test('a long document is split at headings, one rich message per part', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Docs', status: 'todo' });
  const body = [section('Alpha', 200), section('Beta', 200)].join('\n\n');
  assert.ok(body.length > 32768 && body.length < 2 * 32768 - 1000);
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body });
  const parts = await openDocument(w, bot, issue, 'Plan');

  assert.equal(parts.length, 2);
  assert.ok(parts.every((part) => part.rich));
  assert.ok(parts[0].text.startsWith('<b>Plan</b>\n\n## Alpha\n\n'));
  assert.ok(parts[1].text.startsWith('## Beta\n\nBeta paragraph 0'), parts[1].text.slice(0, 40));
  for (const part of parts) assert.equal(validateRichMarkdown(part.text), null);
  assert.ok(!parts.at(-1).text.includes('Full text in Paperclip'));
  assert.equal(plainSends(w).filter((call) => call.params.text.includes('paragraph')).length, 0, 'no part went as plain text');
});

test('a document of more than three parts ends with a link to the full text', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Docs', status: 'todo' });
  const body = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((title) => section(title, 160)).join('\n\n');
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body });
  const parts = await openDocument(w, bot, issue, 'Plan');

  assert.equal(parts.length, 3);
  assert.ok(parts.every((part) => part.rich));
  assert.ok(parts[2].text.endsWith(`\n\n[Full text in Paperclip](${ISSUE_URL}#document-plan)`));
  assert.ok(!parts[0].text.includes('Full text in Paperclip'));
  for (const part of parts) assert.equal(validateRichMarkdown(part.text), null);
});

test('a document keeps single newlines as they are', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Docs', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: '# Plan\nline one\nline two\n\n- a\n- b' });
  const [part] = await openDocument(w, bot, issue, 'Plan');

  assert.equal(part.text, '<b>Plan</b>\n\n# Plan\nline one\nline two\n\n- a\n- b');
});

test('a document with a line longer than a message ends with a link to the full text', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Docs', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: `# Plan\n\n${'word '.repeat(8000)}` });
  const parts = await openDocument(w, bot, issue, 'Plan');

  assert.ok(parts.length >= 1 && parts.length <= 3);
  assert.ok(parts.every((part) => part.rich));
  assert.ok(parts.at(-1).text.endsWith(`\n\n[Full text in Paperclip](${ISSUE_URL}#document-plan)`));
  assert.equal(parts.filter((part) => part.text.includes('Full text in Paperclip')).length, 1);
  for (const part of parts) {
    assert.ok(part.text.length <= 32768, `${part.text.length} units`);
    assert.equal(validateRichMarkdown(part.text), null);
  }
});

test('a document of mostly astral characters goes out whole, every part within the UTF-16 limit', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Docs', status: 'todo' });
  const lines = Array.from({ length: 400 }, () => ASTRAL.repeat(80));
  assert.ok(Array.from(lines.join('\n')).length <= 32000 + 400);
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: lines.join('\n') });
  const parts = await openDocument(w, bot, issue, 'Plan');

  assert.ok(parts.length >= 2 && parts.length <= 3, `${parts.length} parts`);
  assert.ok(parts.every((part) => part.rich));
  for (const part of parts) assert.ok(part.text.length <= 32768, `${part.text.length} units`);
  assert.ok(!parts.at(-1).text.includes('Full text in Paperclip'));
  const sent = parts.map((part) => part.text.replace('<b>Plan</b>\n\n', '')).join('\n').split('\n');
  assert.equal(sent.length, 400, 'every line arrived');
  assert.equal(plainSends(w).filter((call) => call.params.text.includes(ASTRAL)).length, 0);
});

test('a document is plain text when Telegram refuses the first rich part', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Docs', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: 'Step <one> & two' });
  w.tg.refuseRich({ times: 1 });
  const parts = await openDocument(w, bot, issue, 'Plan');

  assert.equal(parts.length, 1);
  assert.equal(parts[0].rich, undefined);
  assert.equal(parts[0].text, '<b>Plan</b>\nStep &lt;one&gt; &amp; two');
});

test('a document goes on as plain text from the part Telegram refuses', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Docs', status: 'todo' });
  const body = [section('Alpha', 200), section('Beta', 200)].join('\n\n');
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body });
  w.tg.failNext('sendRichMessage', 400, refusal, 1, (params) => !params.rich_message.markdown.startsWith('<b>Plan</b>'));
  const parts = await openDocument(w, bot, issue, 'Plan');

  assert.equal(parts[0].rich, true);
  assert.ok(parts.length >= 2);
  assert.ok(parts.slice(1).every((part) => !part.rich));
  assert.ok(parts[1].text.startsWith('## Beta\n\nBeta paragraph 0'), parts[1].text.slice(0, 40));
  assert.ok(!parts[1].text.includes('<b>Plan</b>'), 'no second title');
});

test('with richMessages off a document is plain text as before', async (t) => {
  const { w, bot } = await setup(t, { config: { richMessages: 'off' } });
  const issue = w.pc.addIssue({ title: 'Docs', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: 'Step <one> & two' });
  const parts = await openDocument(w, bot, issue, 'Plan');

  assert.equal(parts.length, 1);
  assert.equal(parts[0].text, '<b>Plan</b>\nStep &lt;one&gt; &amp; two');
  assert.equal(richSends(w).length, 0);
});
