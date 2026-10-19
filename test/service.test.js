import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const unit = fs.readFileSync(new URL('../systemd/paperclip-telegram.service.in', import.meta.url), 'utf8');

test('the service unit keeps its state directory private', () => {
  assert.match(unit, /^StateDirectory=paperclip-telegram$/m);
  assert.match(unit, /^StateDirectoryMode=0700$/m);
});
