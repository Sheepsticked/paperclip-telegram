import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { followIssue } from '../src/follow.js';
import { validateTelegramHtml } from './fakes/telegram.js';
import { UI_BASE_URL, startWorld } from './helpers.js';

async function setup(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const bot = await w.primedBot();
  return { w, bot };
}

const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const followMessages = (w) => w.tg.sent().filter((m) => m.text.startsWith('<b>Comment</b>'));

async function followed(w, bot, fields = {}) {
  const issue = w.pc.addIssue({ title: 'Followed work', status: 'in_progress', assigneeAgentId: 'agent-1', ...fields });
  await followIssue(bot, issue);
  return issue;
}

test('a new agent comment on a followed task is sent with an excerpt and a task button', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  w.pc.addComment(issue.id, { body: 'Found the <root> cause & fixed it.' });
  await bot.pollOnce();

  const [message] = followMessages(w);
  assert.equal(
    message.text,
    `<b>Comment</b> · TST-1 Followed work\nFrom Dev\n<blockquote>Found the &lt;root&gt; cause &amp; fixed it.</blockquote>\n<a href="${UI_BASE_URL}/TST/issues/TST-1">Open in Paperclip</a>`,
  );
  assert.equal(validateTelegramHtml(message.text), null);
  assert.deepEqual(rowsOf(w, message.message_id), [['Open task']]);
  assert.equal(w.tg.buttons(message.message_id)[0].callback_data, `T:v:${issue.id}`);

  await bot.handleUpdate(w.tg.message('Thanks!', { replyTo: message.message_id }));
  assert.deepEqual(w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comments')).map((r) => r.body), [{ body: 'Thanks!' }]);
});

test('a comment is sent once and comments before following are not replayed', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Has history', status: 'in_progress' });
  w.pc.addComment(issue.id, { body: 'Old news' });
  await followIssue(bot, issue);
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 0);

  w.pc.addComment(issue.id, { body: 'Fresh news' });
  await bot.pollOnce();
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 1);
  assert.ok(followMessages(w)[0].text.includes('Fresh news'));
});

test('the owner\'s own comments are not sent but move the cursor', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  w.pc.addComment(issue.id, { body: 'My own words', authorType: 'user' });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 0);
  const mine = w.pc.comments.at(-1);
  assert.equal(bot.state.following.get(issue.id).lastSeenCommentId, mine.id);
});

test('agents that post as the local board user, system notes and deleted comments are handled', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  w.pc.addComment(issue.id, { body: 'Posted by Dev through the board key', authorType: 'user', authorAgentId: null, authorUserId: 'local-board', derivedAuthorAgentId: 'agent-1' });
  w.pc.addComment(issue.id, { body: 'Unknown poster', authorType: 'user', authorAgentId: null, authorUserId: 'local-board' });
  w.pc.addComment(issue.id, { body: 'Run finished', authorType: 'system', authorAgentId: null, authorUserId: null });
  w.pc.addComment(issue.id, { body: 'Taken back', deletedAt: new Date().toISOString() });
  await bot.pollOnce();

  const heads = followMessages(w).map((m) => m.text.split('\n').slice(0, 2));
  assert.deepEqual(heads, [
    ['<b>Comment</b> · TST-1 Followed work', 'From Dev'],
    ['<b>Comment</b> · TST-1 Followed work', 'From An agent'],
    ['<b>Comment</b> · TST-1 Followed work', 'From System'],
  ]);
  assert.ok(!w.tg.sent().some((m) => m.text.includes('Taken back')));
});

test('an excerpt is cut at five lines and 400 characters', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  w.pc.addComment(issue.id, { body: Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n') });
  w.pc.addComment(issue.id, { body: 'x'.repeat(2000) });
  await bot.pollOnce();

  const [lines, long] = followMessages(w);
  assert.match(lines.text, /<blockquote>line 1\nline 2\nline 3\nline 4\nline 5…<\/blockquote>/);
  assert.ok(!lines.text.includes('line 6'));
  const quote = /<blockquote>([^<]*)<\/blockquote>/.exec(long.text)[1];
  assert.ok(quote.length <= 401);
  assert.ok(quote.endsWith('…'));
});

test('up to five new comments are sent one by one, more are summarised', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  for (let i = 1; i <= 5; i += 1) w.pc.addComment(issue.id, { body: `Step ${i}` });
  await bot.pollOnce();
  assert.deepEqual(
    followMessages(w).map((m) => /Step \d/.exec(m.text)[0]),
    ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5'],
  );

  for (let i = 6; i <= 11; i += 1) w.pc.addComment(issue.id, { body: `Step ${i}` });
  await bot.pollOnce();
  const burst = followMessages(w).at(-1);
  assert.equal(followMessages(w).length, 6);
  assert.match(burst.text, /^<b>Comment<\/b> · TST-1 Followed work\n6 new comments\n<a href="[^"]+">Open in Paperclip<\/a>$/);
  assert.deepEqual(rowsOf(w, burst.message_id), [['Open task']]);
  assert.equal(bot.state.following.get(issue.id).lastSeenCommentId, w.pc.comments.at(-1).id);
});

test('a long comment backlog is read in pages and summarised', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  for (let i = 0; i < 120; i += 1) w.pc.addComment(issue.id, { body: `Note ${i}` });
  w.pc.requests.length = 0;
  await bot.pollOnce();

  assert.match(followMessages(w).at(-1).text, /^120 new comments$/m);
  const reads = w.pc.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/comments'));
  assert.equal(reads.length, 3);
  assert.match(reads[0].query, /order=asc/);
  assert.match(reads[1].query, /after=/);
  assert.equal(bot.state.following.get(issue.id).lastSeenCommentId, w.pc.comments.at(-1).id);
});

test('the cursor survives a restart', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  w.pc.addComment(issue.id, { body: 'Before restart' });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 1);

  const saved = JSON.parse(fs.readFileSync(w.statePath, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.following[issue.id].identifier, 'TST-1');

  const restarted = w.makeBot();
  await restarted.pollOnce();
  w.pc.addComment(issue.id, { body: 'After restart' });
  await restarted.pollOnce();
  assert.equal(followMessages(w).length, 2);
  assert.ok(followMessages(w)[1].text.includes('After restart'));
});

test('an unfollowed task sends nothing', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  bot.state.unfollow(issue.id);
  w.pc.addComment(issue.id, { body: 'Nobody listens' });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 0);
});

test('a done message that quotes the last comment is the only message and ends the follow', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  w.pc.addComment(issue.id, { body: 'All finished, see the result.' });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  const sent = w.tg.sent().filter((m) => m.text.includes('All finished'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^<b>Done<\/b> · TST-1/);
  assert.equal(bot.state.following.size, 0, 'a finished task is no longer followed');
});

test('an in-review message that quotes a comment does not repeat it, later comments still arrive', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  w.pc.addComment(issue.id, { body: 'Ready for review' });
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  assert.equal(w.tg.sent().filter((m) => m.text.includes('Ready for review')).length, 1);
  assert.equal(followMessages(w).length, 0);
  assert.ok(bot.state.isFollowing(issue.id));

  w.pc.addComment(issue.id, { body: 'Addressed the feedback' });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 1);
});

test('a cancelled task sends its last comments and then stops being followed', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  w.pc.addComment(issue.id, { body: 'Stopping here' });
  w.pc.setStatus(issue.id, 'cancelled');
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 1);
  assert.equal(bot.state.following.size, 0);
});

test('a followed task that vanished is dropped, and one failing task does not stop the others', async (t) => {
  const { w, bot } = await setup(t);
  const broken = await followed(w, bot, { title: 'Broken one' });
  const healthy = await followed(w, bot, { title: 'Healthy one' });
  w.pc.addComment(broken.id, { body: 'Cannot be read' });
  w.pc.addComment(healthy.id, { body: 'Readable' });

  w.pc.failRequests('GET', new RegExp(`/api/issues/${broken.id}/comments$`), 500, 1);
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 1);
  assert.ok(followMessages(w)[0].text.includes('Readable'));
  assert.ok(bot.state.isFollowing(broken.id), 'a server error is retried later');
  assert.ok(w.allLogText().includes('could not follow the comments of TST-1'));

  w.pc.failRequests('GET', new RegExp(`/api/issues/${broken.id}/comments$`), 404, 1);
  w.pc.setStatus(broken.id, 'in_progress');
  await bot.pollOnce();
  assert.ok(!bot.state.isFollowing(broken.id));
  assert.ok(bot.state.isFollowing(healthy.id));
});

test('a followed task that can no longer be read is read again at most three times', async (t) => {
  const w = await startWorld();
  t.after(() => w.close());
  let clock = Date.now();
  const bot = await w.primedBot({ now: () => clock });
  const issue = await followed(w, bot, { title: 'Unreadable one' });
  w.pc.addComment(issue.id, { body: 'Cannot be read' });
  w.pc.failRequests('GET', new RegExp(`/api/issues/${issue.id}/comments$`), 500, 1);
  clock += 3_600_000;
  await bot.pollOnce();
  assert.equal(bot.state.following.get(issue.id).retry, 1);

  const reads = () => w.pc.requestsTo('GET', new RegExp(`/api/issues/${issue.id}$`)).length;
  w.pc.failRequests('GET', new RegExp(`/api/issues/${issue.id}$`), 500);
  const before = reads();
  for (let i = 0; i < 3; i += 1) {
    clock += 3_600_000;
    await bot.pollOnce();
  }
  assert.equal(reads() - before, 2);
  assert.equal(bot.state.following.get(issue.id).retry, 0, 'the retry ended');
  assert.ok(bot.state.isFollowing(issue.id), 'the task stays followed');
  assert.ok(w.allLogText().includes('could not read followed task TST-1'));
});

test('the follow list holds fifty tasks and drops the oldest', async (t) => {
  const { w, bot } = await setup(t);
  const first = w.pc.addIssue({ title: 'Oldest' });
  await followIssue(bot, first);
  for (let i = 0; i < 49; i += 1) await followIssue(bot, w.pc.addIssue({ title: `Task ${i}` }));
  assert.equal(bot.state.following.size, 50);

  const extra = w.pc.addIssue({ title: 'One too many' });
  await bot.handleUpdate(w.tg.message(`/task ${extra.identifier}`));
  const view = w.tg.lastMessage();
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Follow'));
  assert.equal(bot.state.following.size, 50);
  assert.ok(!bot.state.isFollowing(first.id));
  assert.ok(bot.state.isFollowing(extra.id));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Following (dropped TST-1)');
});

test('followed comments can be turned off, and nothing is replayed when they come back', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  bot.state.settings.followedComments = false;
  w.pc.addComment(issue.id, { body: 'Not for now' });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 0);

  bot.state.settings.followedComments = true;
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 0);
  w.pc.addComment(issue.id, { body: 'Now' });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 1);
});

test('a rejected token during the follow read fails the poll instead of losing comments', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  w.pc.addComment(issue.id, { body: 'Do not lose me' });
  w.pc.failRequests('GET', /\/comments$/, 401, 1);
  await assert.rejects(() => bot.pollOnce(), (err) => err.status === 401);
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 1);
});

test('the cursor keeps the time of its comment and moves with every comment read', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const comment = w.pc.addComment(issue.id, { body: 'First' });
  await bot.pollOnce();
  const entry = bot.state.following.get(issue.id);
  assert.equal(entry.lastSeenCommentId, comment.id);
  assert.equal(entry.lastSeenAt, comment.createdAt);
});

test('a cursor comment the server no longer finds does not stop later comments', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Followed work', status: 'in_progress' });
  w.pc.addComment(issue.id, { body: 'Old comment' });
  await followIssue(bot, issue);
  const entry = bot.state.following.get(issue.id);
  entry.lastSeenCommentId = randomUUID();

  const newer = w.pc.addComment(issue.id, { body: 'Newer comment' });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 1);
  assert.ok(followMessages(w)[0].text.includes('Newer comment'));
  assert.equal(entry.lastSeenCommentId, newer.id, 'the cursor is a comment the server knows again');

  w.pc.addComment(issue.id, { body: 'After the repair' });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 2);
  assert.ok(followMessages(w)[1].text.includes('After the repair'));
});

test('a task that changed without a new comment does not replay comments when the cursor is gone', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Followed work', status: 'in_progress' });
  w.pc.addComment(issue.id, { body: 'Old comment' });
  await followIssue(bot, issue);
  bot.state.following.get(issue.id).lastSeenCommentId = randomUUID();

  w.pc.setStatus(issue.id, 'blocked');
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 0);
});
