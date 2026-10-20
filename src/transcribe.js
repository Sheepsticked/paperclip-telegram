import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'transcribe.py');
const MIN_TIMEOUT_SECONDS = 60;
const TIMEOUT_FACTOR = 4;
const NICE_LEVEL = '10';
const MAX_OUTPUT = 1024 * 1024;
const MAX_REASON = 200;

// A transcription that failed; the message is a short reason that never holds the transcript.
export class TranscribeError extends Error {}

// How long the helper may run for a note of `duration` seconds, in milliseconds.
export function transcribeTimeoutMs(duration) {
  return Math.max(MIN_TIMEOUT_SECONDS, TIMEOUT_FACTOR * duration) * 1000;
}

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);

// Runs scripts/transcribe.py in the configured Python for one audio file at a time. The audio goes into a private
// temporary directory that is removed afterwards, and the helper is killed when it runs too long or on `stop()`.
export class Transcriber {
  #voice;
  #timeoutMs;
  #child = null;
  #stopped = false;

  constructor(voice, { timeoutMs = transcribeTimeoutMs } = {}) {
    this.#voice = voice;
    this.#timeoutMs = timeoutMs;
  }

  // Resolves with { text, language, seconds }; rejects with a TranscribeError. `language` overrides the configured one;
  // null detects it.
  async transcribe(audio, { duration = 0, language = this.#voice.language } = {}) {
    if (this.#stopped) throw new TranscribeError('stopped');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-telegram-voice-'));
    try {
      fs.chmodSync(dir, 0o700);
      const file = path.join(dir, 'voice.ogg');
      fs.writeFileSync(file, audio, { mode: 0o600 });
      return await this.#run(file, language, this.#timeoutMs(duration));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Kills a running helper and refuses new work.
  stop() {
    this.#stopped = true;
    this.#child?.kill('SIGKILL');
  }

  #args(file, language) {
    const { python, modelsDir, model, threads, beamSize } = this.#voice;
    return [
      '-n', NICE_LEVEL, python, SCRIPT, file,
      '--model', model,
      '--models-dir', modelsDir,
      '--threads', String(threads),
      '--beam', String(beamSize),
      ...(language ? ['--language', language] : []),
    ];
  }

  #run(file, language, timeoutMs) {
    return new Promise((resolve, reject) => {
      const child = spawn('nice', this.#args(file, language), { stdio: ['ignore', 'pipe', 'pipe'] });
      this.#child = child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      const settle = (done, value) => {
        clearTimeout(timer);
        this.#child = null;
        done(value);
      };
      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_OUTPUT) stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_OUTPUT) stderr += chunk;
      });
      child.on('error', (err) => settle(reject, new TranscribeError(`could not start the helper: ${err.code ?? 'error'}`)));
      child.on('close', (code, signal) => {
        if (timedOut) return settle(reject, new TranscribeError(`timed out after ${Math.round(timeoutMs / 1000)} s`));
        if (code !== 0) return settle(reject, new TranscribeError(`helper ${signal ? `killed by ${signal}` : `exited with ${code}`}: ${oneLine(stderr) || 'no message'}`));
        try {
          return settle(resolve, parseResult(stdout));
        } catch (err) {
          return settle(reject, err);
        }
      });
    });
  }
}

// The helper prints one JSON line: { text, language, seconds }.
function parseResult(stdout) {
  const line = stdout.split('\n').map((entry) => entry.trim()).filter(Boolean).at(-1);
  let result;
  try {
    result = JSON.parse(line ?? '');
  } catch {
    throw new TranscribeError('the helper printed no result');
  }
  if (typeof result?.text !== 'string') throw new TranscribeError('the helper printed no text');
  return { text: result.text.trim(), language: typeof result.language === 'string' ? result.language : null, seconds: Number(result.seconds) || 0 };
}
