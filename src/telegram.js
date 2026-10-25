import { TooBigError, readCapped } from './body.js';

export class TelegramError extends Error {
  constructor(method, { status = null, code = null, description = '', retryAfter = null, network = false, aborted = false }) {
    // The request URL carries the bot token, so only the method name and Telegram's own text are reported.
    super(network ? `telegram ${method} failed: ${description}` : `telegram ${method} failed: ${code ?? status} ${description}`);
    this.name = 'TelegramError';
    this.method = method;
    this.status = status;
    this.code = code;
    this.description = description;
    this.retryAfter = retryAfter;
    this.network = network;
    this.aborted = aborted;
  }
}

const UPLOAD_TIMEOUT_MS = 120_000;

// A multipart body: plain fields as strings (objects as JSON) and one part per file `{ field, name, type, data }`.
function uploadForm(fields, files) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  for (const { field, name, type, data } of files) form.append(field, new Blob([data], { type }), name);
  return form;
}

export function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export class TelegramClient {
  #baseUrl;
  #token;
  #fetch;
  #sleep;
  #maxRetries;

  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, sleep = defaultSleep, maxRetries = 3 }) {
    this.#baseUrl = baseUrl;
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
    this.#maxRetries = maxRetries;
  }

  // `params` is an object sent as JSON, or a FormData sent as multipart.
  async call(method, params = {}, { signal, timeoutMs = 30_000 } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#once(method, params, signal, timeoutMs);
      } catch (err) {
        const rateLimited = err instanceof TelegramError && err.code === 429 && err.retryAfter != null;
        if (!rateLimited || attempt >= this.#maxRetries || signal?.aborted) throw err;
        await this.#sleep(err.retryAfter * 1000, signal);
      }
    }
  }

  async #once(method, params, signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/bot${this.#token}/${method}`, {
        method: 'POST',
        ...(params instanceof FormData ? { body: params } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) }),
        signal: combined,
      });
    } catch (err) {
      throw new TelegramError(method, {
        network: true,
        aborted: Boolean(signal?.aborted),
        description: err?.cause?.code ?? err?.name ?? 'network error',
      });
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok || !body?.ok) {
      throw new TelegramError(method, {
        status: response.status,
        code: body?.error_code ?? response.status,
        description: body?.description ?? response.statusText,
        retryAfter: body?.parameters?.retry_after ?? null,
      });
    }
    return body.result;
  }

  getUpdates(params, signal) {
    return this.call('getUpdates', params, { signal, timeoutMs: ((params.timeout ?? 0) + 15) * 1000 });
  }

  sendMessage(params) {
    return this.call('sendMessage', params);
  }

  sendRichMessage(params) {
    return this.call('sendRichMessage', params);
  }

  editMessageText(params) {
    return this.call('editMessageText', params);
  }

  editMessageReplyMarkup(params) {
    return this.call('editMessageReplyMarkup', params);
  }

  answerCallbackQuery(params) {
    return this.call('answerCallbackQuery', params);
  }

  getMe() {
    return this.call('getMe');
  }

  getFile(params) {
    return this.call('getFile', params);
  }

  // Downloads a file by the path getFile returned. The URL carries the bot token, so errors name only
  // the method and a short reason; a file over `maxBytes` is refused while it streams.
  async downloadFile(filePath, { maxBytes, timeoutMs = 60_000 } = {}) {
    const fail = (details) => new TelegramError('downloadFile', details);
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/file/bot${this.#token}/${filePath}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw fail({ network: true, description: err?.cause?.code ?? err?.name ?? 'network error' });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw fail({ status: response.status, code: response.status, description: response.statusText || 'download failed' });
    }
    try {
      return await readCapped(response.body, maxBytes);
    } catch (err) {
      if (err instanceof TooBigError) throw fail({ status: 413, code: 413, description: 'file is too big' });
      throw fail({ network: true, description: err?.cause?.code ?? err?.name ?? 'network error' });
    }
  }

  // The uploads below take the usual send fields in `params` and the file as `{ name, type, data }`.
  sendPhoto(params, file) {
    return this.call('sendPhoto', uploadForm(params, [{ field: 'photo', ...file }]), { timeoutMs: UPLOAD_TIMEOUT_MS });
  }

  sendDocument(params, file) {
    return this.call('sendDocument', uploadForm(params, [{ field: 'document', ...file }]), { timeoutMs: UPLOAD_TIMEOUT_MS });
  }

  // An album of 2 to 10 files that are all photos or all documents (`kind`).
  sendMediaGroup(params, kind, files) {
    const media = files.map((file, i) => ({ type: kind, media: `attach://file${i}` }));
    const form = uploadForm({ ...params, media }, files.map((file, i) => ({ field: `file${i}`, ...file })));
    return this.call('sendMediaGroup', form, { timeoutMs: UPLOAD_TIMEOUT_MS });
  }

  getChat(params) {
    return this.call('getChat', params);
  }

  getChatMember(params) {
    return this.call('getChatMember', params);
  }

  createForumTopic(params) {
    return this.call('createForumTopic', params);
  }

  editForumTopic(params) {
    return this.call('editForumTopic', params);
  }

  closeForumTopic(params) {
    return this.call('closeForumTopic', params);
  }

  reopenForumTopic(params) {
    return this.call('reopenForumTopic', params);
  }

  deleteForumTopic(params) {
    return this.call('deleteForumTopic', params);
  }

  pinChatMessage(params) {
    return this.call('pinChatMessage', params);
  }

  setMessageReaction(params) {
    return this.call('setMessageReaction', params);
  }

  setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }

  setMyShortDescription(shortDescription) {
    return this.call('setMyShortDescription', { short_description: shortDescription });
  }

  setMyDescription(description) {
    return this.call('setMyDescription', { description });
  }
}
