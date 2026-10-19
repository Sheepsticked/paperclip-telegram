import assert from 'node:assert/strict';
import test from 'node:test';
import { splitDocument } from '../src/docs.js';
import { validateTelegramHtml } from './fakes/telegram.js';
import { UI_BASE_URL, startWorld } from './helpers.js';

async function setup(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  const bot = await w.primedBot();
  return { w, bot };
}

const rowsOf = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const tap = (w, bot, message, label, options) => bot.handleUpdate(w.tg.tapButton(message.message_id, label, options));

async function openTask(w, bot, issue) {
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  return w.tg.lastMessage();
}

// Docs sits on the second keyboard of the task view.
async function openDocs(w, bot, view) {
  await tap(w, bot, view, 'More');
  await tap(w, bot, view, 'Docs');
}

// Messages sent after `count` messages existed.
const sentSince = (w, count) => w.tg.sent().slice(count);

test('a task with documents shows a Docs button, and one without does not', async (t) => {
  const { w, bot } = await setup(t);
  const plain = w.pc.addIssue({ title: 'No documents', status: 'todo' });
  const documented = w.pc.addIssue({ title: 'With documents', status: 'todo' });
  w.pc.addDocument(documented.id, { key: 'plan', title: 'Plan', body: 'Step one' });

  const without = await openTask(w, bot, plain);
  await tap(w, bot, without, 'More');
  assert.ok(!rowsOf(w, without.message_id).flat().includes('Docs'));
  const view = await openTask(w, bot, documented);
  assert.ok(!rowsOf(w, view.message_id).flat().includes('Docs'), 'the first keyboard has no Docs');
  await tap(w, bot, view, 'More');
  assert.deepEqual(rowsOf(w, view.message_id), [['Assign', 'Project'], ['Cancel task'], ['Docs', 'Follow'], ['Comment'], ['Refresh', '◀ Back']]);
});

test('Docs turns the buttons into a list of documents with Back', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'With documents', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: 'Step one' });
  w.pc.addDocument(issue.id, { key: 'notes', title: '', body: 'Remember this' });
  const view = await openTask(w, bot, issue);
  const text = w.tg.messages.get(view.message_id).text;

  await openDocs(w, bot, view);
  assert.deepEqual(rowsOf(w, view.message_id), [['Plan · plan'], ['notes · notes'], ['◀ Back']]);
  assert.equal(w.tg.messages.get(view.message_id).text, text, 'only the buttons change');

  await tap(w, bot, view, 'Back');
  assert.deepEqual(rowsOf(w, view.message_id), [['Done', 'More']], 'Back returns to the first keyboard');
  await tap(w, bot, view, 'More');
  assert.ok(rowsOf(w, view.message_id).flat().includes('Docs'));
  assert.ok(rowsOf(w, view.message_id).flat().includes('Refresh'));
});

test('a document is sent as plain escaped text', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'With documents', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan & <scope>', body: '# Heading\n\n- item <b>one</b> & two\n\n```\ncode\n```' });
  const view = await openTask(w, bot, issue);
  await openDocs(w, bot, view);

  const before = w.tg.sent().length;
  await tap(w, bot, view, 'Plan');
  const messages = sentSince(w, before);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, '<b>Plan &amp; &lt;scope&gt;</b>\n# Heading\n\n- item &lt;b&gt;one&lt;/b&gt; &amp; two\n\n```\ncode\n```');
  assert.equal(validateTelegramHtml(messages[0].text), null);
  assert.equal(messages[0].markup, null);
  assert.ok(!messages[0].text.includes('continues in Paperclip'));
});

test('a long document is split into at most three messages and ends with a link', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Big spec', status: 'todo' });
  const body = Array.from({ length: 600 }, (_, i) => `Line ${i} with <tags> & more text to fill the space`).join('\n');
  w.pc.addDocument(issue.id, { key: 'spec', title: 'Spec', body });
  const view = await openTask(w, bot, issue);
  await openDocs(w, bot, view);

  const before = w.tg.sent().length;
  await tap(w, bot, view, 'Spec');
  const messages = sentSince(w, before);
  assert.equal(messages.length, 3);
  for (const message of messages) {
    assert.ok(message.text.length <= 3500, `${message.text.length} characters`);
    assert.equal(validateTelegramHtml(message.text), null);
  }
  assert.ok(messages[0].text.startsWith('<b>Spec</b>\nLine 0 '));
  assert.ok(messages[2].text.endsWith(`The document <a href="${UI_BASE_URL}/TST/issues/TST-1">continues in Paperclip</a>`));
  assert.ok(!messages[0].text.includes('continues in Paperclip'));
});

test('a document of two messages has no closing note', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Medium spec', status: 'todo' });
  const body = Array.from({ length: 100 }, (_, i) => `Line ${i} ${'x'.repeat(50)}`).join('\n');
  w.pc.addDocument(issue.id, { key: 'spec', title: 'Spec', body });
  const view = await openTask(w, bot, issue);
  await openDocs(w, bot, view);
  const before = w.tg.sent().length;
  await tap(w, bot, view, 'Spec');
  const messages = sentSince(w, before);
  assert.equal(messages.length, 2);
  assert.ok(messages.every((m) => !m.text.includes('continues in Paperclip') && m.text.length <= 3500));
  assert.ok(messages[1].text.includes('Line 99 '));
});

test('a very long single line is cut into valid pieces without splitting an entity', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'One line', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'blob', title: 'Blob', body: '&'.repeat(30_000) });
  const view = await openTask(w, bot, issue);
  await openDocs(w, bot, view);
  const before = w.tg.sent().length;
  await tap(w, bot, view, 'Blob');
  const messages = sentSince(w, before);
  assert.equal(messages.length, 3);
  for (const message of messages) {
    assert.ok(message.text.length <= 3500);
    assert.equal(validateTelegramHtml(message.text), null);
  }
  assert.ok(messages[2].text.includes('continues in Paperclip'));
});

test('an empty document says so', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Empty', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: '' });
  const view = await openTask(w, bot, issue);
  await openDocs(w, bot, view);
  await tap(w, bot, view, 'Plan');
  assert.equal(w.tg.lastMessage().text, '<b>Plan</b>\n(empty)');
});

test('splitDocument keeps every message within the limits', () => {
  const none = splitDocument('T', 'short');
  assert.deepEqual(none, { parts: ['<b>T</b>\nshort'], truncated: false });
  const huge = splitDocument('T', 'word '.repeat(5000));
  assert.equal(huge.parts.length, 3);
  assert.equal(huge.truncated, true);
  assert.ok(huge.parts.slice(0, 2).every((part) => part.length <= 3500));
  assert.ok(huge.parts[2].length <= 3200, 'room is left for the closing note');
});

test('a document that was deleted meanwhile is answered', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Gone', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: 'x' });
  const view = await openTask(w, bot, issue);
  await openDocs(w, bot, view);
  w.pc.documents.splice(0);
  const before = w.tg.sent().length;
  await tap(w, bot, view, 'Plan');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Document not found');
  assert.equal(w.tg.sent().length, before);
});

test('Docs on a task whose documents are gone shows the task again', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Gone', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: 'x' });
  const view = await openTask(w, bot, issue);
  await tap(w, bot, view, 'More');
  w.pc.documents.splice(0);
  await tap(w, bot, view, 'Docs');
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'No documents');
  assert.deepEqual(rowsOf(w, view.message_id), [['Done', 'More']], 'the task is shown again');
  await tap(w, bot, view, 'More');
  assert.ok(!rowsOf(w, view.message_id).flat().includes('Docs'));
});

test('document buttons from another user change nothing and every callback fits 64 bytes', async (t) => {
  const { w, bot } = await setup(t);
  const issue = w.pc.addIssue({ title: 'Docs', status: 'todo' });
  w.pc.addDocument(issue.id, { key: 'plan', title: 'Plan', body: 'x' });
  const view = await openTask(w, bot, issue);
  await tap(w, bot, view, 'More');
  const requests = w.pc.requests.length;
  await tap(w, bot, view, 'Docs', { from: 2002 });
  assert.equal(w.pc.requests.length, requests);
  await tap(w, bot, view, 'Docs');
  for (const b of w.tg.buttons(view.message_id)) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
  const sent = w.tg.sent().length;
  await tap(w, bot, view, 'Plan', { chat: 9999 });
  assert.equal(w.tg.sent().length, sent);
});
