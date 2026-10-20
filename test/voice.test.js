import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.js';
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
  assert.deepEqual(labels(w, reply.message_id), ['For Lead', 'Other agent', 'Cancel']);
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
