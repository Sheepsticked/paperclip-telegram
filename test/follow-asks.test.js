import assert from 'node:assert/strict';
import test from 'node:test';
import { sendCard } from '../src/actions.js';
import { followIssue } from '../src/follow.js';
import { confirmPayload, startWorld } from './helpers.js';

const RUN = '11111111-2222-4333-8444-555555555555';

async function setup(t) {
  const w = await startWorld();
  t.after(() => w.close());
  const bot = await w.primedBot();
  const parent = w.pc.addIssue({ title: 'Make the game', status: 'in_progress', assigneeAgentId: 'agent-1' });
  const issue = w.pc.addIssue({ title: 'Pick a look', status: 'in_progress', assigneeAgentId: 'agent-1', parentId: parent.id });
  return { w, bot, issue };
}

const card = (w, issue, fields = {}) => w.pc.addInteraction(issue.id, { kind: 'request_confirmation', payload: confirmPayload(), ...fields });
const sentWith = (w, needle) => w.tg.sent().filter((m) => m.text.includes(needle) && !/^<b>Question<\/b>/.test(m.text));

test('a card on an unfollowed subtask follows it; its comment is sent once and a later comment once', async (t) => {
  const { w, bot, issue } = await setup(t);
  w.pc.addComment(issue.id, { body: 'Three looks to choose from', createdByRunId: RUN });
  card(w, issue, { sourceRunId: RUN });
  assert.ok(!bot.state.isFollowing(issue.id));
  await bot.pollOnce();

  assert.ok(bot.state.isFollowing(issue.id));
  assert.equal(sentWith(w, 'Three looks to choose from').length, 1);
  assert.ok(w.tg.findMessage('Question'));

  w.pc.addComment(issue.id, { body: 'Look 3 it is' });
  await bot.pollOnce();
  await bot.pollOnce();
  assert.equal(sentWith(w, 'Look 3 it is').length, 1);
  assert.equal(sentWith(w, 'Three looks to choose from').length, 1, 'the card comment is not sent again');
});

test('the card comment is not sent again even when the follow cursor is before it', async (t) => {
  const { w, bot, issue } = await setup(t);
  w.pc.addComment(issue.id, { body: 'Card comment', createdByRunId: RUN });
  card(w, issue, { sourceRunId: RUN });
  await bot.pollOnce();
  // The cursor is moved back before the card comment, so only the shown-comment memory keeps it out.
  bot.state.following.get(issue.id).lastSeenCommentId = null;
  bot.state.following.get(issue.id).lastSeenAt = null;
  w.pc.addComment(issue.id, { body: 'Next comment' });
  await bot.pollOnce();

  assert.equal(sentWith(w, 'Card comment').length, 1);
  assert.equal(sentWith(w, 'Next comment').length, 1);
});

test('a card on a done task does not follow it, whether or not the card names the status', async (t) => {
  const { w, bot, issue } = await setup(t);
  w.pc.setStatus(issue.id, 'done');
  const interaction = card(w, issue);
  const ref = { id: issue.id, identifier: issue.identifier, title: issue.title };
  await sendCard(bot, interaction, { ...ref, status: 'done' });
  await sendCard(bot, interaction, ref);

  assert.equal(w.tg.sent().filter((m) => /^<b>Question<\/b>/.test(m.text)).length, 2);
  assert.ok(!bot.state.isFollowing(issue.id));
});

test('a card on a followed task leaves the follow as it was', async (t) => {
  const { w, bot, issue } = await setup(t);
  w.pc.addComment(issue.id, { body: 'Before' });
  await followIssue(bot, issue);
  const order = [...bot.state.following.keys()];
  w.pc.addComment(issue.id, { body: 'Unread comment' });
  card(w, issue);
  await bot.pollOnce();

  assert.deepEqual([...bot.state.following.keys()], order);
  assert.equal(sentWith(w, 'Unread comment').length, 1, 'the follow poll still sends from the old cursor');
});

test('a reply posted on an unfollowed task follows it, and the agent answer reaches the chat', async (t) => {
  const { w, bot, issue } = await setup(t);
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  const review = w.tg.findMessage('In review');
  assert.ok(!bot.state.isFollowing(issue.id));

  await bot.handleUpdate(w.tg.message('Center every heading', { replyTo: review.message_id }));
  assert.equal(w.pc.comments.at(-1).body, 'Center every heading');
  assert.ok(bot.state.isFollowing(issue.id));

  w.pc.addComment(issue.id, { body: 'Every heading is in the middle now' });
  await bot.pollOnce();
  assert.equal(sentWith(w, 'Every heading is in the middle now').length, 1);
  assert.equal(sentWith(w, 'Center every heading').length, 0, 'the owner comment is not sent back');
});

test('with Followed comments off a card still follows the task but its later comments are not sent', async (t) => {
  const { w, bot, issue } = await setup(t);
  bot.state.settings.followedComments = false;
  card(w, issue);
  await bot.pollOnce();
  assert.ok(bot.state.isFollowing(issue.id));

  w.pc.addComment(issue.id, { body: 'Quiet comment' });
  await bot.pollOnce();
  assert.equal(sentWith(w, 'Quiet comment').length, 0);
});

test('a card follows its task whatever Follow new tasks is set to', async (t) => {
  const { w, bot, issue } = await setup(t);
  bot.state.settings.autoFollowCreated = false;
  card(w, issue);
  await bot.pollOnce();
  assert.ok(bot.state.isFollowing(issue.id));
});
