export class PaperclipError extends Error {
  constructor(method, path, { status = null, code = null, detail = '', network = false }) {
    super(network ? `paperclip ${method} ${path} failed: ${detail}` : `paperclip ${method} ${path} failed: ${status} ${detail}`);
    this.name = 'PaperclipError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.network = network;
  }
}

const ATTENTION_PAGE_LIMIT = 100;

// Board-key client. It never sends a run id header, so the owner's comments stay human comments.
export class PaperclipClient {
  #baseUrl;
  #token;
  #fetch;
  #timeoutMs;

  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
    this.#baseUrl = baseUrl;
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  async request(method, path, { query, body } = {}) {
    const search = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString() : '';
    const target = `${path}${search ? `?${search}` : ''}`;
    const headers = { authorization: `Bearer ${this.#token}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${target}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new PaperclipError(method, path, { network: true, detail: err?.cause?.code ?? err?.name ?? 'network error' });
    }
    const text = await response.text().catch(() => '');
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      throw new PaperclipError(method, path, {
        status: response.status,
        code: typeof parsed?.code === 'string' ? parsed.code : null,
        detail: typeof parsed?.error === 'string' ? parsed.error : response.statusText,
      });
    }
    return parsed;
  }

  // Pages through the attention feed; a cursor that went stale mid-walk keeps the pages already read.
  async listAttention(companyId, { maxPages = 5 } = {}) {
    const items = [];
    let cursor;
    for (let page = 0; page < maxPages; page += 1) {
      let feed;
      try {
        feed = await this.request('GET', `/api/companies/${companyId}/attention`, {
          query: { limit: ATTENTION_PAGE_LIMIT, includeDismissed: 'true', cursor },
        });
      } catch (err) {
        if (page > 0 && err.status === 400) break;
        throw err;
      }
      items.push(...(feed?.items ?? []));
      if (!feed?.nextCursor) break;
      cursor = feed.nextCursor;
    }
    return items;
  }

  listIssues(companyId, query) {
    return this.request('GET', `/api/companies/${companyId}/issues`, { query });
  }

  // `ref` is an issue id or an identifier such as ABC-12.
  getIssue(ref) {
    return this.request('GET', `/api/issues/${encodeURIComponent(ref)}`);
  }

  updateIssue(issueId, body) {
    return this.request('PATCH', `/api/issues/${issueId}`, { body });
  }

  listProjects(companyId) {
    return this.request('GET', `/api/companies/${companyId}/projects`);
  }

  listInteractions(issueId) {
    return this.request('GET', `/api/issues/${issueId}/interactions`);
  }

  accept(issueId, interactionId, body = {}) {
    return this.request('POST', `/api/issues/${issueId}/interactions/${interactionId}/accept`, { body });
  }

  reject(issueId, interactionId, body = {}) {
    return this.request('POST', `/api/issues/${issueId}/interactions/${interactionId}/reject`, { body });
  }

  respond(issueId, interactionId, body) {
    return this.request('POST', `/api/issues/${issueId}/interactions/${interactionId}/respond`, { body });
  }

  listComments(issueId, query = { limit: 10, order: 'desc' }) {
    return this.request('GET', `/api/issues/${issueId}/comments`, { query });
  }

  postComment(issueId, body) {
    return this.request('POST', `/api/issues/${issueId}/comments`, { body: { body } });
  }

  listAgents(companyId) {
    return this.request('GET', `/api/companies/${companyId}/agents`);
  }

  createIssue(companyId, body) {
    return this.request('POST', `/api/companies/${companyId}/issues`, { body });
  }
}
