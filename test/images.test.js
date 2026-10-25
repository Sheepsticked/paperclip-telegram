import assert from 'node:assert/strict';
import test from 'node:test';
import { followIssue } from '../src/follow.js';
import { DOCUMENT_LIMIT_BYTES, PHOTO_LIMIT_BYTES, linkedAttachmentIds } from '../src/images.js';
import { PaperclipClient, PaperclipError } from '../src/paperclip.js';
import { State } from '../src/state.js';
import { TelegramClient, TelegramError } from '../src/telegram.js';
import { PAPERCLIP_TOKEN, TELEGRAM_TOKEN, UI_BASE_URL, startWorld } from './helpers.js';

const GROUP_ID = -1001234567890;
const FORUM = { telegram: { chatId: GROUP_ID, forum: true }, config: { topics: 'auto' } };
const MB = 1024 * 1024;

async function setup(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  return { w, bot: await w.primedBot() };
}

async function followed(w, bot, fields = {}) {
  const issue = w.pc.addIssue({ title: 'Followed work', status: 'in_progress', assigneeAgentId: 'agent-1', ...fields });
  await followIssue(bot, issue);
  return issue;
}

// A PNG header (signature and IHDR) followed by `tag`, so each image has its own bytes.
function png({ width = 8, height = 8, tag = '' } = {}) {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12);
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(tag)]);
}

const link = (attachment) => `![shot](/api/attachments/${attachment.id}/content)`;
// A comment that is not one of the done / in-review messages.
const followMessages = (w) => w.tg.sent().filter((m) => !/^<b>(Done|In review)<\/b>/.test(m.text));
// The done / in-review message in General (thread null) or in a topic; the pinned board also starts with such a word.
const statusMessage = (w, kind, thread = null) => w.tg.sent().find((m) => m.thread === thread && new RegExp(`^<b>(?:<a [^>]*>)?${kind}(?:</a>)?</b>`).test(m.text));
const listReads = (w) => w.pc.requests.filter((r) => r.method === 'GET' && /^\/api\/issues\/[^/]+\/attachments$/.test(r.path));
const contentReads = (w) => w.pc.requests.filter((r) => r.method === 'GET' && /^\/api\/attachments\/[^/]+\/content$/.test(r.path));
const uploadCalls = (w) => w.tg.calls.filter((c) => ['sendPhoto', 'sendDocument', 'sendMediaGroup'].includes(c.method));
const warnings = (w) => w.logs.err.filter((line) => line.startsWith('warn '));
const imageWarnings = (w) => warnings(w).filter((line) => /image/.test(line));

test('an image the comment links to is sent under it as a silent photo reply, and the text keeps its link', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const shot = w.pc.addAttachment(issue.id, { name: 'board.png', data: png({ tag: 'board' }) });
  w.pc.addComment(issue.id, { body: `Here is the board\n\n${link(shot)}` });
  await bot.pollOnce();

  const [message] = followMessages(w);
  assert.ok(message.text.includes(`/api/attachments/${shot.id}/content`), 'the link stays in the text');
  const [photo] = w.tg.pictures();
  assert.deepEqual(
    { method: photo.method, kind: photo.kind, name: photo.name, type: photo.type, silent: photo.silent, replyTo: photo.replyTo, thread: photo.thread, caption: photo.caption, group: photo.group },
    { method: 'sendPhoto', kind: 'photo', name: 'board.png', type: 'image/png', silent: true, replyTo: message.message_id, thread: null, caption: null, group: null },
  );
  assert.ok(photo.messageId > message.message_id);
  assert.deepEqual(photo.data, png({ tag: 'board' }));
  assert.deepEqual(uploadCalls(w).map((call) => call.params), [
    { chat_id: w.tg.chatId, disable_notification: true, reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } },
  ]);
  assert.equal(listReads(w).length, 1, 'the attachment list is read once');
  assert.equal(contentReads(w).length, 1);
  assert.ok(bot.state.hasSentImage(shot.id));
  assert.deepEqual(imageWarnings(w), []);
});

test('the picture of a rich comment replies to the rich message', async (t) => {
  const { w, bot } = await setup(t, { config: { richMessages: 'auto' } });
  const issue = await followed(w, bot);
  const shot = w.pc.addAttachment(issue.id, { data: png() });
  w.pc.addComment(issue.id, { body: `Result\n\n${link(shot)}` });
  await bot.pollOnce();

  const [message] = w.tg.richMessages();
  assert.ok(message, 'the comment went out as a rich message');
  assert.equal(w.tg.pictures()[0].replyTo, message.message_id);
});

test('an image bound to the comment is sent although the text does not link it', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const comment = w.pc.addComment(issue.id, { body: 'Attached the result' });
  w.pc.addAttachment(issue.id, { name: 'bound.jpg', type: 'image/jpeg', data: 'JPEG', commentId: comment.id });
  w.pc.addAttachment(issue.id, { name: 'other.png', data: png() });
  await bot.pollOnce();

  assert.deepEqual(w.tg.pictures().map((picture) => [picture.name, picture.type, picture.kind]), [['bound.jpg', 'image/jpeg', 'photo']]);
});

test('an image the text links and one that is bound both go, the linked one first', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const comment = w.pc.addComment(issue.id, { body: 'placeholder' });
  const bound = w.pc.addAttachment(issue.id, { name: 'bound.png', data: png({ tag: 'b' }), commentId: comment.id });
  const linked = w.pc.addAttachment(issue.id, { name: 'linked.png', data: png({ tag: 'l' }) });
  comment.body = `Both: ${link(linked)} ${link(bound)}`;
  await bot.pollOnce();

  assert.deepEqual(w.tg.pictures().map((picture) => picture.name), ['linked.png', 'bound.png']);
  assert.equal(w.tg.callsTo('sendMediaGroup').length, 1, 'bound and linked are the same attachment once');
});

test('an absolute link under the UI base URL counts; a link on another host and a plain link do not mislead', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const mine = w.pc.addAttachment(issue.id, { name: 'mine.png', data: png({ tag: 'm' }) });
  const foreign = w.pc.addAttachment(issue.id, { name: 'foreign.png', data: png({ tag: 'f' }) });
  const plain = w.pc.addAttachment(issue.id, { name: 'plain.png', data: png({ tag: 'p' }) });
  w.pc.addComment(issue.id, {
    body: `![a](${UI_BASE_URL}/api/attachments/${mine.id}/content) ![b](https://elsewhere.example.org/api/attachments/${foreign.id}/content) [plain.png](/api/attachments/${plain.id}/content)`,
  });
  await bot.pollOnce();

  assert.deepEqual(w.tg.pictures().map((picture) => picture.name), ['mine.png', 'plain.png']);
});

test('an SVG and a PDF stay links and are not downloaded', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const svg = w.pc.addAttachment(issue.id, { name: 'logo.svg', type: 'image/svg+xml', data: '<svg/>' });
  const pdf = w.pc.addAttachment(issue.id, { name: 'spec.pdf', type: 'application/pdf', data: '%PDF' });
  const shot = w.pc.addAttachment(issue.id, { name: 'shot.png', data: png() });
  w.pc.addComment(issue.id, { body: `${link(svg)}\n[spec](/api/attachments/${pdf.id}/content)\n${link(shot)}` });
  await bot.pollOnce();

  assert.deepEqual(w.tg.pictures().map((picture) => picture.name), ['shot.png']);
  assert.equal(contentReads(w).length, 1);
  assert.ok(followMessages(w)[0].text.includes(`/api/attachments/${svg.id}/content`));
});

test('an attachment of another task is ignored', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const other = w.pc.addIssue({ title: 'Other work', status: 'todo' });
  const foreign = w.pc.addAttachment(other.id, { name: 'other.png', data: png() });
  w.pc.addComment(issue.id, { body: `Look: ${link(foreign)}` });
  await bot.pollOnce();

  assert.equal(followMessages(w).length, 1);
  assert.deepEqual(w.tg.pictures(), []);
  assert.equal(contentReads(w).length, 0);
});

test('two to ten images go as one album in the order the text links them, without a caption', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const [a, b, c] = ['a', 'b', 'c'].map((tag) => w.pc.addAttachment(issue.id, { name: `${tag}.png`, data: png({ tag }) }));
  w.pc.addComment(issue.id, { body: `${link(c)} ${link(a)} ${link(b)}` });
  await bot.pollOnce();

  const [message] = followMessages(w);
  assert.equal(w.tg.callsTo('sendPhoto').length, 0);
  const [call] = w.tg.callsTo('sendMediaGroup');
  assert.deepEqual(call.params.media, [0, 1, 2].map((i) => ({ type: 'photo', media: `attach://file${i}` })));
  assert.equal(call.params.caption, undefined);
  assert.deepEqual(call.params.reply_parameters, { message_id: message.message_id, allow_sending_without_reply: true });
  assert.equal(call.params.disable_notification, true);
  const pictures = w.tg.pictures();
  assert.deepEqual(pictures.map((picture) => picture.name), ['c.png', 'a.png', 'b.png']);
  assert.equal(new Set(pictures.map((picture) => picture.group)).size, 1);
  assert.ok(pictures.every((picture) => picture.silent && picture.replyTo === message.message_id));
  assert.equal(listReads(w).length, 1);
});

test('more than ten images send the first ten and leave the rest as links', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const all = Array.from({ length: 12 }, (_, i) => w.pc.addAttachment(issue.id, { name: `shot-${i}.png`, data: png({ tag: `n${i}` }) }));
  w.pc.addComment(issue.id, { body: all.map(link).join('\n') });
  await bot.pollOnce();

  assert.equal(w.tg.callsTo('sendMediaGroup').length, 1);
  assert.deepEqual(w.tg.pictures().map((picture) => picture.name), all.slice(0, 10).map((a) => a.originalFilename));
  assert.equal(contentReads(w).length, 10, 'the rest is not even downloaded');
  assert.ok(!bot.state.hasSentImage(all[10].id));
  assert.ok(followMessages(w)[0].text.includes(all[11].id), 'the text keeps every link');
});

test('a GIF and an image over 10 MB go as documents, up to 20 MB', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const gif = w.pc.addAttachment(issue.id, { name: 'loop.gif', type: 'image/gif', data: 'GIF89a' });
  const big = w.pc.addAttachment(issue.id, { name: 'big.png', data: Buffer.concat([png(), Buffer.alloc(PHOTO_LIMIT_BYTES, 1)]) });
  w.pc.addComment(issue.id, { body: `${link(gif)} ${link(big)}` });
  await bot.pollOnce();

  assert.equal(w.tg.callsTo('sendPhoto').length, 0);
  assert.equal(w.tg.callsTo('sendMediaGroup').length, 1, 'two documents are one album of documents');
  const pictures = w.tg.pictures();
  assert.deepEqual(pictures.map((picture) => [picture.name, picture.kind]), [['loop.gif', 'document'], ['big.png', 'document']]);
  assert.ok(pictures[1].size > PHOTO_LIMIT_BYTES);
});

test('a single document goes with sendDocument', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const gif = w.pc.addAttachment(issue.id, { name: 'loop.gif', type: 'image/gif', data: 'GIF89a' });
  w.pc.addComment(issue.id, { body: link(gif) });
  await bot.pollOnce();

  assert.deepEqual(w.tg.pictures().map((picture) => [picture.method, picture.kind, picture.type, picture.silent]), [['sendDocument', 'document', 'image/gif', true]]);
});

test('photos and documents of one comment are sent as separate groups, photos first', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const gif = w.pc.addAttachment(issue.id, { name: 'loop.gif', type: 'image/gif', data: 'GIF89a' });
  const one = w.pc.addAttachment(issue.id, { name: 'one.png', data: png({ tag: '1' }) });
  const two = w.pc.addAttachment(issue.id, { name: 'two.webp', type: 'image/webp', data: 'WEBP' });
  w.pc.addComment(issue.id, { body: `${link(gif)} ${link(one)} ${link(two)}` });
  await bot.pollOnce();

  assert.deepEqual(w.tg.calls.filter((c) => c.method.startsWith('send') && c.method !== 'sendMessage').map((c) => c.method), ['sendMediaGroup', 'sendDocument']);
  assert.deepEqual(w.tg.pictures().map((picture) => [picture.name, picture.kind]), [['one.png', 'photo'], ['two.webp', 'photo'], ['loop.gif', 'document']]);
});

test('the size limits are 10 MB for a photo and 20 MB for anything; the byte size is read before the download', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const edge = w.pc.addAttachment(issue.id, { name: 'edge.png', data: png(), size: PHOTO_LIMIT_BYTES });
  const over = w.pc.addAttachment(issue.id, { name: 'over.png', data: png({ tag: 'o' }), size: PHOTO_LIMIT_BYTES + 1 });
  const top = w.pc.addAttachment(issue.id, { name: 'top.png', data: png({ tag: 't' }), size: DOCUMENT_LIMIT_BYTES });
  const huge = w.pc.addAttachment(issue.id, { name: 'huge.png', data: png({ tag: 'h' }), size: DOCUMENT_LIMIT_BYTES + 1 });
  w.pc.addComment(issue.id, { body: [edge, over, top, huge].map(link).join(' ') });
  await bot.pollOnce();

  assert.deepEqual(
    w.tg.pictures().map((picture) => [picture.name, picture.kind]),
    [['edge.png', 'photo'], ['over.png', 'document'], ['top.png', 'document']],
  );
  assert.equal(contentReads(w).length, 3, 'the image over 20 MB is never downloaded');
  assert.ok(!bot.state.hasSentImage(huge.id));
  assert.equal(followMessages(w).length, 1, 'the comment is out anyway');
});

test('a download that runs past its limit while streaming is dropped', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const liar = w.pc.addAttachment(issue.id, { name: 'liar.png', data: Buffer.concat([png(), Buffer.alloc(PHOTO_LIMIT_BYTES + MB, 1)]), size: 2 * MB });
  w.pc.addComment(issue.id, { body: link(liar) });
  await bot.pollOnce();

  assert.equal(followMessages(w).length, 1);
  assert.deepEqual(w.tg.pictures(), []);
  assert.equal(imageWarnings(w).length, 1);
  assert.ok(!bot.state.hasSentImage(liar.id));
});

test('an image is sent once: a later comment, a restart and a done message do not send it again', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const shot = w.pc.addAttachment(issue.id, { name: 'shot.png', data: png() });
  w.pc.addComment(issue.id, { body: `First ${link(shot)}` });
  await bot.pollOnce();
  w.pc.addComment(issue.id, { body: `Second, same picture ${link(shot)}` });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 2);
  assert.equal(w.tg.pictures().length, 1);

  const restarted = w.makeBot();
  w.pc.addComment(issue.id, { body: `Third, after a restart ${link(shot)}` });
  await restarted.pollOnce();
  assert.equal(followMessages(w).length, 3);
  assert.equal(w.tg.pictures().length, 1);

  w.pc.addComment(issue.id, { body: `Done, ${link(shot)}` });
  w.pc.setStatus(issue.id, 'done');
  await restarted.pollOnce();
  assert.ok(statusMessage(w, 'Done').text.includes('Done, '), 'the done message quotes the last comment');
  assert.equal(w.tg.pictures().length, 1);
  assert.equal(contentReads(w).length, 1);
});

test('the done message that quotes a comment sends its image silently under the alert', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Ship it', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.pollOnce();
  const shot = w.pc.addAttachment(issue.id, { name: 'result.png', data: png() });
  w.pc.addComment(issue.id, { body: `All finished\n\n${link(shot)}` });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();

  const done = statusMessage(w, 'Done');
  assert.ok(done && !done.silent, 'the done message of a top-level task makes a sound');
  const [photo] = w.tg.pictures();
  assert.equal(photo.replyTo, done.message_id);
  assert.equal(photo.silent, true);
  assert.equal(photo.caption, null);
});

test('an in-review message that does not quote a comment sends no images', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const shot = w.pc.addAttachment(issue.id, { name: 'shot.png', data: png() });
  w.pc.addComment(issue.id, { body: `Ready ${link(shot)}`, authorType: 'user' });
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();

  assert.ok(statusMessage(w, 'In review'));
  assert.deepEqual(w.tg.pictures(), []);
  assert.equal(listReads(w).length, 0);
});

test('in a task topic the pictures reply in the same topic, under a comment, an in-review message and a done alert', async (t) => {
  const { w, bot } = await setup(t, FORUM);
  const issue = w.pc.addIssue({ title: 'Plan the launch', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.pollOnce();
  const draft = w.pc.addAttachment(issue.id, { name: 'draft.png', data: png({ tag: 'd' }) });
  w.pc.addComment(issue.id, { body: `Draft ${link(draft)}` });
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();

  const { thread } = bot.state.topics.get(issue.id);
  const review = statusMessage(w, 'In review', thread);
  assert.equal(review.thread, thread);
  const [first] = w.tg.pictures();
  assert.deepEqual([first.name, first.thread, first.replyTo, first.silent], ['draft.png', thread, review.message_id, true]);
  assert.equal(uploadCalls(w)[0].params.message_thread_id, thread);

  w.pc.setStatus(issue.id, 'in_progress');
  await followIssue(bot, issue);
  const final = w.pc.addAttachment(issue.id, { name: 'final.png', data: png({ tag: 'f' }) });
  w.pc.addComment(issue.id, { body: `Final ${link(final)}` });
  await bot.pollOnce();
  const comment = followMessages(w).at(-1);
  assert.equal(comment.thread, thread);
  const second = w.tg.pictures().at(-1);
  assert.deepEqual([second.name, second.thread, second.replyTo], ['final.png', thread, comment.message_id]);

  const ship = w.pc.addAttachment(issue.id, { name: 'ship.png', data: png({ tag: 's' }) });
  w.pc.addComment(issue.id, { body: `Shipped ${link(ship)}` });
  w.pc.setStatus(issue.id, 'done');
  await bot.pollOnce();
  const done = statusMessage(w, 'Done', thread);
  assert.ok(done.text.includes(`tg://user?id=${w.tg.userId}`), 'the alert mentions the owner');
  const last = w.tg.pictures().at(-1);
  assert.deepEqual([last.name, last.thread, last.replyTo, last.silent, last.caption], ['ship.png', thread, done.message_id, true, null]);
  assert.ok(uploadCalls(w).every((call) => call.params.caption === undefined && call.params.disable_notification === true));
});

const postedComments = (w) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comments'));

test('a reply to a picture, single or from an album, is a comment on the task of the comment above it', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const [a, b, c] = ['a', 'b', 'c'].map((tag) => w.pc.addAttachment(issue.id, { name: `${tag}.png`, data: png({ tag }) }));
  w.pc.addComment(issue.id, { body: `${link(a)} ${link(b)}` });
  await bot.pollOnce();
  w.pc.addComment(issue.id, { body: link(c) });
  await bot.pollOnce();

  const [first, second, third] = w.tg.pictures();
  for (const picture of [first, second, third]) {
    const before = postedComments(w).length;
    await bot.handleUpdate(w.tg.message(`About ${picture.name}`, { replyTo: picture.messageId }));
    assert.equal(postedComments(w).length, before + 1, `a reply to ${picture.name} is a comment`);
    assert.equal(postedComments(w).at(-1).path, `/api/issues/${issue.id}/comments`);
  }
  assert.deepEqual(postedComments(w).map((r) => r.body.body), ['About a.png', 'About b.png', 'About c.png']);
});

test('a reply to a picture of a subtask in its parent\'s topic is a comment on the subtask', async (t) => {
  const { w, bot } = await setup(t, FORUM);
  const parent = w.pc.addIssue({ title: 'Plan the launch', status: 'in_progress', assigneeAgentId: 'agent-1' });
  const child = w.pc.addIssue({ title: 'Draw the logo', status: 'in_progress', assigneeAgentId: 'agent-1', parentId: parent.id });
  await bot.pollOnce();
  await followIssue(bot, child);
  const logo = w.pc.addAttachment(child.id, { name: 'logo.png', data: png({ tag: 'l' }) });
  w.pc.addComment(child.id, { body: `Sketch ${link(logo)}` });
  await bot.pollOnce();

  const { thread } = bot.state.topics.get(parent.id);
  const [picture] = w.tg.pictures();
  assert.equal(picture.thread, thread, 'the subtask talks in the topic of its parent');
  await bot.handleUpdate(w.tg.message('Nice', { replyTo: picture.messageId, thread }));
  assert.deepEqual(postedComments(w).map((r) => r.path), [`/api/issues/${child.id}/comments`]);
});

test('a failed list, download or upload leaves the comment, logs one short warning and sends no more', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const shot = w.pc.addAttachment(issue.id, { name: 'shot.png', data: png() });

  w.pc.failRequests('GET', /\/attachments$/, 500, 1);
  w.pc.addComment(issue.id, { body: `List fails ${link(shot)}` });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 1);
  assert.equal(imageWarnings(w).length, 1);

  w.pc.failRequests('GET', /\/content$/, 500, 1);
  w.pc.addComment(issue.id, { body: `Download fails ${link(shot)}` });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 2);
  assert.equal(imageWarnings(w).length, 2);

  w.tg.failNext('sendPhoto', 500, { ok: false, error_code: 500, description: 'Internal Server Error' }, Infinity);
  w.pc.addComment(issue.id, { body: `Upload fails ${link(shot)}` });
  await bot.pollOnce();
  assert.equal(followMessages(w).length, 3);
  assert.equal(imageWarnings(w).length, 3);
  assert.equal(w.tg.callsTo('sendPhoto').length, 1, 'no retry loop');

  await bot.pollOnce();
  assert.equal(w.tg.callsTo('sendPhoto').length, 1);
  assert.deepEqual(w.tg.pictures(), []);
  assert.ok(!bot.state.hasSentImage(shot.id));
  const text = w.allLogText();
  assert.ok(!text.includes('/api/attachments') && !text.includes(UI_BASE_URL) && !text.includes(shot.id), 'the warnings hold no URL or id');
  assert.ok(!text.includes(TELEGRAM_TOKEN) && !text.includes(PAPERCLIP_TOKEN));
});

test('a failed image upload under a done message does not send the done message twice', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Ship it', status: 'in_progress', assigneeAgentId: 'agent-1' });
  await bot.pollOnce();
  const shot = w.pc.addAttachment(issue.id, { name: 'result.png', data: png() });
  w.pc.addComment(issue.id, { body: `Finished ${link(shot)}` });
  w.pc.setStatus(issue.id, 'done');
  w.tg.failNext('sendPhoto', 500, { ok: false, error_code: 500, description: 'Internal Server Error' }, Infinity);
  await bot.pollOnce();
  await bot.pollOnce();

  assert.equal(w.tg.sent().filter((m) => m.text.startsWith('<b>Done</b>')).length, 1);
  assert.equal(bot.state.statusRetries.size, 0);
  assert.equal(imageWarnings(w).length, 1);
});

test('one image that cannot be downloaded does not stop the others', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const bad = w.pc.addAttachment(issue.id, { name: 'bad.png', data: png({ tag: 'x' }) });
  const good = w.pc.addAttachment(issue.id, { name: 'good.png', data: png({ tag: 'y' }) });
  w.pc.failRequests('GET', new RegExp(`/api/attachments/${bad.id}/content$`), 404, 1);
  w.pc.addComment(issue.id, { body: `${link(bad)} ${link(good)}` });
  await bot.pollOnce();

  assert.deepEqual(w.tg.pictures().map((picture) => [picture.method, picture.name]), [['sendPhoto', 'good.png']]);
  assert.ok(!bot.state.hasSentImage(bad.id));
  assert.ok(bot.state.hasSentImage(good.id));
});

test('a photo Telegram refuses for its dimensions is sent again as a document', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  // Sides adding up to over 10000, and a ratio over 20.
  const wide = w.pc.addAttachment(issue.id, { name: 'wide.png', data: png({ width: 9000, height: 3000 }) });
  const strip = w.pc.addAttachment(issue.id, { name: 'strip.png', data: png({ width: 4000, height: 100 }) });
  for (const attachment of [wide, strip]) {
    w.pc.addComment(issue.id, { body: link(attachment) });
    await bot.pollOnce();
    assert.ok(bot.state.hasSentImage(attachment.id));
  }

  assert.deepEqual(w.tg.calls.filter((c) => c.method === 'sendPhoto' || c.method === 'sendDocument').map((c) => c.method), ['sendPhoto', 'sendDocument', 'sendPhoto', 'sendDocument']);
  assert.deepEqual(w.tg.pictures().map((picture) => [picture.method, picture.name, picture.silent]), [['sendDocument', 'wide.png', true], ['sendDocument', 'strip.png', true]]);
  assert.deepEqual(imageWarnings(w), []);
});

test('an album Telegram refuses is sent one by one, the refused photo as a document', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const wide = w.pc.addAttachment(issue.id, { name: 'wide.png', data: png({ width: 9000, height: 3000 }) });
  const fine = w.pc.addAttachment(issue.id, { name: 'fine.png', data: png({ tag: 'f' }) });
  w.pc.addComment(issue.id, { body: `${link(wide)} ${link(fine)}` });
  await bot.pollOnce();

  assert.equal(w.tg.callsTo('sendMediaGroup').length, 1);
  assert.deepEqual(w.tg.pictures().map((picture) => [picture.method, picture.name]), [['sendDocument', 'wide.png'], ['sendPhoto', 'fine.png']]);
  assert.ok(w.tg.pictures().every((picture) => picture.silent && picture.group === null));
});

test('a refusal of both the photo and the document is one warning', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const wide = w.pc.addAttachment(issue.id, { name: 'wide.png', data: png({ width: 9000, height: 3000 }) });
  w.pc.addComment(issue.id, { body: link(wide) });
  w.tg.failNext('sendDocument', 400, { ok: false, error_code: 400, description: 'Bad Request: file must be non-empty' });
  await bot.pollOnce();

  assert.deepEqual(w.tg.pictures(), []);
  assert.equal(imageWarnings(w).length, 1);
  assert.equal(followMessages(w).length, 1);
});

test('a summary, a turned-off comment and a text-only comment cost no download, and only a shown comment reads the list', async (t) => {
  const { w, bot } = await setup(t);
  const issue = await followed(w, bot);
  const shot = w.pc.addAttachment(issue.id, { name: 'shot.png', data: png() });
  for (let i = 0; i < 6; i += 1) w.pc.addComment(issue.id, { body: `Update ${i} ${link(shot)}` });
  await bot.pollOnce();
  assert.equal(w.tg.pictures().length, 0, 'six comments are one summary, not six messages with pictures');
  assert.equal(listReads(w).length, 0);

  bot.state.settings.followedComments = false;
  w.pc.addComment(issue.id, { body: `Quiet ${link(shot)}` });
  await bot.pollOnce();
  assert.equal(w.tg.pictures().length, 0);
  assert.equal(listReads(w).length, 0);

  bot.state.settings.followedComments = true;
  w.pc.addComment(issue.id, { body: 'Text only' });
  await bot.pollOnce();
  assert.equal(listReads(w).length, 1);
  assert.equal(contentReads(w).length, 0);
});

test('linkedAttachmentIds finds relative links and links under the UI base URL', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const other = 'AAAAAAAA-d9cb-469f-a165-70867728950e';
  const base = 'https://paperclip.example.com';
  const ids = (body) => linkedAttachmentIds(body, base);
  assert.deepEqual(ids(`![x](/api/attachments/${id}/content)`), [id]);
  assert.deepEqual(ids(`[f.png](/api/attachments/${id}/content?download=1)`), [id]);
  assert.deepEqual(ids(`<${base}/api/attachments/${id}/content>`), [id]);
  assert.deepEqual(ids(`see ${base}/api/attachments/${id}.`), [id]);
  assert.deepEqual(linkedAttachmentIds(`![x](${base}/api/attachments/${id}/content)`, `${base}/`), [id], 'a trailing slash in the base is fine');
  assert.deepEqual(ids(`${base}/api/attachments/${id}/content and /api/attachments/${other.toUpperCase()}/content and /api/attachments/${id}`), [id, other.toLowerCase()], 'listed once, lower case');
  assert.deepEqual(ids(`https://elsewhere.example.org/api/attachments/${id}/content`), []);
  assert.deepEqual(ids(`${base}.evil.example/api/attachments/${id}/content`), []);
  assert.deepEqual(ids(`/other/api/attachments/${id}/content`), []);
  assert.deepEqual(ids(`/api/attachments/${id}0/content`), []);
  assert.deepEqual(ids('/api/attachments/not-an-id/content'), []);
  assert.deepEqual(ids(null), []);
});

test('State remembers sent images in a bounded list, keeps them across a save and drops them with the chat', (t) => {
  const state = new State('/nonexistent/state.json');
  for (let i = 0; i < 501; i += 1) state.noteImageSent(`image-${i}`);
  assert.ok(!state.hasSentImage('image-0'));
  assert.ok(state.hasSentImage('image-1'));
  assert.ok(state.hasSentImage('image-500'));
  assert.equal(state.sentImages.size, 500);

  const loaded = new State('/nonexistent/state.json', JSON.parse(JSON.stringify(state)));
  assert.ok(loaded.hasSentImage('image-500'));
  assert.ok(!loaded.hasSentImage('image-0'));
  assert.equal(new State('/nonexistent/state.json', { sentImages: [1, 'ok', null] }).sentImages.size, 1);

  loaded.adoptChat(1);
  assert.ok(loaded.hasSentImage('image-500'), 'the first chat is simply taken');
  loaded.adoptChat(2);
  assert.equal(loaded.sentImages.size, 0);
});

test('downloadAttachment returns the bytes and refuses a body over the cap, a failed status and a dropped connection', async () => {
  const calls = [];
  const replies = [
    () => new Response(Buffer.from('abcdef'), { status: 200 }),
    () => new Response(Buffer.from('abcdef'), { status: 200 }),
    () => new Response('{"error":"Attachment not found"}', { status: 404, statusText: 'Not Found' }),
    () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    },
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return replies[calls.length - 1]();
  };
  const client = new PaperclipClient({ baseUrl: 'http://paperclip.test', token: 'pcp_board_x', fetchImpl });

  assert.deepEqual(await client.downloadAttachment('att-1', { maxBytes: 6 }), Buffer.from('abcdef'));
  assert.equal(calls[0].url, 'http://paperclip.test/api/attachments/att-1/content');
  assert.equal(calls[0].init.headers.authorization, 'Bearer pcp_board_x');
  await assert.rejects(client.downloadAttachment('att-1', { maxBytes: 5 }), (err) => err instanceof PaperclipError && err.status === 413);
  await assert.rejects(client.downloadAttachment('att-2'), (err) => err instanceof PaperclipError && err.status === 404);
  await assert.rejects(client.downloadAttachment('att-3'), (err) => err instanceof PaperclipError && err.network && err.detail === 'ECONNRESET');
});

test('the Telegram uploads send multipart with string fields, and an album names its files', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  };
  const client = new TelegramClient({ baseUrl: 'http://telegram.test', token: 'TOKEN', fetchImpl });
  const params = { chat_id: -100123, disable_notification: true, message_thread_id: 7, reply_parameters: { message_id: 9, allow_sending_without_reply: true } };
  const file = { name: 'a.png', type: 'image/png', data: Buffer.from('abc') };

  await client.sendPhoto(params, file);
  await client.sendDocument(params, { ...file, name: 'b.gif', type: 'image/gif' });
  await client.sendMediaGroup(params, 'photo', [file, { ...file, name: 'c.png' }]);

  assert.deepEqual(calls.map((call) => call.url), ['sendPhoto', 'sendDocument', 'sendMediaGroup'].map((method) => `http://telegram.test/botTOKEN/${method}`));
  const [photo, document, album] = calls.map((call) => call.init.body);
  assert.ok(calls.every((call) => call.init.body instanceof FormData && call.init.headers === undefined));
  assert.deepEqual([...photo.keys()], ['chat_id', 'disable_notification', 'message_thread_id', 'reply_parameters', 'photo']);
  assert.equal(photo.get('chat_id'), '-100123');
  assert.equal(photo.get('disable_notification'), 'true');
  assert.equal(photo.get('reply_parameters'), '{"message_id":9,"allow_sending_without_reply":true}');
  assert.deepEqual([photo.get('photo').name, photo.get('photo').type, photo.get('photo').size], ['a.png', 'image/png', 3]);
  assert.deepEqual([document.get('document').name, document.get('document').type], ['b.gif', 'image/gif']);
  assert.equal(album.get('media'), '[{"type":"photo","media":"attach://file0"},{"type":"photo","media":"attach://file1"}]');
  assert.deepEqual([album.get('file0').name, album.get('file1').name], ['a.png', 'c.png']);
});

test('an upload answered with 429 is sent again after the wait, and a refusal is a TelegramError without the token', async () => {
  const replies = [
    { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } } },
    { status: 200, body: { ok: true, result: { message_id: 1 } } },
    { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' } },
  ];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const { status, body } = replies[calls.length - 1];
    return new Response(JSON.stringify(body), { status });
  };
  const waits = [];
  const client = new TelegramClient({ baseUrl: 'http://telegram.test', token: 'SECRET-TOKEN', fetchImpl, sleep: async (ms) => waits.push(ms) });
  const file = { name: 'a.png', type: 'image/png', data: Buffer.from('abc') };

  await client.sendPhoto({ chat_id: 1 }, file);
  assert.deepEqual(waits, [1000]);
  assert.equal(calls[0].init.body.get('photo').size, 3);
  assert.equal(calls[1].init.body.get('photo').size, 3, 'the file is sent again whole');
  await assert.rejects(client.sendPhoto({ chat_id: 1 }, file), (err) => err instanceof TelegramError && err.code === 400 && !err.message.includes('SECRET-TOKEN'));
});
