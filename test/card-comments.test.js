import assert from 'node:assert/strict';
import test from 'node:test';
import { followIssue } from '../src/follow.js';
import { confirmPayload, startWorld } from './helpers.js';

const RUN = '11111111-2222-4333-8444-555555555555';
const OTHER_RUN = '99999999-2222-4333-8444-555555555555';

async function setup(t) {
  const w = await startWorld();
  t.after(() => w.close());
  const bot = await w.primedBot();
  const issue = w.pc.addIssue({ title: 'Design the logo', status: 'in_progress', assigneeAgentId: 'agent-1' });
  return { w, bot, issue };
}

// A PNG signature followed by `tag`, so each image has its own bytes.
const png = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
const link = (attachment) => `![shot](/api/attachments/${attachment.id}/content)`;
const card = (w, issue, fields = {}, payload = confirmPayload()) => w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload, ...fields });
const cardMessage = (w) => w.tg.sent().find((m) => /^<b>Question<\/b>/.test(m.text));
const commentMessages = (w, needle) => w.tg.sent().filter((m) => m.text.includes(needle) && !/^<b>Question<\/b>/.test(m.text));
const warnings = (w) => w.logs.err.filter((line) => line.startsWith('warn '));

test('the comment a card run posted goes out quoted with its pictures before the card', async (t) => {
  const { w, bot, issue } = await setup(t);
  const a = w.pc.addAttachment(issue.id, { name: 'a.png', data: png('a') });
  const b = w.pc.addAttachment(issue.id, { name: 'b.png', data: png('b') });
  w.pc.addComment(issue.id, { body: `Two logo options\n\n${link(a)}\n${link(b)}`, createdByRunId: RUN });
  card(w, issue, { sourceRunId: RUN });
  await bot.pollOnce();

  const [comment] = commentMessages(w, 'Two logo options');
  const question = cardMessage(w);
  assert.ok(comment && question);
  assert.ok(comment.silent, 'the comment is silent');
  assert.ok(!question.silent, 'the card keeps its sound');
  const pictures = w.tg.pictures();
  assert.deepEqual(pictures.map((p) => p.name), ['a.png', 'b.png']);
  assert.ok(pictures.every((p) => p.replyTo === comment.message_id && p.silent));
  assert.ok(comment.message_id < pictures[0].messageId && pictures.at(-1).messageId < question.message_id, 'comment, pictures, then the card');
});

test('a card that names its comment by sourceCommentId sends that comment', async (t) => {
  const { w, bot, issue } = await setup(t);
  const named = w.pc.addComment(issue.id, { body: 'The named comment' });
  w.pc.addComment(issue.id, { body: 'Another comment' });
  card(w, issue, { sourceCommentId: named.id });
  await bot.pollOnce();

  assert.equal(commentMessages(w, 'The named comment').length, 1);
  assert.equal(commentMessages(w, 'Another comment').length, 0);
  assert.ok(cardMessage(w));
});

test('only comments of the card run, made before the card, from agents, the last three, oldest first', async (t) => {
  const { w, bot, issue } = await setup(t);
  w.pc.addComment(issue.id, { body: 'Older run comment', createdByRunId: OTHER_RUN });
  w.pc.addComment(issue.id, { body: 'Owner comment', authorType: 'user', createdByRunId: RUN });
  for (const n of [1, 2, 3, 4]) w.pc.addComment(issue.id, { body: `Run comment ${n}`, createdByRunId: RUN });
  card(w, issue, { sourceRunId: RUN });
  w.pc.addComment(issue.id, { body: 'Later run comment', createdByRunId: RUN });
  await bot.pollOnce();

  const texts = w.tg.sent().map((m) => m.text);
  const shown = ['Older run comment', 'Owner comment', 'Run comment 1', 'Run comment 2', 'Run comment 3', 'Run comment 4', 'Later run comment'].filter((needle) => texts.some((text) => text.includes(needle)));
  assert.deepEqual(shown, ['Run comment 2', 'Run comment 3', 'Run comment 4']);
  const order = ['Run comment 2', 'Run comment 3', 'Run comment 4'].map((needle) => commentMessages(w, needle)[0].message_id);
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
});

test('a card with no run and no comment id sends no comment', async (t) => {
  const { w, bot, issue } = await setup(t);
  w.pc.addComment(issue.id, { body: 'Some comment', createdByRunId: RUN });
  card(w, issue);
  await bot.pollOnce();

  assert.equal(commentMessages(w, 'Some comment').length, 0);
  assert.ok(cardMessage(w));
});

test('a comment the follow poll already showed is not sent again before the card', async (t) => {
  const { w, bot, issue } = await setup(t);
  await followIssue(bot, issue);
  w.pc.addComment(issue.id, { body: 'Followed comment', createdByRunId: RUN });
  await bot.pollOnce();
  assert.equal(commentMessages(w, 'Followed comment').length, 1);

  card(w, issue, { sourceRunId: RUN });
  await bot.pollOnce();
  assert.equal(commentMessages(w, 'Followed comment').length, 1);
  assert.ok(cardMessage(w));
});

test('a comment the card path showed is not sent again by the follow poll', async (t) => {
  const { w, bot, issue } = await setup(t);
  await followIssue(bot, issue);
  const shot = w.pc.addAttachment(issue.id, { name: 'logo.png', data: png('logo') });
  w.pc.addComment(issue.id, { body: `Card comment ${link(shot)}`, createdByRunId: RUN });
  card(w, issue, { sourceRunId: RUN });
  await bot.pollOnce();
  await bot.pollOnce();

  assert.equal(commentMessages(w, 'Card comment').length, 1);
  assert.equal(w.tg.pictures().length, 1);
  assert.ok(cardMessage(w));
});

test('when the comments cannot be read the card still goes out', async (t) => {
  const { w, bot, issue } = await setup(t);
  w.pc.addComment(issue.id, { body: 'Unreadable comment', createdByRunId: RUN });
  card(w, issue, { sourceRunId: RUN });
  w.pc.failRequests('GET', /\/comments$/, 500, Infinity);
  await bot.pollOnce();

  assert.equal(commentMessages(w, 'Unreadable comment').length, 0);
  assert.ok(cardMessage(w));
  assert.ok(warnings(w).some((line) => line.includes('could not read the comments of the card')));
});

test('pictures linked in the card details reach the card as quiet replies', async (t) => {
  const { w, bot, issue } = await setup(t);
  const a = w.pc.addAttachment(issue.id, { name: 'option-a.png', data: png('a') });
  const b = w.pc.addAttachment(issue.id, { name: 'option-b.png', data: png('b') });
  card(w, issue, {}, { ...confirmPayload(), detailsMarkdown: `Pick one\n\n${link(a)}\n${link(b)}` });
  await bot.pollOnce();

  const question = cardMessage(w);
  const pictures = w.tg.pictures();
  assert.deepEqual(pictures.map((p) => p.name), ['option-a.png', 'option-b.png']);
  assert.ok(pictures.every((p) => p.replyTo === question.message_id && p.silent));
  const [saved] = bot.state.cards.values();
  assert.ok(bot.state.hasSentImage(saved.interactionId, a.id));
});
