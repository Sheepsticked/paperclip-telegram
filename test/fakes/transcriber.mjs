// Stands in for scripts/transcribe.py in tests, called with the same arguments. The audio file holds a JSON job:
//   { mode: 'text' | 'empty' | 'fail' | 'slow', text, delayMs, log }
// 'text' prints `text`, 'empty' prints no speech, 'fail' exits with an error and 'slow' waits `delayMs` (30 s by
// default) before it prints `text`. With `log` it appends what it did to that file, one JSON object per line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [audio, ...flags] = process.argv.slice(2);

// The test runner also loads every file under test/; without an audio file there is nothing to do.
if (audio) {
  const job = JSON.parse(fs.readFileSync(audio, 'utf8'));
  const dir = path.dirname(audio);
  const note = (event, extra = {}) => {
    if (job.log) fs.appendFileSync(job.log, `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...extra })}\n`);
  };
  note('start', { flags, dir, dirMode: fs.statSync(dir).mode & 0o777, fileMode: fs.statSync(audio).mode & 0o777, nice: os.getPriority() });

  const delayMs = job.mode === 'slow' ? (job.delayMs ?? 30_000) : (job.delayMs ?? 0);
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  if (job.mode === 'fail') {
    note('end', { failed: true });
    process.stderr.write('transcribe: RuntimeError: the model failed\n');
    process.exit(1);
  }
  note('end');
  process.stdout.write(`${JSON.stringify({ text: job.mode === 'empty' ? '' : job.text ?? '', language: 'en', seconds: 0.1 })}\n`);
}
