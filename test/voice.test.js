import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.js';
import { languageName } from '../src/languages.js';
import { State } from '../src/state.js';
import { transcribeTimeoutMs } from '../src/transcribe.js';
import { lengthWords } from '../src/voice.js';
import { TELEGRAM_TOKEN, UI_BASE_URL, confirmPayload, outcomePattern, startWorld, textQuestion, questionsPayload, waitFor } from './helpers.js';

const GROUP_ID = -1001234567890;
const HOUR = 60 * 60 * 1000;
const FAKE = fileURLToPath(new URL('./fakes/transcriber.mjs', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/transcribe.py', import.meta.url));
const TASK_LINK = `<a href="${UI_BASE_URL}/TST/issues/TST-1">TST-1</a>`;

// A world whose config has a `voice` block pointing at a stand-in for the venv's Python: it drops the script path the
// bot passes and runs the fake transcriber with the rest of the arguments.
async function setup(t, { forum = false, voice = {}, noVoice = false, bot: botOptions } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-telegram-fake-python-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const python = path.join(dir, 'python');
  fs.writeFileSync(python, `#!/bin/sh\nshift\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const w = await startWorld({
    telegram: forum ? { chatId: GROUP_ID, forum: true } : {},
    config: noVoice ? {} : { voice: { python, modelsDir: path.join(dir, 'models'), ...voice } },
  });
  t.after(() => w.close());
  const bot = await w.primedBot(botOptions);
  const log = path.join(dir, 'helper.log');
  return { w, bot, dir, log, python };
}

// A voice note whose audio is the fake transcriber's job.
const note = (ctx, job, options) =>
  ctx.w.tg.voiceUpdate(ctx.w.tg.addFile({ name: 'voice.oga', kind: 'voice', data: JSON.stringify({ log: ctx.log, ...job }) }), options);

// What the helper did, in order.
const events = (ctx) => (fs.existsSync(ctx.log) ? fs.readFileSync(ctx.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

// Waits until the voice queue and the main queue have nothing left to do.
async function settled(bot) {
  await bot.voiceQueue.idle();
  await bot.queue.idle();
}

// Sends a voice note and waits for its result. Returns the update and the message that carries the result.
async function dictate(ctx, job, options) {
  const update = note(ctx, job, options);
  await ctx.bot.handleUpdate(update);
  const placeholder = ctx.w.tg.lastMessage();
  await settled(ctx.bot);
  return { update, placeholder, shown: ctx.w.tg.messages.get(placeholder.message_id) };
}

const posts = (w, suffix) => w.pc.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));
const labels = (w, id) => w.tg.buttons(id).map((b) => b.text);
const styles = (w, id) => Object.fromEntries(w.tg.buttons(id).map((b) => [b.text, b.style ?? null]));
const heard = (text) => `<b>Heard</b>\n<blockquote>${text}</blockquote>\n\n`;

// An open task whose topic exists, plus a poll that has already seen it.
async function taskWithTopic(w, bot) {
  const issue = w.pc.addIssue({ title: 'Plan the launch', status: 'in_progress' });
  await bot.pollOnce();
  w.pc.setStatus(issue.id, 'in_review');
  await bot.pollOnce();
  return { issue, thread: bot.state.topics.get(issue.id).thread };
}

// Runs the real loops until the returned function is called.
function runLoops(bot) {
  const done = bot.run();
  return async () => {
    bot.stop();
    await done;
  };
}

const pidGone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
};

test('a voice note in a task topic is shown as text; Send posts exactly that text as a comment and settles the message', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const { issue, thread } = await taskWithTopic(w, bot);

  const update = note(ctx, { mode: 'text', text: 'Please use the blue logo' }, { thread });
  await bot.handleUpdate(update);
  const reply = w.tg.lastMessage();
  assert.equal(reply.text, 'Transcribing…');
  assert.equal(reply.replyTo, update.message.message_id);
  assert.equal(reply.thread, thread);
  assert.deepEqual(w.tg.buttons(reply.message_id), []);
  await settled(bot);

  const shown = w.tg.messages.get(reply.message_id);
  assert.equal(shown.text, heard('Please use the blue logo').trimEnd());
  assert.deepEqual(labels(w, reply.message_id), ['Send', 'Cancel']);
  assert.deepEqual(styles(w, reply.message_id), { Send: 'success', Cancel: 'danger' });
  assert.equal(posts(w, '/comments').length, 0, 'nothing is posted before Send');

  await bot.handleUpdate(w.tg.tapButton(reply.message_id, 'Send'));
  const [comment] = posts(w, '/comments');
  assert.match(comment.path, new RegExp(`/api/issues/${issue.id}/comments$`));
  assert.deepEqual(comment.body, { body: 'Please use the blue logo' });
  assert.deepEqual(w.tg.reactions, [{ messageId: update.message.message_id, emoji: ['\u{1F44D}'] }]);
  assert.match(w.tg.messages.get(reply.message_id).text, outcomePattern('Sent', null, { before: heard('Please use the blue logo') }));
  assert.deepEqual(w.tg.buttons(reply.message_id), []);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Sent');
  assert.equal(bot.state.voice.size, 0);
});

test('the helper gets the downloaded audio in a private temporary directory that is removed afterwards', async (t) => {
  const ctx = await setup(t, { voice: { model: 'base', language: 'de', beamSize: 2, threads: 3 } });
  const { w } = ctx;
  await dictate(ctx, { mode: 'text', text: 'Hello' });

  assert.deepEqual(w.tg.downloads.map((d) => [d.path, d.tokenOk]), [[w.tg.files.get('file-1').path, true]]);
  const [start, end] = events(ctx);
  assert.equal(start.event, 'start');
  assert.deepEqual(start.flags, ['--model', 'base', '--models-dir', path.join(ctx.dir, 'models'), '--threads', '3', '--beam', '2', '--language', 'de']);
  assert.equal(start.dirMode, 0o700);
  assert.equal(start.fileMode, 0o600);
  assert.equal(start.nice, 10);
  assert.equal(end.event, 'end');
  assert.equal(fs.existsSync(start.dir), false, 'the temporary directory is gone');
});

test('the default arguments name the small model, 4 threads and beam 1, and no language', async (t) => {
  const ctx = await setup(t);
  await dictate(ctx, { mode: 'text', text: 'Hello' });
  assert.deepEqual(events(ctx)[0].flags, ['--model', 'small', '--models-dir', path.join(ctx.dir, 'models'), '--threads', '4', '--beam', '1']);
});

test('Cancel posts nothing and settles the message as cancelled', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const { shown, placeholder } = await dictate(ctx, { mode: 'text', text: 'Never mind' }, { thread });
  assert.deepEqual(labels(w, shown.message_id), ['Send', 'Cancel']);

  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Cancel'));
  assert.equal(posts(w, '/comments').length, 0);
  assert.deepEqual(w.tg.reactions, []);
  assert.match(w.tg.messages.get(placeholder.message_id).text, outcomePattern('Cancelled', null, { before: heard('Never mind') }));
  assert.deepEqual(w.tg.buttons(placeholder.message_id), []);
  assert.equal(bot.state.voice.size, 0);

  // A second tap changes nothing.
  await bot.handleUpdate(w.tg.tap(placeholder.message_id, 'V:s:1'));
  assert.equal(posts(w, '/comments').length, 0);
});

test('a second Send tap posts nothing more', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Once only' }, { thread });
  const first = w.tg.tapButton(placeholder.message_id, 'Send');
  const second = w.tg.tapButton(placeholder.message_id, 'Send');
  await bot.handleUpdate(first);
  await bot.handleUpdate(second);
  assert.equal(posts(w, '/comments').length, 1);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already handled');
  assert.match(w.tg.messages.get(placeholder.message_id).text, outcomePattern('Sent', null, { before: heard('Once only') }));
});

test('a failed comment keeps the buttons so Send can be tried again', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Try twice' }, { thread });

  w.pc.failRequests('POST', /\/comments$/, 500, 1);
  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Send'));
  assert.deepEqual(labels(w, placeholder.message_id), ['Send', 'Cancel']);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Not sent');
  assert.match(w.tg.lastMessage().text, /Paperclip error/);
  assert.equal(w.pc.comments.length, 0);

  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Send'));
  assert.equal(w.pc.comments.at(-1).body, 'Try twice');
  assert.match(w.tg.messages.get(placeholder.message_id).text, outcomePattern('Sent', null, { before: heard('Try twice') }));
});

test('a lost confirmation of the comment does not make Send post it again', async (t) => {
  const ctx = await setup(t);
  const { w, bot } = ctx;
  const issue = w.pc.addIssue({ title: 'Fix the layout', status: 'in_progress' });
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  const view = w.tg.lastMessage();
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Once, not twice' }, { replyTo: view.message_id });

  w.tg.failNext('sendMessage', 500, { ok: false, error_code: 500, description: 'Internal Server Error' });
  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Send'));
  assert.equal(posts(w, '/comments').length, 1);
  assert.match(w.tg.messages.get(placeholder.message_id).text, outcomePattern('Sent', null, { before: heard('Once, not twice') }));
  assert.match(w.allLogText(), /warn could not confirm a comment/);

  await bot.handleUpdate(w.tg.tap(placeholder.message_id, 'V:s:1'));
  assert.equal(posts(w, '/comments').length, 1);
});

test('Send saves the note as taken before the comment goes out, so a restart cannot send it again', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Only once' }, { thread });
  const post = bot.pc.postComment.bind(bot.pc);
  let saved = null;
  bot.pc.postComment = (...args) => {
    saved = JSON.parse(fs.readFileSync(w.statePath, 'utf8')).voice;
    return post(...args);
  };
  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Send'));
  assert.deepEqual(saved, {});
  assert.equal(w.pc.comments.at(-1).body, 'Only once');
});

test('a voice note in General becomes the task offer with the transcript, and the task is created from it', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const known = w.tg.sent().length;
  const update = note(ctx, { mode: 'text', text: 'Draw the logo in blue' });
  await bot.handleUpdate(update);
  const reply = w.tg.lastMessage();
  assert.equal(reply.text, 'Transcribing…');
  await settled(bot);

  const offer = w.tg.messages.get(reply.message_id);
  assert.equal(w.tg.sent().length, known + 1, 'the offer edits the reply instead of sending another message');
  assert.equal(offer.text, 'Heard:\n<blockquote>Draw the logo in blue</blockquote>\nCreate a task from this?');
  assert.equal(offer.replyTo, update.message.message_id);
  assert.deepEqual(labels(w, reply.message_id), ['For Lead', 'Cancel', 'Other agent']);
  assert.equal(bot.state.offers.size, 1);
  assert.equal(posts(w, '/issues').length, 0);

  await bot.handleUpdate(w.tg.tapButton(reply.message_id, 'For Lead'));
  const [created] = posts(w, '/issues');
  assert.equal(created.body.title, 'Draw the logo in blue');
  assert.equal(created.body.description, 'Draw the logo in blue');
  assert.equal(created.body.idempotencyKey, `telegram-update-${update.update_id}`);
  assert.match(
    w.tg.messages.get(reply.message_id).text,
    outcomePattern('Created', `${TASK_LINK} for Lead`, { before: 'Heard:\n<blockquote>Draw the logo in blue</blockquote>\nCreate a task from this?\n\n' }),
  );
});

test('the offer made from a voice note can be cancelled and keeps the transcript', async (t) => {
  const ctx = await setup(t);
  const { w, bot } = ctx;
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Maybe later' });
  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Cancel'));
  assert.equal(posts(w, '/issues').length, 0);
  assert.match(
    w.tg.messages.get(placeholder.message_id).text,
    outcomePattern('Cancelled', null, { before: 'Heard:\n<blockquote>Maybe later</blockquote>\nCreate a task from this?\n\n' }),
  );
});

test('a voice reply to a bot message about a task comments on that task', async (t) => {
  const ctx = await setup(t);
  const { w, bot } = ctx;
  const issue = w.pc.addIssue({ title: 'Fix the layout', status: 'in_progress' });
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  const view = w.tg.lastMessage();

  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Looks better now' }, { replyTo: view.message_id });
  assert.deepEqual(labels(w, placeholder.message_id), ['Send', 'Cancel']);
  assert.equal(bot.state.offers.size, 0, 'a reply is not an offer');
  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Send'));
  assert.deepEqual(posts(w, '/comments')[0].body, { body: 'Looks better now' });
  assert.match(posts(w, '/comments')[0].path, new RegExp(`/api/issues/${issue.id}/comments$`));
});

// One issue with one pending card, already sent to the fake chat.
async function withCard(ctx, { kind, payload }) {
  const issue = ctx.w.pc.addIssue({ title: 'Ship v2', status: 'in_review', assigneeAgentId: 'agent-1' });
  const interaction = ctx.w.pc.addInteraction(issue.id, { kind, payload });
  await ctx.bot.pollOnce();
  return { issue, interaction, message: ctx.w.tg.findMessage(issue.identifier) };
}

test('a voice reply to the text question of a card answers it', async (t) => {
  const ctx = await setup(t);
  const { w, bot } = ctx;
  const { interaction, message } = await withCard(ctx, { kind: 'ask_user_questions', payload: questionsPayload([textQuestion('why', 'What is the reason?')]) });

  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Because of the audit' }, { replyTo: message.message_id });
  assert.equal(w.pc.interactions.get(interaction.id).status, 'pending', 'nothing is answered before Send');
  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Send'));

  assert.deepEqual(posts(w, '/respond')[0].body, { answers: [{ questionId: 'why', optionIds: [], otherText: 'Because of the audit' }] });
  assert.equal(w.pc.interactions.get(interaction.id).status, 'answered');
  assert.equal(posts(w, '/comments').length, 0);
  assert.match(w.tg.messages.get(placeholder.message_id).text, outcomePattern('Sent', null, { before: heard('Because of the audit') }));
});

test('a voice reply to a decline-reason prompt declines with that reason', async (t) => {
  const ctx = await setup(t);
  const { w, bot } = ctx;
  const { interaction, message } = await withCard(ctx, {
    kind: 'request_confirmation',
    payload: confirmPayload({ rejectRequiresReason: true, rejectReasonLabel: 'Why hold it?' }),
  });
  await bot.handleUpdate(w.tg.tapButton(message.message_id, 'Hold'));
  const prompt = w.tg.sent().find((m) => m.markup?.force_reply);

  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Too risky before the freeze' }, { replyTo: prompt.message_id });
  assert.equal(posts(w, '/reject').length, 0);
  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Send'));

  assert.deepEqual(posts(w, '/reject')[0].body, { reason: 'Too risky before the freeze' });
  assert.equal(w.pc.interactions.get(interaction.id).status, 'rejected');
  assert.equal(posts(w, '/comments').length, 0);
  assert.match(w.tg.messages.get(message.message_id).text, outcomePattern('Declined', 'Too risky before the freeze'));
  assert.match(w.tg.messages.get(placeholder.message_id).text, outcomePattern('Sent', null, { before: heard('Too risky before the freeze') }));
});

test('a voice note over the limit is refused before anything is downloaded', async (t) => {
  const ctx = await setup(t);
  const { w, bot } = ctx;
  const update = note(ctx, { mode: 'text', text: 'Long' }, { duration: 301 });
  await bot.handleUpdate(update);
  assert.equal(w.tg.lastMessage().text, 'Voice notes can be up to 5 minutes long.');
  assert.equal(w.tg.lastMessage().replyTo, update.message.message_id);
  assert.equal(w.tg.downloads.length, 0);
  assert.equal(events(ctx).length, 0);
  assert.equal(bot.state.voice.size, 0);

  await bot.handleUpdate(note(ctx, { mode: 'text', text: 'Just fits' }, { duration: 300 }));
  await settled(bot);
  assert.equal(events(ctx).length > 0, true);
});

test('the limit follows maxSeconds', async (t) => {
  const ctx = await setup(t, { voice: { maxSeconds: 90 } });
  await ctx.bot.handleUpdate(note(ctx, { mode: 'text', text: 'Long' }, { duration: 91 }));
  assert.equal(ctx.w.tg.lastMessage().text, 'Voice notes can be up to 90 seconds long.');
  assert.deepEqual([lengthWords(60), lengthWords(120), lengthWords(300), lengthWords(45)], ['1 minute', '2 minutes', '5 minutes', '45 seconds']);
});

test('without a voice block a voice note is answered and nothing is downloaded', async (t) => {
  const ctx = await setup(t, { noVoice: true });
  const update = note(ctx, { mode: 'text', text: 'Hello' });
  await ctx.bot.handleUpdate(update);
  assert.equal(ctx.w.tg.lastMessage().text, 'Voice notes are not set up on this machine.');
  assert.equal(ctx.w.tg.lastMessage().replyTo, update.message.message_id);
  assert.equal(ctx.w.tg.downloads.length, 0);
  assert.equal(ctx.bot.transcriber, null);
});

test('a note with no speech ends with "No speech heard."', async (t) => {
  const ctx = await setup(t);
  const { w } = ctx;
  const { placeholder } = await dictate(ctx, { mode: 'empty' });
  assert.equal(w.tg.messages.get(placeholder.message_id).text, 'No speech heard.');
  assert.deepEqual(w.tg.buttons(placeholder.message_id), []);
  assert.equal(ctx.bot.state.voice.size, 0);
  assert.equal(ctx.bot.state.offers.size, 0);
});

test('a failing helper ends with a plain notice, and the log holds the reason but not the text', async (t) => {
  const ctx = await setup(t);
  const { w } = ctx;
  const { placeholder } = await dictate(ctx, { mode: 'fail', text: 'SECRET-WORDS' });
  assert.equal(w.tg.messages.get(placeholder.message_id).text, 'Could not transcribe this voice note.');
  assert.deepEqual(w.tg.buttons(placeholder.message_id), []);
  assert.match(w.allLogText(), /warn voice transcription failed error=helper exited with 1: transcribe: RuntimeError: the model failed/);
  assert.ok(!w.allLogText().includes('SECRET-WORDS'));
  assert.equal(ctx.bot.state.voice.size, 0);
});

test('a missing helper is reported the same way', async (t) => {
  const ctx = await setup(t, { voice: { python: '/nonexistent/venv/bin/python' } });
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Hello' });
  assert.equal(ctx.w.tg.messages.get(placeholder.message_id).text, 'Could not transcribe this voice note.');
  assert.match(ctx.w.allLogText(), /voice transcription failed/);
});

test('a helper that runs too long is killed and the note fails', async (t) => {
  const ctx = await setup(t, { bot: { voiceTimeoutMs: () => 400 } });
  const { w } = ctx;
  const { placeholder } = await dictate(ctx, { mode: 'slow', delayMs: 60_000, text: 'Too slow' });
  assert.equal(w.tg.messages.get(placeholder.message_id).text, 'Could not transcribe this voice note.');
  const [start] = events(ctx);
  await waitFor(() => pidGone(start.pid), { label: 'the helper to be killed' });
  assert.equal(events(ctx).some((entry) => entry.event === 'end'), false, 'the helper never finished');
  assert.equal(fs.existsSync(start.dir), false);
  assert.match(w.allLogText(), /warn voice transcription failed error=timed out after \d+ s/);
  assert.ok(!w.allLogText().includes('Too slow'));
});

test('the helper may run for 4 times the note, and at least a minute', () => {
  assert.equal(transcribeTimeoutMs(0), 60_000);
  assert.equal(transcribeTimeoutMs(10), 60_000);
  assert.equal(transcribeTimeoutMs(15), 60_000);
  assert.equal(transcribeTimeoutMs(30), 120_000);
  assert.equal(transcribeTimeoutMs(300), 1_200_000);
});

test('two notes at once are transcribed one after the other', async (t) => {
  const ctx = await setup(t);
  const { w, bot } = ctx;
  const first = note(ctx, { mode: 'text', text: 'First note', delayMs: 300 });
  const second = note(ctx, { mode: 'text', text: 'Second note', delayMs: 300 });
  await bot.handleUpdate(first);
  const firstReply = w.tg.lastMessage();
  await bot.handleUpdate(second);
  const secondReply = w.tg.lastMessage();
  await settled(bot);

  assert.deepEqual(events(ctx).map((entry) => entry.event), ['start', 'end', 'start', 'end']);
  assert.match(w.tg.messages.get(firstReply.message_id).text, /First note/);
  assert.match(w.tg.messages.get(secondReply.message_id).text, /Second note/);
});

test('a button tap is handled while a transcription runs', async (t) => {
  const ctx = await setup(t);
  const { w, bot } = ctx;
  const { interaction, message } = await withCard(ctx, { kind: 'request_confirmation', payload: confirmPayload() });
  const stop = runLoops(bot);
  try {
    const slow = w.tg.push(note(ctx, { mode: 'slow', delayMs: 1500, text: 'Still working' }));
    await waitFor(() => events(ctx).some((entry) => entry.event === 'start'), { label: 'the helper to start' });
    w.tg.push(w.tg.tapButton(message.message_id, 'Deploy'));
    await waitFor(() => w.pc.interactions.get(interaction.id).status === 'accepted', { label: 'the tap to be handled' });
    assert.equal(events(ctx).some((entry) => entry.event === 'end'), false, 'the helper is still running');
    await waitFor(() => w.tg.findMessage('Still working'), { label: 'the transcript' });
    assert.ok(slow);
  } finally {
    await stop();
  }
});

test('stopping the bot kills a running helper and keeps the note for the next run', async (t) => {
  const ctx = await setup(t);
  const { w, bot } = ctx;
  const update = note(ctx, { mode: 'slow', delayMs: 60_000, text: 'Interrupted' });
  await bot.handleUpdate(update);
  const reply = w.tg.lastMessage();
  await waitFor(() => events(ctx).some((entry) => entry.event === 'start'), { label: 'the helper to start' });
  const [start] = events(ctx);

  bot.stop();
  await settled(bot);
  await waitFor(() => pidGone(start.pid), { label: 'the helper to be killed' });
  assert.equal(w.tg.messages.get(reply.message_id).text, 'Transcribing…', 'the reply is left as it was');
  assert.equal(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).voice['1'].status, 'pending');
  assert.ok(!w.allLogText().includes('voice transcription failed'));
});

test('a note still pending at restart is transcribed by the next run', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const update = note(ctx, { mode: 'slow', delayMs: 60_000, text: 'Interrupted' }, { thread });
  await bot.handleUpdate(update);
  const reply = w.tg.lastMessage();
  await waitFor(() => events(ctx).length > 0, { label: 'the helper to start' });
  bot.stop();
  await settled(bot);
  // The saved audio now answers quickly, as it would after the restart.
  w.tg.files.get('file-1').data = Buffer.from(JSON.stringify({ log: ctx.log, mode: 'text', text: 'Back again' }));

  const restarted = w.makeBot();
  const stop = runLoops(restarted);
  try {
    await waitFor(() => labels(w, reply.message_id).includes('Send'), { label: 'the resumed note' });
  } finally {
    await stop();
  }
  assert.equal(w.tg.messages.get(reply.message_id).text, heard('Back again').trimEnd());
  assert.equal(w.tg.sent().filter((m) => m.replyTo === update.message.message_id).length, 1, 'no second reply was sent');
  assert.equal(restarted.state.voice.get('1').status, 'ready');
});

test('a Send that was pending at restart still works', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const { issue, thread } = await taskWithTopic(w, bot);
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Posted after the restart' }, { thread });

  const restarted = w.makeBot();
  assert.equal(restarted.state.voice.size, 1);
  await restarted.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Send'));
  assert.deepEqual(posts(w, '/comments')[0].body, { body: 'Posted after the restart' });
  assert.match(posts(w, '/comments')[0].path, new RegExp(issue.id));
  assert.match(w.tg.messages.get(placeholder.message_id).text, outcomePattern('Sent', null, { before: heard('Posted after the restart') }));
});

test('a transcript that waited more than 24 hours expires instead of being sent', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Too late' }, { thread });

  const later = w.makeBot({ now: () => Date.now() + 25 * HOUR });
  // Telegram hands the tap the message as plain text.
  const tap = w.tg.tapButton(placeholder.message_id, 'Send');
  tap.callback_query.message.text = 'Heard\nToo late';
  await later.handleUpdate(tap);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This voice note has expired');
  assert.equal(posts(w, '/comments').length, 0);
  assert.match(w.tg.messages.get(placeholder.message_id).text, outcomePattern('Expired', null, { before: 'Heard\nToo late\n\n' }));
  assert.deepEqual(w.tg.buttons(placeholder.message_id), []);

  // The poll drops the expired note from the state.
  await later.pollOnce();
  assert.equal(later.state.voice.size, 0);
});

test('an offer made from a voice note expires after 24 hours like any offer', async (t) => {
  const ctx = await setup(t);
  const { w } = ctx;
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Old idea' });
  const later = w.makeBot({ now: () => Date.now() + 25 * HOUR });
  // Telegram hands the tap the message as plain text.
  const tap = w.tg.tapButton(placeholder.message_id, 'For Lead');
  tap.callback_query.message.text = 'Heard:\nOld idea\nCreate a task from this?';
  await later.handleUpdate(tap);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This offer has expired');
  assert.equal(posts(w, '/issues').length, 0);
  assert.match(w.tg.messages.get(placeholder.message_id).text, outcomePattern('Expired', null, { before: 'Heard:\nOld idea\nCreate a task from this?\n\n' }));
});

test('an expired offer whose transcript nearly fills a message still loses its buttons', async (t) => {
  const ctx = await setup(t);
  const { w } = ctx;
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Old idea' });
  const later = w.makeBot({ now: () => Date.now() + 25 * HOUR });
  const tap = w.tg.tapButton(placeholder.message_id, 'For Lead');
  tap.callback_query.message.text = `Heard:\n${'word & '.repeat(570)}\nCreate a task from this?`;
  await later.handleUpdate(tap);
  const shown = w.tg.messages.get(placeholder.message_id).text;
  assert.deepEqual(w.tg.buttons(placeholder.message_id), []);
  assert.match(shown, /^Heard:\nword &amp; word/);
  assert.match(shown, outcomePattern('Expired', null));
});

test('< and & in a transcript are escaped for display and posted as they are', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const text = 'if a < b && c > d then <b>stop</b>';
  const { placeholder } = await dictate(ctx, { mode: 'text', text }, { thread });
  assert.equal(w.tg.messages.get(placeholder.message_id).text, heard('if a &lt; b &amp;&amp; c &gt; d then &lt;b&gt;stop&lt;/b&gt;').trimEnd());
  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Send'));
  assert.deepEqual(posts(w, '/comments')[0].body, { body: text });
});

test('a very long transcript is cut for display, folded in a quote, and sent in full', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const text = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ') + ' & done';
  assert.ok(text.length > 8000);
  const { placeholder, shown } = await dictate(ctx, { mode: 'text', text }, { thread });

  assert.ok(shown.text.length <= 4096, `shown ${shown.text.length} characters`);
  assert.match(shown.text, /^<b>Heard<\/b>\n<blockquote expandable>word0 word1 /);
  assert.match(shown.text, /…<\/blockquote>$/);
  assert.deepEqual(labels(w, placeholder.message_id), ['Send', 'Cancel']);

  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Send'));
  assert.equal(posts(w, '/comments')[0].body.body, text);
  const settledText = w.tg.messages.get(placeholder.message_id).text;
  assert.ok(settledText.length <= 4096);
  assert.match(settledText, outcomePattern('Sent', null, { before: settledText.slice(0, settledText.indexOf('</blockquote>') + '</blockquote>'.length + 2) }));
});

test('a very long transcript in General is cut in the offer, and the task gets all of it', async (t) => {
  const ctx = await setup(t);
  const { w, bot } = ctx;
  const text = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' ');
  const { placeholder, shown } = await dictate(ctx, { mode: 'text', text });
  assert.ok(shown.text.length <= 4096);
  assert.match(shown.text, /^Heard:\n<blockquote expandable>word0 /);
  assert.match(shown.text, /…<\/blockquote>\nCreate a task from this\?$/);

  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'For Lead'));
  assert.equal(posts(w, '/issues')[0].body.description, text);
  assert.ok(w.tg.messages.get(placeholder.message_id).text.length <= 4096);
  assert.match(w.tg.messages.get(placeholder.message_id).text, /<b>Created<\/b>/);
});

test('every message about a voice note is silent, and the log holds no transcript or token', async (t) => {
  const ctx = await setup(t, { forum: true });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const known = w.tg.sent().length;
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Quiet words about LOGGED-TEXT' }, { thread });
  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Send'));
  await dictate(ctx, { mode: 'fail', text: 'LOGGED-TEXT' }, { thread });

  const sends = w.tg.loudSends().filter((entry) => entry.messageId >= known);
  assert.deepEqual(sends, []);
  assert.ok(w.logs.out.some((line) => /info voice note transcribed seconds=0\.1 language=en characters=\d+/.test(line)));
  assert.ok(!w.allLogText().includes('LOGGED-TEXT'));
  assert.ok(!w.allLogText().includes(TELEGRAM_TOKEN));
});

test('/help names voice notes only when they are set up', async (t) => {
  const on = await setup(t);
  await on.bot.handleUpdate(on.w.tg.message('/help'));
  assert.match(on.w.tg.lastMessage().text, /Voice notes work too, up to 5 minutes long: the bot turns them into text on this machine, shows the text and uses it only after you confirm\./);

  const off = await setup(t, { noVoice: true });
  await off.bot.handleUpdate(off.w.tg.message('/help'));
  assert.ok(!/voice/i.test(off.w.tg.lastMessage().text));
});

test('a voice note from another user is ignored', async (t) => {
  const ctx = await setup(t);
  const calls = ctx.w.tg.calls.length;
  await ctx.bot.handleUpdate(note(ctx, { mode: 'text', text: 'Hello' }, { from: 2002 }));
  assert.equal(ctx.w.tg.calls.length, calls);
  assert.equal(ctx.w.tg.downloads.length, 0);
});

test('a state saved without voice notes loads, and one with them keeps them', async (t) => {
  const ctx = await setup(t);
  const { w, bot } = ctx;
  assert.equal(bot.state.voice.size, 0);
  await dictate(ctx, { mode: 'text', text: 'Kept' }, {});
  const saved = JSON.parse(fs.readFileSync(w.statePath, 'utf8'));
  // The offer holds the transcript; the job is gone.
  assert.deepEqual(Object.keys(saved.voice), []);
  assert.equal(Object.values(saved.offers)[0].heard, 'Kept');
  delete saved.voice;
  delete saved.voiceCounter;
  fs.writeFileSync(w.statePath, JSON.stringify(saved));
  assert.equal(w.makeBot().state.voice.size, 0);
});

test('the voice block of the config is checked and gets its defaults', () => {
  const base = {
    paperclipUrl: 'http://localhost:3100',
    uiBaseUrl: 'https://paperclip.example.com',
    companyId: 'c',
    leadAgentId: 'a',
    telegramUserId: 1,
    telegramTokenFile: 't',
    paperclipTokenFile: 'p',
  };
  assert.equal(parseConfig(base).config.voice, null);
  assert.equal(parseConfig({ ...base, voice: null }).config.voice, null);
  assert.deepEqual(parseConfig({ ...base, voice: { python: '/v/bin/python', modelsDir: '/v/models' } }).config.voice, {
    python: '/v/bin/python',
    modelsDir: '/v/models',
    model: 'small',
    language: null,
    beamSize: 1,
    threads: 4,
    maxSeconds: 300,
  });
  assert.deepEqual(
    parseConfig({ ...base, voice: { python: '~/v/bin/python', modelsDir: '/m', model: 'base', language: 'de', beamSize: 5, threads: 2, maxSeconds: 60 } }).config.voice,
    { python: path.join(os.homedir(), 'v/bin/python'), modelsDir: '/m', model: 'base', language: 'de', beamSize: 5, threads: 2, maxSeconds: 60 },
  );
  const problems = (voice) => parseConfig({ ...base, voice }).problems;
  assert.deepEqual(problems('yes'), ['voice must be an object when set']);
  assert.deepEqual(problems([]), ['voice must be an object when set']);
  assert.deepEqual(problems({}), ['voice.python must be a non-empty path', 'voice.modelsDir must be a non-empty path']);
  assert.deepEqual(
    problems({ python: 'p', modelsDir: 'm', model: 3, language: 4, beamSize: 0, threads: 1.5, maxSeconds: -1 }),
    [
      'voice.model must be a non-empty string when set',
      'voice.language must be a language code or null',
      'voice.beamSize must be a positive integer when set',
      'voice.threads must be a positive integer when set',
      'voice.maxSeconds must be a positive number of seconds when set',
    ],
  );
});

test('the sample config has a voice block that parses', () => {
  const sample = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../config.example.json', import.meta.url)), 'utf8'));
  const { config, problems } = parseConfig(sample);
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(config.voice).sort(), ['beamSize', 'language', 'maxSeconds', 'model', 'modelsDir', 'python', 'threads']);
});

test('the real helper fails with a short message on stderr and nothing on stdout when it cannot read the audio', (t) => {
  const python = spawnSync('python3', ['--version']);
  if (python.status !== 0) return t.skip('python3 is not installed');
  const run = spawnSync('python3', ['-I', SCRIPT, '/nonexistent/audio.ogg'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /^transcribe: audio file not found\n$/);
  return undefined;
});

// ---- Choosing the language of a note ----

const EN_RU = { languages: ['en', 'ru'] };
// The language each helper run was given, in order (null when it got none).
const flagLanguages = (ctx) =>
  events(ctx)
    .filter((entry) => entry.event === 'start')
    .map((entry) => (entry.flags.includes('--language') ? entry.flags[entry.flags.indexOf('--language') + 1] : null));
const rows = (w, id) => (w.tg.messages.get(id).markup?.inline_keyboard ?? []).map((row) => row.map((b) => b.text));
const textOf = (w, id) => w.tg.messages.get(id).text;
const heardIn = (name, text) => `<b>Heard</b> · ${name}\n<blockquote>${text}</blockquote>\n\n`;
const offerIn = (name, text) => `Heard · ${name}:\n<blockquote>${text}</blockquote>\nCreate a task from this?`;
const TWO_READINGS = { mode: 'text', text: 'Please use the blue logo', texts: { ru: 'Пожалуйста, синий логотип' } };

async function openSettings(ctx) {
  await ctx.bot.handleUpdate(ctx.w.tg.message('/settings'));
  return ctx.w.tg.lastMessage();
}

test('with languages a note is read in the first one, then in the one the /settings switch picked; the pick survives a restart', async (t) => {
  const ctx = await setup(t, { voice: EN_RU });
  const { w, bot } = ctx;
  await dictate(ctx, { mode: 'text', text: 'First' });
  assert.deepEqual(events(ctx)[0].flags, ['--model', 'small', '--models-dir', path.join(ctx.dir, 'models'), '--threads', '4', '--beam', '1', '--language', 'en']);

  const view = await openSettings(ctx);
  assert.deepEqual(rows(w, view.message_id).slice(-2), [['Voice · English'], ['Mute 1 h', 'Mute 8 h', 'Unmute']]);
  assert.equal(styles(w, view.message_id)['Voice · English'], null, 'the switch has no colour');
  const sent = w.tg.sent().length;
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Voice'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Voice: Russian');
  assert.deepEqual(rows(w, view.message_id).slice(-2), [['Voice · Russian'], ['Mute 1 h', 'Mute 8 h', 'Unmute']]);
  assert.equal(w.tg.sent().length, sent, 'the settings are redrawn in place');

  await dictate(ctx, { mode: 'text', text: 'Second' });
  assert.deepEqual(flagLanguages(ctx), ['en', 'ru']);

  const restarted = w.makeBot();
  assert.equal(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).voiceLanguage, 'ru');
  const again = await openSettings({ w, bot: restarted });
  assert.deepEqual(rows(w, again.message_id).at(-2), ['Voice · Russian']);
  await restarted.handleUpdate(note(ctx, { mode: 'text', text: 'Third' }));
  await settled(restarted);
  assert.deepEqual(flagLanguages(ctx), ['en', 'ru', 'ru']);
});

test('the switch moves through the list and wraps around; a pick that left the list means the first language', async (t) => {
  const ctx = await setup(t, { voice: { languages: ['en', 'ru', 'de'] } });
  const { w, bot } = ctx;
  const view = await openSettings(ctx);
  const picked = [];
  for (let i = 0; i < 4; i += 1) {
    await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Voice'));
    picked.push(w.tg.callbackAnswers.at(-1).text);
  }
  assert.deepEqual(picked, ['Voice: Russian', 'Voice: German', 'Voice: English', 'Voice: Russian']);

  const saved = JSON.parse(fs.readFileSync(w.statePath, 'utf8'));
  saved.voiceLanguage = 'fr';
  fs.writeFileSync(w.statePath, JSON.stringify(saved));
  const restarted = w.makeBot();
  const stale = await openSettings({ w, bot: restarted });
  assert.deepEqual(rows(w, stale.message_id).at(-2), ['Voice · English']);
  await restarted.handleUpdate(w.tg.tapButton(stale.message_id, 'Voice'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Voice: Russian');
  await restarted.handleUpdate(note(ctx, { mode: 'text', text: 'Stale pick' }));
  await settled(restarted);
  assert.deepEqual(flagLanguages(ctx), ['ru']);
});

test('a note keeps the language it had when it arrived, also while it waits behind another note', async (t) => {
  const ctx = await setup(t, { forum: true, voice: EN_RU });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const first = note(ctx, { mode: 'text', text: 'First note', delayMs: 400 }, { thread });
  const second = note(ctx, { mode: 'text', text: 'Second note' }, { thread });
  await bot.handleUpdate(first);
  const firstReply = w.tg.lastMessage();
  await bot.handleUpdate(second);
  const secondReply = w.tg.lastMessage();
  await waitFor(() => events(ctx).some((entry) => entry.event === 'start'), { label: 'the first helper' });

  const view = await openSettings(ctx);
  await bot.handleUpdate(w.tg.tapButton(view.message_id, 'Voice'));
  await bot.handleUpdate(note(ctx, { mode: 'text', text: 'Third note' }, { thread }));
  const thirdReply = w.tg.lastMessage();
  await settled(bot);

  assert.deepEqual(flagLanguages(ctx), ['en', 'en', 'ru']);
  assert.match(textOf(w, firstReply.message_id), /Heard<\/b> · English/);
  assert.match(textOf(w, secondReply.message_id), /Heard<\/b> · English/);
  assert.match(textOf(w, thirdReply.message_id), /Heard<\/b> · Russian/);
});

test('a note saved without a language is read in the switch language, or in the configured one without a list', async (t) => {
  const cases = [
    { voice: EN_RU, picked: 'ru', expected: 'ru' },
    { voice: EN_RU, picked: null, expected: 'en' },
    { voice: { language: 'de' }, picked: null, expected: 'de' },
  ];
  for (const { voice, picked, expected } of cases) {
    const ctx = await setup(t, { voice });
    const { w, bot } = ctx;
    const slow = { log: ctx.log, mode: 'slow', delayMs: 60_000, text: 'Interrupted' };
    await bot.handleUpdate(note(ctx, slow));
    const reply = w.tg.lastMessage();
    await waitFor(() => events(ctx).length > 0, { label: 'the helper to start' });
    bot.stop();
    await settled(bot);

    // A saved job without a language.
    const saved = JSON.parse(fs.readFileSync(w.statePath, 'utf8'));
    delete saved.voice['1'].language;
    saved.voiceLanguage = picked;
    fs.writeFileSync(w.statePath, JSON.stringify(saved));
    w.tg.files.get('file-1').data = Buffer.from(JSON.stringify({ log: ctx.log, mode: 'text', text: 'Back again' }));

    const restarted = w.makeBot();
    const stop = runLoops(restarted);
    try {
      await waitFor(() => /Back again/.test(textOf(w, reply.message_id)), { label: 'the resumed note' });
    } finally {
      await stop();
    }
    assert.equal(flagLanguages(ctx).at(-1), expected, JSON.stringify(voice));
  }
});

test('the transcript names its language and a button reads the same note again in another, in the same message; Send posts only the new text', async (t) => {
  const ctx = await setup(t, { forum: true, voice: EN_RU });
  const { w, bot } = ctx;
  const { issue, thread } = await taskWithTopic(w, bot);
  const { placeholder } = await dictate(ctx, { ...TWO_READINGS, delayMs: 150 }, { thread });
  const id = placeholder.message_id;
  assert.equal(textOf(w, id), heardIn('English', 'Please use the blue logo').trimEnd());
  assert.deepEqual(rows(w, id), [['Send', 'Cancel', 'Russian']]);
  assert.deepEqual(styles(w, id), { Send: 'success', Cancel: 'danger', Russian: null });
  const known = w.tg.sent().length;

  await bot.handleUpdate(w.tg.tapButton(id, 'Russian'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Reading again in Russian');
  assert.equal(textOf(w, id), 'Transcribing…');
  assert.deepEqual(w.tg.buttons(id), []);
  const [job] = [...bot.state.voice.values()];
  assert.equal(bot.state.voice.size, 1);
  assert.deepEqual([job.status, job.language, job.text], ['pending', 'ru', null], 'the old transcript is dropped');
  assert.equal(posts(w, '/comments').length, 0, 'nothing is sent by the tap');

  await settled(bot);
  assert.equal(textOf(w, id), heardIn('Russian', 'Пожалуйста, синий логотип').trimEnd());
  assert.deepEqual(rows(w, id), [['Send', 'Cancel', 'English']]);
  assert.deepEqual(styles(w, id), { Send: 'success', Cancel: 'danger', English: null });
  assert.equal(w.tg.sent().length, known, 'the same message is edited');
  assert.deepEqual(flagLanguages(ctx), ['en', 'ru']);
  const file = w.tg.files.get('file-1').path;
  assert.deepEqual(w.tg.downloads.map((d) => d.path), [file, file], 'the same audio is read again');
  assert.equal(bot.state.voiceLanguage, null, 'the /settings switch is not changed');

  await bot.handleUpdate(w.tg.tapButton(id, 'Send'));
  assert.deepEqual(posts(w, '/comments').map((c) => [c.path.split('/').at(-2), c.body]), [[issue.id, { body: 'Пожалуйста, синий логотип' }]]);
  assert.match(textOf(w, id), outcomePattern('Sent', null, { before: heardIn('Russian', 'Пожалуйста, синий логотип') }));
  assert.deepEqual(w.tg.buttons(id), []);
});

test('reading again can go back to the first language and the first text is not kept', async (t) => {
  const ctx = await setup(t, { voice: EN_RU });
  const { w, bot } = ctx;
  const issue = w.pc.addIssue({ title: 'Fix the layout', status: 'in_progress' });
  await bot.handleUpdate(w.tg.message(`/task ${issue.identifier}`));
  const { placeholder } = await dictate(ctx, TWO_READINGS, { replyTo: w.tg.lastMessage().message_id });
  const id = placeholder.message_id;
  await bot.handleUpdate(w.tg.tapButton(id, 'Russian'));
  await settled(bot);
  await bot.handleUpdate(w.tg.tapButton(id, 'English'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Reading again in English');
  await settled(bot);
  assert.equal(textOf(w, id), heardIn('English', 'Please use the blue logo').trimEnd());
  assert.deepEqual(flagLanguages(ctx), ['en', 'ru', 'en']);

  await bot.handleUpdate(w.tg.tapButton(id, 'Send'));
  assert.deepEqual(posts(w, '/comments').map((c) => c.body), [{ body: 'Please use the blue logo' }]);
  assert.equal(bot.state.voice.size, 0);
});

test('two languages put the other one next to Send and Cancel; more put the others in a row of their own', async (t) => {
  const two = await setup(t, { forum: true, voice: EN_RU });
  const one = await dictate(two, { mode: 'text', text: 'Hello' }, { thread: (await taskWithTopic(two.w, two.bot)).thread });
  assert.deepEqual(rows(two.w, one.placeholder.message_id), [['Send', 'Cancel', 'Russian']]);

  const many = await setup(t, { forum: true, voice: { languages: ['ru', 'en', 'de', 'fr'] } });
  const note3 = await dictate(many, { mode: 'text', text: 'Hello' }, { thread: (await taskWithTopic(many.w, many.bot)).thread });
  const id = note3.placeholder.message_id;
  assert.equal(textOf(many.w, id), heardIn('Russian', 'Hello').trimEnd());
  assert.deepEqual(rows(many.w, id), [['Send', 'Cancel'], ['English', 'German', 'French']]);
  assert.deepEqual(styles(many.w, id), { Send: 'success', Cancel: 'danger', English: null, German: null, French: null });
  await many.bot.handleUpdate(many.w.tg.tapButton(id, 'German'));
  assert.equal(many.w.tg.callbackAnswers.at(-1).text, 'Reading again in German');
  await settled(many.bot);
  assert.equal(textOf(many.w, id), heardIn('German', 'Hello').trimEnd());
  assert.deepEqual(rows(many.w, id), [['Send', 'Cancel'], ['Russian', 'English', 'French']]);
  assert.deepEqual(flagLanguages(many), ['ru', 'de']);
});

test('a language code with no name is shown as the code', () => {
  assert.deepEqual([languageName('en'), languageName('ru'), languageName('de'), languageName('zz')], ['English', 'Russian', 'German', 'zz']);
});

test('a task offer made from a note names its language and reads the note again; the task is made from the new text', async (t) => {
  const ctx = await setup(t, { voice: EN_RU });
  const { w, bot } = ctx;
  const { update, placeholder } = await dictate(ctx, { mode: 'text', text: 'Draw the logo in blue', texts: { ru: 'Нарисуйте логотип синим' }, delayMs: 150 });
  const id = placeholder.message_id;
  assert.equal(textOf(w, id), offerIn('English', 'Draw the logo in blue'));
  assert.deepEqual(rows(w, id), [['For Lead', 'Cancel'], ['Other agent'], ['Russian']]);
  assert.deepEqual(styles(w, id), { 'For Lead': null, 'Other agent': null, Cancel: null, Russian: null });
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).offers)[0].voice, {
    fileId: 'file-1',
    duration: 5,
    language: 'en',
    messageId: id,
  });
  const known = w.tg.sent().length;

  await bot.handleUpdate(w.tg.tapButton(id, 'Russian'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Reading again in Russian');
  assert.equal(textOf(w, id), 'Transcribing…');
  assert.deepEqual(w.tg.buttons(id), []);
  assert.equal(bot.state.offers.size, 0, 'the old offer is dropped');
  assert.equal(posts(w, '/issues').length, 0, 'nothing is created by the tap');

  await settled(bot);
  assert.equal(textOf(w, id), offerIn('Russian', 'Нарисуйте логотип синим'));
  assert.deepEqual(rows(w, id), [['For Lead', 'Cancel'], ['Other agent'], ['English']]);
  assert.equal(w.tg.sent().length, known, 'the same message is edited');
  assert.equal(bot.state.offers.size, 1);
  assert.deepEqual(flagLanguages(ctx), ['en', 'ru']);
  assert.equal(bot.state.voiceLanguage, null, 'the /settings switch is not changed');

  await bot.handleUpdate(w.tg.tapButton(id, 'For Lead'));
  const [created] = posts(w, '/issues');
  assert.equal(created.body.title, 'Нарисуйте логотип синим');
  assert.equal(created.body.description, 'Нарисуйте логотип синим');
  assert.equal(created.body.idempotencyKey, `telegram-update-${update.update_id}`);
  assert.match(textOf(w, id), outcomePattern('Created', `${TASK_LINK} for Lead`, { before: `${offerIn('Russian', 'Нарисуйте логотип синим')}\n\n` }));
  assert.deepEqual(w.tg.buttons(id), []);
});

test('the language row of an offer comes back with Back from the agent list', async (t) => {
  const ctx = await setup(t, { voice: EN_RU });
  const { w, bot } = ctx;
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Pick someone' });
  const id = placeholder.message_id;
  await bot.handleUpdate(w.tg.tapButton(id, 'Other agent'));
  assert.ok(!rows(w, id).flat().includes('Russian'));
  await bot.handleUpdate(w.tg.tapButton(id, 'Back'));
  assert.deepEqual(rows(w, id), [['For Lead', 'Cancel'], ['Other agent'], ['Russian']]);
});

test('the model row of a note offer sits above the language row, and reading again starts without the picks', async (t) => {
  const ctx = await setup(t, { voice: EN_RU });
  const { w, bot } = ctx;
  w.pc.models.claude_local = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  ];
  Object.assign(w.pc.agents.find((agent) => agent.id === 'agent-lead'), { adapterType: 'claude_local', adapterConfig: { model: 'claude-opus-5-5' } });
  await bot.agentRecords({ fresh: true });
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Draw the logo', texts: { ru: 'Нарисуйте логотип' }, delayMs: 150 });
  const id = placeholder.message_id;
  assert.deepEqual(rows(w, id), [['For Lead', 'Cancel'], ['Other agent'], ['Model · Claude Opus 5.5', 'Reasoning · Default'], ['Russian']]);

  await bot.handleUpdate(w.tg.tapButton(id, 'Model ·'));
  await bot.handleUpdate(w.tg.tapButton(id, 'Sonnet'));
  assert.deepEqual(rows(w, id)[2], ['Model · Claude Sonnet 5.5', 'Reasoning · Default']);
  assert.deepEqual(rows(w, id).at(-1), ['Russian']);

  await bot.handleUpdate(w.tg.tapButton(id, 'Russian'));
  await settled(bot);
  assert.equal(textOf(w, id), offerIn('Russian', 'Нарисуйте логотип'));
  assert.deepEqual(rows(w, id), [['For Lead', 'Cancel'], ['Other agent'], ['Model · Claude Opus 5.5', 'Reasoning · Default'], ['English']]);
});

test('an offer made from a note can be read again after a restart', async (t) => {
  const ctx = await setup(t, { voice: EN_RU });
  const { w } = ctx;
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Before', texts: { ru: 'After' } });
  const restarted = w.makeBot();
  await restarted.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Russian'));
  await settled(restarted);
  assert.equal(textOf(w, placeholder.message_id), offerIn('Russian', 'After'));
  assert.deepEqual(flagLanguages(ctx), ['en', 'ru']);
});

test('a read-again that was pending at restart is finished in the new language', async (t) => {
  const ctx = await setup(t, { forum: true, voice: EN_RU });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Hello', texts: { ru: 'Privet' } }, { thread });
  const id = placeholder.message_id;
  w.tg.files.get('file-1').data = Buffer.from(JSON.stringify({ log: ctx.log, mode: 'slow', delayMs: 60_000, text: 'Hello' }));
  await bot.handleUpdate(w.tg.tapButton(id, 'Russian'));
  await waitFor(() => flagLanguages(ctx).length === 2, { label: 'the second helper to start' });
  const [, second] = events(ctx).filter((entry) => entry.event === 'start');
  bot.stop();
  await settled(bot);
  await waitFor(() => pidGone(second.pid), { label: 'the helper to be killed' });
  const [saved] = Object.values(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).voice);
  assert.deepEqual([saved.status, saved.language, saved.text], ['pending', 'ru', null]);
  assert.equal(textOf(w, id), 'Transcribing…');

  w.tg.files.get('file-1').data = Buffer.from(JSON.stringify({ log: ctx.log, mode: 'text', text: 'Hello', texts: { ru: 'Privet' } }));
  const restarted = w.makeBot();
  const stop = runLoops(restarted);
  try {
    await waitFor(() => labels(w, id).includes('Send'), { label: 'the resumed read' });
  } finally {
    await stop();
  }
  assert.equal(textOf(w, id), heardIn('Russian', 'Privet').trimEnd());
  assert.deepEqual(flagLanguages(ctx), ['en', 'ru', 'ru']);
});

test('a read-again is saved before its Transcribing… edit, so a failed edit still ends with the new reading', async (t) => {
  const ctx = await setup(t, { forum: true, voice: EN_RU });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const { placeholder } = await dictate(ctx, TWO_READINGS, { thread });
  const id = placeholder.message_id;

  w.tg.failNext('editMessageText', 500, { ok: false, error_code: 500, description: 'Internal Server Error' });
  await bot.handleUpdate(w.tg.tapButton(id, 'Russian'));
  const saved = Object.values(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).voice);
  assert.deepEqual(saved.map((job) => [job.status, job.language]), [['pending', 'ru']]);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Reading again in Russian');
  assert.match(w.allLogText(), /warn could not show that a voice note is read again/);

  // A tap on the buttons that are still shown finds the message taken by the new reading.
  await bot.handleUpdate(w.tg.tapButton(id, 'Send'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already handled');
  assert.equal(posts(w, '/comments').length, 0);

  await settled(bot);
  assert.equal(textOf(w, id), heardIn('Russian', 'Пожалуйста, синий логотип').trimEnd());
  assert.deepEqual(rows(w, id), [['Send', 'Cancel', 'English']]);
});

test('a failed second read ends like a failed first read, in a topic and in General', async (t) => {
  const ctx = await setup(t, { forum: true, voice: EN_RU });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  for (const [options, mode, expected] of [
    [{ thread }, 'fail', 'Could not transcribe this voice note.'],
    [{ thread }, 'empty', 'No speech heard.'],
    [{}, 'fail', 'Could not transcribe this voice note.'],
    [{}, 'empty', 'No speech heard.'],
  ]) {
    const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Fine in English', modes: { ru: mode } }, options);
    const id = placeholder.message_id;
    await bot.handleUpdate(w.tg.tapButton(id, 'Russian'));
    await settled(bot);
    assert.equal(textOf(w, id), expected);
    assert.deepEqual(w.tg.buttons(id), []);
  }
  assert.equal(bot.state.voice.size, 0);
  assert.equal(bot.state.offers.size, 0);
  assert.equal(posts(w, '/comments').length + posts(w, '/issues').length, 0);
});

test('a read-again tap on a settled or an expired message behaves like the other taps', async (t) => {
  const ctx = await setup(t, { forum: true, voice: EN_RU });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);

  // A transcript that was sent.
  const sent = await dictate(ctx, { mode: 'text', text: 'Sent already' }, { thread });
  const lateTap = w.tg.tapButton(sent.placeholder.message_id, 'Russian');
  await bot.handleUpdate(w.tg.tapButton(sent.placeholder.message_id, 'Send'));
  await bot.handleUpdate(lateTap);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already handled');
  assert.match(textOf(w, sent.placeholder.message_id), outcomePattern('Sent', null, { before: heardIn('English', 'Sent already') }));

  // An offer that was cancelled.
  const cancelled = await dictate(ctx, { mode: 'text', text: 'Cancelled already' });
  const lateOfferTap = w.tg.tapButton(cancelled.placeholder.message_id, 'Russian');
  await bot.handleUpdate(w.tg.tapButton(cancelled.placeholder.message_id, 'Cancel'));
  await bot.handleUpdate(lateOfferTap);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This offer has expired');
  assert.match(textOf(w, cancelled.placeholder.message_id), outcomePattern('Cancelled', null, { before: `${offerIn('English', 'Cancelled already')}\n\n` }));
  assert.equal(flagLanguages(ctx).length, 2, 'no tap started another read');

  // Both after 24 hours; Telegram hands the tap the message as plain text.
  const old = await dictate(ctx, { mode: 'text', text: 'Too late' }, { thread });
  const oldOffer = await dictate(ctx, { mode: 'text', text: 'Too late for a task' });
  const later = w.makeBot({ now: () => Date.now() + 25 * HOUR });
  const tap = w.tg.tapButton(old.placeholder.message_id, 'Russian');
  tap.callback_query.message.text = 'Heard · English\nToo late';
  await later.handleUpdate(tap);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This voice note has expired');
  assert.match(textOf(w, old.placeholder.message_id), outcomePattern('Expired', null, { before: 'Heard · English\nToo late\n\n' }));
  const offerTap = w.tg.tapButton(oldOffer.placeholder.message_id, 'Russian');
  offerTap.callback_query.message.text = 'Heard · English:\nToo late for a task\nCreate a task from this?';
  await later.handleUpdate(offerTap);
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'This offer has expired');
  assert.match(textOf(w, oldOffer.placeholder.message_id), outcomePattern('Expired', null, { before: 'Heard · English:\nToo late for a task\nCreate a task from this?\n\n' }));
  assert.equal(flagLanguages(ctx).length, 4);
});

test('a second tap while a note is read again changes nothing and does not settle the message', async (t) => {
  const ctx = await setup(t, { forum: true, voice: EN_RU });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  for (const options of [{ thread }, {}]) {
    const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Twice', delayMs: 150 }, options);
    const id = placeholder.message_id;
    const taps = [w.tg.tapButton(id, 'Russian'), w.tg.tapButton(id, 'Russian'), w.tg.tapButton(id, options.thread ? 'Send' : 'For Lead')];
    const before = flagLanguages(ctx).length;
    await bot.handleUpdate(taps[0]);
    for (const tap of taps.slice(1)) {
      await bot.handleUpdate(tap);
      assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already handled');
      assert.equal(textOf(w, id), 'Transcribing…');
    }
    await settled(bot);
    assert.equal(flagLanguages(ctx).length, before + 1, 'the note was read once more');
    assert.match(textOf(w, id), /Heard.* · Russian/);
    assert.equal(posts(w, '/comments').length + posts(w, '/issues').length, 0);
  }
});

test('a late tap on the buttons of an earlier reading changes nothing once the new text is shown', async (t) => {
  const ctx = await setup(t, { forum: true, voice: EN_RU });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);

  // A transcript: Send, Cancel and the language button, each tapped late.
  const { placeholder } = await dictate(ctx, TWO_READINGS, { thread });
  const id = placeholder.message_id;
  const late = ['Send', 'Cancel', 'Russian'].map((label) => w.tg.tapButton(id, label));
  await bot.handleUpdate(w.tg.tapButton(id, 'Russian'));
  await settled(bot);
  const shown = textOf(w, id);
  for (const tap of late) {
    await bot.handleUpdate(tap);
    assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already handled');
  }
  assert.equal(textOf(w, id), shown);
  assert.deepEqual(labels(w, id), ['Send', 'Cancel', 'English']);
  assert.equal(posts(w, '/comments').length, 0);
  assert.equal(flagLanguages(ctx).length, 2);

  // The same for a task offer.
  const offer = await dictate(ctx, TWO_READINGS);
  const offerId = offer.placeholder.message_id;
  const lateOffer = ['For Lead', 'Cancel', 'Russian'].map((label) => w.tg.tapButton(offerId, label));
  await bot.handleUpdate(w.tg.tapButton(offerId, 'Russian'));
  await settled(bot);
  const shownOffer = textOf(w, offerId);
  for (const tap of lateOffer) {
    await bot.handleUpdate(tap);
    assert.equal(w.tg.callbackAnswers.at(-1).text, 'Already handled');
  }
  assert.equal(textOf(w, offerId), shownOffer);
  assert.deepEqual(rows(w, offerId), [['For Lead', 'Cancel'], ['Other agent'], ['English']]);
  assert.equal(bot.state.offers.size, 1);
  assert.equal(posts(w, '/issues').length, 0);
});

test('a read-again tap with a language that is not listed does nothing', async (t) => {
  const ctx = await setup(t, { forum: true, voice: EN_RU });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Stays' }, { thread });
  const general = await dictate(ctx, { mode: 'text', text: 'Stays too' });
  await bot.handleUpdate(w.tg.tap(placeholder.message_id, 'V:l:1:de'));
  await bot.handleUpdate(w.tg.tap(general.placeholder.message_id, 'V:o:1:de'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  assert.equal(flagLanguages(ctx).length, 2);
  assert.equal(bot.state.getVoice('1', Date.now()).status, 'ready');
  assert.equal(bot.state.offers.size, 1);

  // The listed language still works afterwards.
  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Russian'));
  await settled(bot);
  assert.deepEqual(flagLanguages(ctx), ['en', 'en', 'ru']);
});

test('the log keeps its fields and still holds no transcript when a note is read again', async (t) => {
  const ctx = await setup(t, { forum: true, voice: EN_RU });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Quiet words', texts: { ru: 'LOGGED-RUSSIAN' } }, { thread });
  await bot.handleUpdate(w.tg.tapButton(placeholder.message_id, 'Russian'));
  await settled(bot);
  assert.ok(w.logs.out.some((line) => /info voice note transcribed seconds=0\.1 language=en characters=11/.test(line)));
  assert.ok(w.logs.out.some((line) => /info voice note transcribed seconds=0\.1 language=ru characters=14/.test(line)));
  assert.ok(!w.allLogText().includes('LOGGED-RUSSIAN'));
  assert.ok(!w.allLogText().includes('Quiet words'));
});

test('/help names the language switch and the button only when there are two languages or more', async (t) => {
  const phrase = /The language is set in \/settings, and a button under the text reads the note again in another language\./;
  const two = await setup(t, { voice: EN_RU });
  await two.bot.handleUpdate(two.w.tg.message('/help'));
  assert.match(two.w.tg.lastMessage().text, /after you confirm\. The language is set in/);
  assert.match(two.w.tg.lastMessage().text, phrase);

  for (const voice of [{ languages: ['ru'] }, { language: 'de' }, {}]) {
    const ctx = await setup(t, { voice });
    await ctx.bot.handleUpdate(ctx.w.tg.message('/help'));
    assert.match(ctx.w.tg.lastMessage().text, /Voice notes work too/);
    assert.ok(!phrase.test(ctx.w.tg.lastMessage().text) && !/language/i.test(ctx.w.tg.lastMessage().text), JSON.stringify(voice));
  }
});

test('with one language the note names it and is read in it, but there is no switch and no button', async (t) => {
  const ctx = await setup(t, { forum: true, voice: { languages: ['ru'] } });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const view = await openSettings(ctx);
  assert.deepEqual(rows(w, view.message_id).map((row) => row[0]).filter((label) => /Voice/.test(label)), []);
  await bot.handleUpdate(w.tg.tap(view.message_id, 'S:v'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');

  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Hello' }, { thread });
  assert.equal(textOf(w, placeholder.message_id), heardIn('Russian', 'Hello').trimEnd());
  assert.deepEqual(rows(w, placeholder.message_id), [['Send', 'Cancel']]);
  const general = await dictate(ctx, { mode: 'text', text: 'A task' });
  assert.equal(textOf(w, general.placeholder.message_id), offerIn('Russian', 'A task'));
  assert.deepEqual(rows(w, general.placeholder.message_id), [['For Lead', 'Cancel'], ['Other agent']]);
  assert.deepEqual(flagLanguages(ctx), ['ru', 'ru']);
});

test('without languages the v10 messages stay: no row in /settings, no language on a message, no button', async (t) => {
  const ctx = await setup(t, { forum: true, voice: { language: 'de' } });
  const { w, bot } = ctx;
  const { thread } = await taskWithTopic(w, bot);
  const view = await openSettings(ctx);
  assert.equal(rows(w, view.message_id).length, 6);
  assert.ok(!rows(w, view.message_id).flat().some((label) => /Voice/.test(label)));
  await bot.handleUpdate(w.tg.tap(view.message_id, 'S:v'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  assert.equal(bot.state.voiceLanguage, null);

  const { placeholder } = await dictate(ctx, { mode: 'text', text: 'Hello' }, { thread });
  assert.equal(textOf(w, placeholder.message_id), heard('Hello').trimEnd());
  assert.deepEqual(rows(w, placeholder.message_id), [['Send', 'Cancel']]);
  const general = await dictate(ctx, { mode: 'text', text: 'A task' });
  assert.equal(textOf(w, general.placeholder.message_id), 'Heard:\n<blockquote>A task</blockquote>\nCreate a task from this?');
  assert.deepEqual(rows(w, general.placeholder.message_id), [['For Lead', 'Cancel'], ['Other agent']]);
  assert.equal(Object.values(JSON.parse(fs.readFileSync(w.statePath, 'utf8')).offers)[0].voice, null);

  // A button from an earlier config does nothing now.
  await bot.handleUpdate(w.tg.tap(placeholder.message_id, 'V:l:1:ru'));
  await bot.handleUpdate(w.tg.tap(general.placeholder.message_id, 'V:o:1:ru'));
  assert.equal(w.tg.callbackAnswers.at(-1).text, 'Unknown action');
  assert.deepEqual(flagLanguages(ctx), ['de', 'de']);
  assert.equal(bot.state.getVoice('1', Date.now()).status, 'ready');
});

test('saved languages that are not codes are ignored when the state loads', () => {
  const job = { status: 'pending', fileId: 'f', messageId: 1, noteId: 2 };
  const offer = { text: 'T', at: 1, messageId: 3, heard: 'T', voice: { fileId: 'f', duration: 4, language: 'ru', messageId: 9 } };
  const state = new State('unused.json', {
    voiceLanguage: 'EN',
    voice: { a: { ...job, language: 'ru' }, b: { ...job, language: 'Russian' }, c: job },
    offers: { a: offer, b: { ...offer, voice: { ...offer.voice, language: 'x' } }, c: { ...offer, voice: undefined } },
  });
  assert.equal(state.voiceLanguage, null);
  assert.deepEqual([...state.voice.values()].map((entry) => entry.language), ['ru', null, null]);
  assert.deepEqual([...state.offers.values()].map((entry) => entry.voice), [{ fileId: 'f', duration: 4, language: 'ru', messageId: 9 }, null, null]);
  assert.equal(new State('unused.json', { voiceLanguage: 'de' }).voiceLanguage, 'de');
});

test('voice.languages is checked: 1 to 4 distinct codes of 2 or 3 lowercase letters, and not together with voice.language', () => {
  const base = {
    paperclipUrl: 'http://localhost:3100',
    uiBaseUrl: 'https://paperclip.example.com',
    companyId: 'c',
    leadAgentId: 'a',
    telegramUserId: 1,
    telegramTokenFile: 't',
    paperclipTokenFile: 'p',
  };
  const parse = (extra) => parseConfig({ ...base, voice: { python: '/v/bin/python', modelsDir: '/v/models', ...extra } });
  const listProblem = 'voice.languages must be a list of 1 to 4 language codes';
  const codeProblem = 'voice.languages codes must be 2 or 3 lowercase letters, such as "en"';

  assert.deepEqual(parse({ languages: ['en', 'ru'] }).problems, []);
  assert.deepEqual(parse({ languages: ['en', 'ru'] }).config.voice.languages, ['en', 'ru']);
  assert.deepEqual(parse({ languages: ['ru'] }).config.voice.languages, ['ru']);
  assert.deepEqual(parse({ languages: ['en', 'ru', 'de', 'haw'] }).config.voice.languages, ['en', 'ru', 'de', 'haw']);
  assert.deepEqual(parse({ language: null, languages: ['en', 'ru'] }).problems, []);
  assert.equal('languages' in parse({}).config.voice, false, 'without the key nothing is added');
  assert.equal('languages' in parse({ languages: null }).config.voice, false);

  for (const languages of [[], ['en', 'ru', 'de', 'fr', 'es'], 'en', {}, 3]) assert.deepEqual(parse({ languages }).problems, [listProblem], JSON.stringify(languages));
  for (const languages of [['EN'], ['e'], ['engl'], ['en', 3], ['e1'], [''], ['en ru'], ['en', null]]) assert.deepEqual(parse({ languages }).problems, [codeProblem], JSON.stringify(languages));
  assert.deepEqual(parse({ languages: ['en', 'ru', 'en'] }).problems, ['voice.languages must not repeat a code']);
  assert.deepEqual(parse({ language: 'en', languages: ['en', 'ru'] }).problems, ['set voice.language or voice.languages, not both']);
  assert.deepEqual(parse({ language: 'en', languages: [] }).problems, ['set voice.language or voice.languages, not both', listProblem]);
});
