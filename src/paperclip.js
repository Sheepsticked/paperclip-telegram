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
const UPLOAD_TIMEOUT_MS = 120_000;

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

  // `body` is sent as JSON; `form` is a FormData sent as multipart (fetch sets the content type and boundary).
  async request(method, path, { query, body, form, timeoutMs } = {}) {
    const search = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null)).toString() : '';
    const target = `${path}${search ? `?${search}` : ''}`;
    const headers = { authorization: `Bearer ${this.#token}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let payload;
    if (form !== undefined) payload = form;
    else if (body !== undefined) payload = JSON.stringify(body);
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${target}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs ?? this.#timeoutMs),
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
  // `complete` is false when the walk stopped before the end, so an absent item proves nothing.
  async attentionFeed(companyId, { maxPages = 5 } = {}) {
    const items = [];
    let cursor;
    let complete = false;
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
      if (!feed?.nextCursor) {
        complete = true;
        break;
      }
      cursor = feed.nextCursor;
    }
    return { items, complete };
  }

  async listAttention(companyId, options) {
    return (await this.attentionFeed(companyId, options)).items;
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

  postComment(issueId, body, { attachmentIds } = {}) {
    return this.request('POST', `/api/issues/${issueId}/comments`, { body: { body, ...(attachmentIds?.length ? { attachmentIds } : {}) } });
  }

  listAgents(companyId) {
    return this.request('GET', `/api/companies/${companyId}/agents`);
  }

  createIssue(companyId, body) {
    return this.request('POST', `/api/companies/${companyId}/issues`, { body });
  }

  getApproval(approvalId) {
    return this.request('GET', `/api/approvals/${approvalId}`);
  }

  approve(approvalId) {
    return this.request('POST', `/api/approvals/${approvalId}/approve`, { body: {} });
  }

  rejectApproval(approvalId) {
    return this.request('POST', `/api/approvals/${approvalId}/reject`, { body: {} });
  }

  getDecision(decisionId) {
    return this.request('GET', `/api/decisions/${decisionId}`);
  }

  decide(decisionId, body) {
    return this.request('POST', `/api/decisions/${decisionId}/decide`, { body });
  }

  dismissDecision(decisionId) {
    return this.request('POST', `/api/decisions/${decisionId}/dismiss`, { body: {} });
  }

  stalledReviewDecision(issueId, body) {
    return this.request('POST', `/api/issues/${issueId}/stalled-review-decision`, { body });
  }

  getAgent(agentId) {
    return this.request('GET', `/api/agents/${agentId}`);
  }

  // Only the given adapterConfig keys change: the server merges them into the saved ones.
  updateAgentConfig(agentId, adapterConfig) {
    return this.request('PATCH', `/api/agents/${agentId}`, { body: { adapterConfig } });
  }

  // [{ id, label }] of the models an adapter type offers.
  listAdapterModels(companyId, type) {
    return this.request('GET', `/api/companies/${companyId}/adapters/${encodeURIComponent(type)}/models`);
  }

  pauseAgent(agentId) {
    return this.request('POST', `/api/agents/${agentId}/pause`);
  }

  resumeAgent(agentId) {
    return this.request('POST', `/api/agents/${agentId}/resume`);
  }

  // The empty body is valid; the answer is a run row, or `{ status: "skipped" }` when nothing was started.
  invokeAgent(agentId) {
    return this.request('POST', `/api/agents/${agentId}/heartbeat/invoke`, { body: {} });
  }

  // Newest first; `summary` leaves out the bulky result fields.
  listRuns(companyId, query) {
    return this.request('GET', `/api/companies/${companyId}/heartbeat-runs`, { query: { summary: 'true', ...query } });
  }

  listIssueLiveRuns(issueId) {
    return this.request('GET', `/api/issues/${issueId}/live-runs`);
  }

  cancelRun(runId) {
    return this.request('POST', `/api/heartbeat-runs/${runId}/cancel`);
  }

  // Every document of the task with its body.
  listDocuments(issueId) {
    return this.request('GET', `/api/issues/${issueId}/documents`);
  }

  getDocument(issueId, key) {
    return this.request('GET', `/api/issues/${issueId}/documents/${encodeURIComponent(key)}`);
  }

  uploadAttachment(companyId, issueId, { name, type, data }) {
    const form = new FormData();
    form.append('file', new Blob([data], { type }), name);
    return this.request('POST', `/api/companies/${companyId}/issues/${issueId}/attachments`, { form, timeoutMs: UPLOAD_TIMEOUT_MS });
  }
}
