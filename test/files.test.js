import assert from 'node:assert/strict';
import test from 'node:test';
import { fileOf } from '../src/files.js';
import { TELEGRAM_TOKEN, startWorld } from './helpers.js';

const GROUP_ID = -1001234567890;

async function setup(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const bot = await w.primedBot();
  return { w, bot };
}

const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const uploads = (w) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/attachments'));
const comments = (w) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/comments'));
const creates = (w) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/issues'));
const tap = (w, bot, message, label) => bot.handleUpdate(w.tg.tapButton(message.message_id, label));

async function openTask(w, bot, issue) {
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  return w.tg.lastMessage();
}

test('a photo sent as a reply to a task message is uploaded and commented on the task', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Fix the layout', status: 'in_progress' });
  const view = await openTask(w, bot, issue);
  const file = w.tg.addFile({ name: 'shot.jpg', data: 'PHOTO-BYTES', kind: 'photo' });

  const update = w.tg.photoUpdate(file, { replyTo: view.message_id });
  await bot.handleUpdate(update);

  assert.deepEqual(w.tg.downloads.map((d) => d.tokenOk), [true]);
  assert.equal(w.tg.downloads[0].path, file.path);
  assert.equal(uploads(w).length, 1);
  assert.equal(uploads(w)[0].path, `/api/companies/${w.pc.companyId}/issues/${issue.id}/attachments`);
  assert.match(uploads(w)[0].headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.deepEqual(uploads(w)[0].body, {
    multipart: [{ name: 'file', filename: `photo-${update.message.message_id}.jpg`, type: 'image/jpeg', size: 11 }],
  });
  assert.equal(w.pc.attachments[0].data.toString(), 'PHOTO-BYTES');

  assert.equal(comments(w).length, 1);
  assert.deepEqual(comments(w)[0].body, { body: `Attachment: photo-${update.message.message_id}.jpg`, attachmentIds: [w.pc.attachments[0].id] });
  assert.equal(w.pc.attachments[0].commentId, w.pc.comments.at(-1).id);
  assert.equal(w.tg.lastMessage().text, 'Attached to TST-1');
  assert.equal(w.tg.lastMessage().replyTo, update.message.message_id);
});

test('the largest photo size is the one that is downloaded', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Sizes', status: 'todo' });
  const view = await openTask(w, bot, issue);
  const file = w.tg.addFile({ name: 'big.jpg', data: 'THE-LARGE-ONE', kind: 'photo' });
  await bot.handleUpdate(w.tg.photoUpdate(file, { replyTo: view.message_id }));
  assert.equal(w.tg.downloads.length, 1);
  assert.equal(w.tg.downloads[0].path, file.path);
});

test('a caption becomes the comment text', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Caption', status: 'todo' });
  const view = await openTask(w, bot, issue);
  const file = w.tg.addFile({ name: 'shot.jpg', data: 'x', kind: 'photo' });
  await bot.handleUpdate(w.tg.photoUpdate(file, { replyTo: view.message_id, caption: 'This is how it looks now' }));
  assert.equal(comments(w)[0].body.body, 'This is how it looks now');
  assert.equal(comments(w)[0].body.attachmentIds.length, 1);
});

test('a document keeps its name and type', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Report', status: 'todo' });
  const view = await openTask(w, bot, issue);
  const file = w.tg.addFile({ name: 'report <final>.pdf', data: '%PDF-1.4' });
  await bot.handleUpdate(w.tg.documentUpdate(file, { replyTo: view.message_id, mime: 'application/pdf' }));
  assert.deepEqual(uploads(w)[0].body.multipart, [{ name: 'file', filename: 'report <final>.pdf', type: 'application/pdf', size: 8 }]);
  assert.equal(comments(w)[0].body.body, 'Attachment: report <final>.pdf');
  assert.equal(w.tg.lastMessage().text, 'Attached to TST-1');
});

test('a file replied to a card or a status message belongs to that task', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Long job', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  const status = w.tg.findMessage('In review');
  const file = w.tg.addFile({});
  await bot.handleUpdate(w.tg.documentUpdate(file, { replyTo: status.message_id }));
  assert.equal(uploads(w)[0].path.includes(issue.id), true);
  assert.equal(w.tg.lastMessage().text, 'Attached to TST-1');
});

test('a file replied to a message that is about no task is declined', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message('/settings'));
  const settings = w.tg.lastMessage();
  const file = w.tg.addFile({});
  await bot.handleUpdate(w.tg.documentUpdate(file, { replyTo: settings.message_id }));
  assert.equal(w.tg.lastMessage().text, "I don't know which task this is");
  assert.equal(w.tg.downloads.length, 0);
  assert.equal(uploads(w).length, 0);
});

test('a file with no caption and no reply asks for a caption', async (t) => {
  const { w, bot } = await setup(t);
  const file = w.tg.addFile({ name: 'shot.jpg', kind: 'photo' });
  await bot.handleUpdate(w.tg.photoUpdate(file));
  assert.equal(w.tg.lastMessage().text, 'Add a caption to make a task, or reply to a task message to attach it');
  assert.equal(w.tg.downloads.length, 0);
  assert.equal(creates(w).length, 0);
});

test('a captioned photo offers a task, and the task gets the photo after it is created', async (t) => {
  const { w, bot } = await setup(t);
  const file = w.tg.addFile({ name: 'shot.jpg', data: 'SCREENSHOT', kind: 'photo' });
  const update = w.tg.photoUpdate(file, { caption: 'Login page is broken\nSee the picture' });
  await bot.handleUpdate(update);

  const offer = w.tg.lastMessage();
  assert.equal(offer.text, 'Create a task from this?');
  assert.equal(offer.replyTo, update.message.message_id);
  assert.deepEqual(rowsOf(w, offer.message_id), [['For Lead', 'Other agent', 'Cancel']]);
  assert.equal(creates(w).length, 0);
  assert.equal(w.tg.downloads.length, 0, 'nothing is downloaded before the owner agrees');

  await tap(w, bot, offer, 'For Lead');
  assert.equal(creates(w).length, 1);
  assert.equal(creates(w)[0].body.title, 'Login page is broken');
  assert.equal(creates(w)[0].body.description, 'Login page is broken\nSee the picture');
  const issue = [...w.pc.issues.values()][0];
  assert.equal(uploads(w).length, 1);
  assert.ok(uploads(w)[0].path.includes(issue.id));
  assert.equal(w.pc.attachments[0].data.toString(), 'SCREENSHOT');
  assert.deepEqual(comments(w)[0].body, { body: `Attachment: photo-${update.message.message_id}.jpg`, attachmentIds: [w.pc.attachments[0].id] });
  assert.equal(w.tg.messages.get(offer.message_id).text, `Created for Lead\nAttached: photo-${update.message.message_id}.jpg`);
  assert.deepEqual(rowsOf(w, offer.message_id), []);
});

test('the offer with a file goes through the agent choice and survives a restart', async (t) => {
  const { w, bot } = await setup(t);
  const file = w.tg.addFile({ name: 'spec.pdf', data: 'SPEC' });
  await bot.handleUpdate(w.tg.documentUpdate(file, { caption: 'Review the spec', mime: 'application/pdf' }));
  const offer = w.tg.lastMessage();
  await tap(w, bot, offer, 'Other agent');

  const restarted = w.makeBot();
  await restarted.handleUpdate(w.tg.tapButton(offer.message_id, 'Dev'));
  assert.equal(creates(w)[0].body.assigneeAgentId, 'agent-1');
  assert.deepEqual(uploads(w)[0].body.multipart, [{ name: 'file', filename: 'spec.pdf', type: 'application/pdf', size: 4 }]);
  assert.match(w.tg.messages.get(offer.message_id).text, /^Created for Dev\nAttached: spec\.pdf$/);
});

test('cancelling the offer drops the file with it', async (t) => {
  const { w, bot } = await setup(t);
  const file = w.tg.addFile({ name: 'shot.jpg', kind: 'photo' });
  await bot.handleUpdate(w.tg.photoUpdate(file, { caption: 'Not now' }));
  await tap(w, bot, w.tg.lastMessage(), 'Cancel');
  assert.equal(creates(w).length, 0);
  assert.equal(uploads(w).length, 0);
  assert.equal(w.tg.downloads.length, 0);
  assert.equal(bot.state.offers.size, 0);
});

test('a task that was created is kept when its file cannot be attached', async (t) => {
  const { w, bot } = await setup(t);
  const file = w.tg.addFile({ name: 'shot.jpg', data: 'x', kind: 'photo' });
  await bot.handleUpdate(w.tg.photoUpdate(file, { caption: 'Look at this' }));
  const offer = w.tg.lastMessage();
  w.tg.failDownloads(500);
  await tap(w, bot, offer, 'For Lead');
  assert.equal(creates(w).length, 1);
  assert.equal(w.tg.messages.get(offer.message_id).text, 'Created for Lead\nThe file could not be attached: Could not download the file from Telegram.');
  assert.equal(bot.state.offers.size, 0);
});

test('a file over the 20 MB limit is declined before any download', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Video', status: 'todo' });
  const view = await openTask(w, bot, issue);
  const big = w.tg.addFile({ name: 'movie.mp4', data: 'x', size: 25 * 1024 * 1024 });
  await bot.handleUpdate(w.tg.documentUpdate(big, { replyTo: view.message_id }));
  assert.equal(w.tg.lastMessage().text, 'That file is over the 20 MB limit for bots.');
  assert.equal(w.tg.callsTo('getFile').length, 0);
  assert.equal(w.tg.downloads.length, 0);
  assert.equal(uploads(w).length, 0);
});

test('a file Telegram refuses as too big is declined the same way', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Video', status: 'todo' });
  const view = await openTask(w, bot, issue);
  const big = w.tg.addFile({ name: 'movie.mp4', data: 'x', size: 25 * 1024 * 1024 });
  // A message that does not state the size is only refused by getFile.
  const update = w.tg.message(undefined, { replyTo: view.message_id, extra: { document: { file_id: big.id, file_name: 'movie.mp4' } } });
  await bot.handleUpdate(update);
  assert.equal(w.tg.callsTo('getFile').length, 1);
  assert.equal(w.tg.lastMessage().text, 'That file is over the 20 MB limit for bots.');
  assert.equal(uploads(w).length, 0);
});

test('a file over the 20 MB limit that comes with a caption is declined when the task is created', async (t) => {
  const { w, bot } = await setup(t);
  const big = w.tg.addFile({ name: 'movie.mp4', data: 'x', size: 25 * 1024 * 1024 });
  await bot.handleUpdate(w.tg.documentUpdate(big, { caption: 'Watch this' }));
  await tap(w, bot, w.tg.lastMessage(), 'For Lead');
  assert.equal(creates(w).length, 1);
  assert.match(w.tg.findMessage('Created for Lead').text, /\nThe file could not be attached: That file is over the 20 MB limit for bots\.$/);
});

test('a file Paperclip refuses is reported with the server text and no comment is posted', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Large', status: 'todo' });
  const view = await openTask(w, bot, issue);
  const file = w.tg.addFile({ name: 'dump.bin', data: 'x'.repeat(10 * 1024 * 1024 + 1) });
  await bot.handleUpdate(w.tg.documentUpdate(file, { replyTo: view.message_id }));
  assert.equal(uploads(w).length, 1);
  assert.equal(comments(w).length, 0);
  assert.match(w.tg.lastMessage().text, /Attachment is larger than the 10 MB limit/);
  assert.ok(!w.tg.sent().some((m) => m.text.startsWith('Attached')));
});

test('a comment that fails after the upload is reported and nothing says Attached', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Flaky', status: 'todo' });
  const view = await openTask(w, bot, issue);
  w.pc.failRequests('POST', /\/comments$/, 500, 1);
  await bot.handleUpdate(w.tg.documentUpdate(w.tg.addFile({}), { replyTo: view.message_id }));
  assert.equal(uploads(w).length, 1);
  assert.ok(!w.tg.sent().some((m) => m.text.startsWith('Attached')));
  assert.match(w.tg.lastMessage().text, /500/);
});

test('the download URL and the token are never logged or sent, even when the download fails', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Failing', status: 'todo' });
  const view = await openTask(w, bot, issue);
  const file = w.tg.addFile({ name: 'secret-name.txt', data: 'x' });
  const leaks = () => {
    const visible = [w.allLogText(), ...w.tg.sent().map((m) => m.text), ...w.tg.callbackAnswers.map((a) => a.text)].join('\n');
    return ['/file/bot', TELEGRAM_TOKEN, 'documents/file_'].filter((needle) => visible.includes(needle));
  };

  await bot.handleUpdate(w.tg.documentUpdate(file, { replyTo: view.message_id }));
  assert.equal(w.tg.lastMessage().text, 'Attached to TST-1');
  assert.deepEqual(leaks(), []);

  w.tg.failDownloads(500);
  await bot.handleUpdate(w.tg.documentUpdate(file, { replyTo: view.message_id }));
  assert.equal(w.tg.lastMessage().text, 'Could not download the file from Telegram.');
  assert.deepEqual(leaks(), []);

  w.tg.failDownloads(null);
  w.tg.dropDownloads();
  await bot.handleUpdate(w.tg.documentUpdate(file, { replyTo: view.message_id }));
  assert.equal(w.tg.lastMessage().text, 'Could not download the file from Telegram.');
  assert.deepEqual(leaks(), []);
  assert.ok(w.tg.downloads.length >= 3, 'the downloads were attempted');
});

test('a download error carries only the method name and a short reason, never the URL', async (t) => {
  const { w, bot } = await setup(t);
  w.tg.failDownloads(500);
  const file = w.tg.addFile({ name: 'a.txt' });
  await assert.rejects(bot.tg.downloadFile(file.path, { maxBytes: 1024 }), (err) => {
    assert.equal(err.message, 'telegram downloadFile failed: 500 Internal Server Error');
    assert.ok(!err.message.includes(file.path));
    assert.ok(!err.message.includes(TELEGRAM_TOKEN));
    assert.ok(!String(err.stack).includes(TELEGRAM_TOKEN));
    return true;
  });
  w.tg.failDownloads(null);
  w.tg.dropDownloads();
  await assert.rejects(bot.tg.downloadFile(file.path, { maxBytes: 1024 }), (err) => {
    assert.ok(!err.message.includes(file.path));
    assert.ok(!err.message.includes(TELEGRAM_TOKEN));
    return true;
  });
  w.tg.dropDownloads(false);
  await assert.rejects(bot.tg.downloadFile(file.path, { maxBytes: 2 }), (err) => err.message === 'telegram downloadFile failed: 413 file is too big');
});

test('a file from another user or chat is ignored', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Mine', status: 'todo' });
  const view = await openTask(w, bot, issue);
  const file = w.tg.addFile({ name: 'shot.jpg', kind: 'photo' });
  const sent = w.tg.sent().length;
  const requests = w.pc.requests.length;
  await bot.handleUpdate(w.tg.photoUpdate(file, { replyTo: view.message_id, from: 2002 }));
  await bot.handleUpdate(w.tg.photoUpdate(file, { replyTo: view.message_id, chat: 9999 }));
  await bot.handleUpdate(w.tg.photoUpdate(file, { caption: 'Make a task', from: 2002 }));
  assert.equal(w.tg.sent().length, sent);
  assert.equal(w.pc.requests.length, requests);
  assert.equal(w.tg.downloads.length, 0);
  assert.equal(w.tg.callsTo('getFile').length, 0);
});

test('a file written in a task topic is attached to that task without a reply', async (t) => {
  const { w, bot } = await setup(t, { telegram: { chatId: GROUP_ID, forum: true } });
  const issue = w.pc.addIssue({ title: 'Plan the launch', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  const { thread } = bot.state.topics.get(issue.id);

  const file = w.tg.addFile({ name: 'shot.jpg', data: 'x', kind: 'photo' });
  await bot.handleUpdate(w.tg.photoUpdate(file, { thread }));
  assert.equal(uploads(w).length, 1);
  assert.ok(uploads(w)[0].path.includes(issue.id));
  assert.equal(w.tg.lastMessage().text, 'Attached to TST-1');
  assert.equal(w.tg.lastMessage().thread, thread);
});

test('a captioned file in an unknown topic offers a task and attaches the file to it', async (t) => {
  const { w, bot } = await setup(t, { telegram: { chatId: GROUP_ID, forum: true } });
  const thread = w.tg.ownerTopic('Ideas');
  const file = w.tg.addFile({ name: 'sketch.jpg', data: 'SKETCH', kind: 'photo' });

  await bot.handleUpdate(w.tg.photoUpdate(file, { thread }));
  assert.equal(w.tg.lastMessage().text, 'Add a caption to make a task, or reply to a task message to attach it');
  assert.equal(w.tg.lastMessage().thread, thread);

  await bot.handleUpdate(w.tg.photoUpdate(file, { thread, caption: 'Build a paper robot' }));
  const offer = w.tg.lastMessage();
  assert.equal(offer.text, 'Create a task from this?');
  assert.equal(offer.thread, thread);
  await tap(w, bot, offer, 'For Lead');
  const issue = [...w.pc.issues.values()][0];
  assert.equal(bot.state.topics.get(issue.id).thread, thread);
  assert.equal(uploads(w).length, 1);
  assert.ok(uploads(w)[0].path.includes(issue.id));
  assert.equal(w.pc.attachments[0].data.toString(), 'SKETCH');
});

test('a sticker or other media is still declined', async (t) => {
  const { w, bot } = await setup(t);
  await bot.handleUpdate(w.tg.message(undefined, { extra: { sticker: { file_id: 'x' } } }));
  assert.match(w.tg.lastMessage().text, /^Send text to create a task/);
  assert.equal(w.tg.downloads.length, 0);
});

test('fileOf reads photos and documents and nothing else', () => {
  assert.equal(fileOf({ message_id: 1, text: 'hello' }), null);
  assert.equal(fileOf({ message_id: 1, sticker: { file_id: 'x' } }), null);
  assert.deepEqual(fileOf({ message_id: 7, photo: [{ file_id: 'a', file_size: 10 }, { file_id: 'b', file_size: 99 }, { file_id: 'c', file_size: 50 }] }), {
    fileId: 'b',
    name: 'photo-7.jpg',
    mime: 'image/jpeg',
    size: 99,
  });
  assert.deepEqual(fileOf({ message_id: 8, document: { file_id: 'd' } }), { fileId: 'd', name: 'file-8', mime: 'application/octet-stream', size: null });
});

test('every callback of the offer with a file stays within 64 bytes', async (t) => {
  const { w, bot } = await setup(t);
  const file = w.tg.addFile({ name: 'shot.jpg', kind: 'photo' });
  await bot.handleUpdate(w.tg.photoUpdate(file, { caption: 'Check the sizes' }));
  const offer = w.tg.lastMessage();
  for (const b of w.tg.buttons(offer.message_id)) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
});
