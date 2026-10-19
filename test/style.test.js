import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeTelegram } from './fakes/telegram.js';
import { ALLOWED_SYMBOLS, findEmoji } from './style.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function filesUnder(dir, keep) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

test('findEmoji flags pictographs and keeps the few plain symbols the bot may use', () => {
  for (const text of ['\u{1F600}', '✅ Done', '⚠️ Run failed', '\u{1F514} Follow', '\u{1F1E9}\u{1F1EA}', '1️⃣', '❤']) {
    assert.ok(findEmoji(text).length > 0, JSON.stringify(text));
  }
  for (const text of ['☑ Done messages', '☐ Running', '◀ Back', '▶', 'TST-1 · Title', 'plain text, quotes ’ and dashes — …']) {
    assert.deepEqual(findEmoji(text), [], JSON.stringify(text));
  }
  assert.deepEqual(ALLOWED_SYMBOLS, ['☑', '☐', '◀', '▶', '·']);
});

test('the fake Telegram records every visible string, so one emoji anywhere is caught', async (t) => {
  const tg = await startFakeTelegram({ chatId: 1001 });
  t.after(() => tg.close());
  const call = (method, params) =>
    fetch(`${tg.url}/bot${tg.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  const markup = { inline_keyboard: [[{ text: 'Bell \u{1F514}', callback_data: 'x' }]], input_field_placeholder: 'Reason \u{1F600}' };
  await call('sendMessage', { chat_id: 1001, text: 'Hello ✅', reply_markup: markup });
  await call('setMyCommands', { commands: [{ command: 'ping', description: 'Ping \u{1F3D3}' }] });
  await call('setMyShortDescription', { short_description: 'Short \u{1F916}' });
  await call('setMyDescription', { description: 'Long \u{1F916}' });
  await call('answerCallbackQuery', { callback_query_id: '1', text: 'Done ✅' });

  const kinds = tg.emojiFindings().map((finding) => finding.kind).sort();
  assert.deepEqual(kinds, ['answer', 'button', 'command', 'description', 'placeholder', 'short description', 'text']);
});

test('the fake Telegram does not flag the thumbs-up reaction or the allowed symbols', async (t) => {
  const tg = await startFakeTelegram({ chatId: 1001 });
  t.after(() => tg.close());
  const response = await fetch(`${tg.url}/bot${tg.token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: 1001, text: '☑ Done messages · ☐ Running', reply_markup: { inline_keyboard: [[{ text: '◀ Back', callback_data: 'x' }]] } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(tg.emojiFindings(), []);
});

test('the source, the README and the sample config hold no emoji', () => {
  const files = [
    ...filesUnder(path.join(ROOT, 'src'), (file) => file.endsWith('.js')),
    ...['README.md', 'config.example.json', 'package.json'].map((name) => path.join(ROOT, name)),
    ...filesUnder(path.join(ROOT, 'systemd'), () => true),
    ...filesUnder(path.join(ROOT, 'scripts'), () => true),
  ];
  const found = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const emoji = findEmoji(line);
        if (emoji.length > 0) found.push(`${path.relative(ROOT, file)}:${index + 1}: ${emoji.join(' ')}`);
      });
  }
  assert.deepEqual(found, []);
});
