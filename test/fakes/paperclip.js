import http from 'node:http';
import { randomUUID } from 'node:crypto';

const FEED_PAGE_MAX = 100;

const TERMINAL_CODES = {
  stale_target: 'interaction_stale_target',
  superseded_by_comment: 'interaction_superseded',
  superseded_by_newer_request: 'interaction_superseded',
  issue_closed: 'interaction_issue_closed',
};

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A stand-in for the Paperclip API: in-memory data, the real routes' response shapes and error codes.
export async function startFakePaperclip({ token = 'pcp_board_fakekey', companyId = 'company-1', prefix = 'TST' } = {}) {
  const agents = [
    { id: 'agent-1', companyId, name: 'Dev', role: 'engineer', status: 'idle', urlKey: 'dev' },
    { id: 'agent-lead', companyId, name: 'Lead', role: 'ceo', status: 'idle', urlKey: 'lead' },
  ];
  const issues = new Map();
  const interactions = new Map();
  const comments = [];
  const failedRuns = [];
  const requests = [];
  const idempotency = new Map();
  let issueNumber = 0;
  let clock = Date.now();
  let unauthorized = false;
  let dropConnections = false;
  const failures = [];

  // Strictly increasing timestamps that stay close to the real clock.
  const tick = () => {
    clock = Math.max(clock + 1, Date.now());
    return new Date(clock).toISOString();
  };

  function getIssue(id) {
    const issue = issues.get(id);
    if (!issue) throw new HttpError(404, 'Issue not found');
    return issue;
  }

  function issueSummary(issue) {
    return {
      kind: 'issue',
      id: issue.id,
      companyId,
      title: issue.title,
      identifier: issue.identifier,
      status: issue.status,
      href: `/${prefix}/issues/${issue.identifier}`,
      metadata: { priority: issue.priority, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId },
    };
  }

  // The list route reports a pending card on a closed issue as expired.
  function visibleInteraction(interaction) {
    const issue = issues.get(interaction.issueId);
    if (interaction.status === 'pending' && issue && ['done', 'cancelled'].includes(issue.status)) {
      return { ...interaction, status: 'expired', result: { version: 1, outcome: 'issue_closed' } };
    }
    return interaction;
  }

  function terminalError(interaction) {
    const code = TERMINAL_CODES[interaction.result?.outcome] ?? 'interaction_already_resolved';
    return new HttpError(409, 'Interaction is no longer pending', code);
  }

  function pendingInteraction(issueId, interactionId) {
    const issue = getIssue(issueId);
    const interaction = interactions.get(interactionId);
    if (!interaction || interaction.issueId !== issueId) throw new HttpError(404, 'Interaction not found', 'interaction_not_found');
    if (['done', 'cancelled'].includes(issue.status)) throw new HttpError(409, 'Issue is closed', 'interaction_issue_closed');
    if (interaction.status !== 'pending') throw terminalError(interaction);
    return interaction;
  }

  function settle(interaction, status, result) {
    interaction.status = status;
    interaction.result = result;
    interaction.resolvedAt = tick();
    interaction.updatedAt = interaction.resolvedAt;
    interaction.resolvedByUserId = 'board-user-1';
    return interaction;
  }

  function normalizeAnswers(interaction, answers) {
    const questions = interaction.payload.questions ?? [];
    const byId = new Map(questions.map((q) => [q.id, q]));
    const seen = new Map();
    for (const answer of answers) {
      const question = byId.get(answer.questionId);
      if (!question) throw new HttpError(422, `Unknown questionId: ${answer.questionId}`);
      if (seen.has(answer.questionId)) throw new HttpError(422, `Duplicate answer for questionId: ${answer.questionId}`);
      const valid = new Set(question.options.map((o) => o.id));
      const optionIds = [...new Set(answer.optionIds)];
      for (const id of optionIds) if (!valid.has(id)) throw new HttpError(422, `Unknown optionId for question ${answer.questionId}: ${id}`);
      if (question.selectionMode === 'single' && optionIds.length > 1) throw new HttpError(422, `Question ${answer.questionId} only allows one answer`);
      const otherText = answer.otherText?.trim() ?? '';
      seen.set(answer.questionId, { questionId: answer.questionId, optionIds, ...(otherText ? { otherText } : {}) });
    }
    for (const question of questions) {
      const answer = seen.get(question.id);
      if (question.required && (!answer || (answer.optionIds.length === 0 && !answer.otherText))) {
        throw new HttpError(422, `Question ${question.id} requires an answer`);
      }
    }
    return questions.map((q) => seen.get(q.id)).filter(Boolean);
  }

  function interactionItem(interaction) {
    const issue = issues.get(interaction.issueId);
    return {
      id: `issue_thread_interaction:interaction:${interaction.id}`,
      sourceKind: 'issue_thread_interaction',
      subject: {
        kind: 'interaction',
        id: interaction.id,
        companyId,
        title: interaction.title ?? interaction.summary ?? 'Interaction',
        identifier: null,
        status: interaction.status,
        href: `/${prefix}/issues/${issue.identifier}#interaction-${interaction.id}`,
        metadata: { kind: interaction.kind, issueId: issue.id, createdByAgentId: interaction.createdByAgentId, isPlanTarget: false, targetDocumentKey: null },
      },
      whyNow: 'Interaction on an issue thread.',
      inlineResolvable: true,
      dedupKey: `interaction:${interaction.id}`,
      dismissalKey: `attention:interaction:${interaction.id}`,
      dismissal: null,
      severity: 'medium',
      activityAt: interaction.updatedAt,
      createdAt: interaction.createdAt,
      updatedAt: interaction.updatedAt,
      relatedIssue: issueSummary(issue),
      detail: { kind: 'generic', summaryExcerpt: null, images: [] },
      resolverAudience: { requestedResolverPolicy: 'anyone', effectiveResolverPolicy: interaction.effectiveResolverPolicy, addresseeAgentId: null, addresseeUserId: null },
    };
  }

  function runItem(run) {
    const issue = run.issueId ? issues.get(run.issueId) : null;
    const agent = agents.find((a) => a.id === run.agentId);
    return {
      id: `failed_run:run:${run.id}`,
      sourceKind: 'failed_run',
      subject: {
        kind: 'run',
        id: run.id,
        companyId,
        title: `${agent?.name ?? 'Agent'} run failed`,
        identifier: null,
        status: 'failed',
        href: `/${prefix}/agents/${run.agentId}/runs/${run.id}`,
        metadata: {
          agentId: run.agentId,
          agentName: agent?.name ?? null,
          issueId: run.issueId ?? null,
          errorCode: run.errorCode,
          error: run.error,
          retryExhaustedReason: 'Bounded retry exhausted',
        },
      },
      whyNow: 'Run failed after automatic retries were exhausted.',
      dedupKey: `run:${run.id}`,
      severity: 'high',
      activityAt: run.at,
      createdAt: run.at,
      updatedAt: run.at,
      relatedIssue: issue ? issueSummary(issue) : null,
      detail: { kind: 'failed_run', agentName: agent?.name ?? null, failureReasonExcerpt: run.error, images: [] },
    };
  }

  // Newest pending confirmation per issue only, like the real feed.
  function feed() {
    const pending = [...interactions.values()].filter((i) => visibleInteraction(i).status === 'pending');
    const newest = new Map();
    for (const i of pending) {
      if (i.kind !== 'request_confirmation') continue;
      const best = newest.get(i.issueId);
      if (!best || i.createdAt >= best.createdAt) newest.set(i.issueId, i);
    }
    const shown = pending.filter((i) => i.kind !== 'request_confirmation' || newest.get(i.issueId) === i);
    const items = [...shown.map(interactionItem), ...failedRuns.map(runItem)];
    return items.sort((a, b) => (a.activityAt < b.activityAt ? 1 : a.activityAt > b.activityAt ? -1 : a.id < b.id ? -1 : 1));
  }

  function issueView(issue) {
    return { ...issue, labels: [], labelIds: [] };
  }

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, regex: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  route('GET', '/api/companies/:cid/attention', ({ query }) => {
    const limit = query.get('limit') ? Number(query.get('limit')) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > FEED_PAGE_MAX) throw new HttpError(400, `limit must be an integer between 1 and ${FEED_PAGE_MAX}`);
    const all = feed();
    let start = 0;
    const cursor = query.get('cursor');
    if (cursor) {
      const id = Buffer.from(cursor, 'base64url').toString('utf8');
      const index = all.findIndex((item) => item.id === id);
      if (index < 0) throw new HttpError(400, 'Attention cursor no longer matches the filtered feed');
      start = index + 1;
    }
    const items = all.slice(start, start + limit);
    const hasNext = start + items.length < all.length;
    return {
      companyId,
      generatedAt: new Date().toISOString(),
      totalCount: all.length,
      nextCursor: hasNext ? Buffer.from(items.at(-1).id).toString('base64url') : null,
      items,
    };
  });

  route('GET', '/api/companies/:cid/issues', ({ query }) => {
    let list = [...issues.values()];
    if (query.get('status')) {
      const wanted = new Set(query.get('status').split(','));
      list = list.filter((i) => wanted.has(i.status));
    }
    if (query.get('updatedSince')) {
      const since = Date.parse(query.get('updatedSince'));
      if (!Number.isFinite(since)) throw new HttpError(400, 'updatedSince must be a valid ISO 8601 timestamp when provided');
      list = list.filter((i) => Date.parse(i.updatedAt) >= since);
    }
    list.sort((a, b) => (query.get('sortDir') === 'asc' ? 1 : -1) * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt)));
    const offset = Number(query.get('offset') ?? 0);
    const limit = Number(query.get('limit') ?? 500);
    return list.slice(offset, offset + limit).map(issueView);
  });

  route('POST', '/api/companies/:cid/issues', ({ body }) => {
    const key = body.idempotencyKey ?? null;
    if (key && idempotency.has(key)) return { status: 200, body: { ...issueView(idempotency.get(key)), deduplicated: true, deduplicationReason: 'idempotency_key' } };
    if (!body.title && !body.description) throw new HttpError(422, 'Provide a title or task description');
    const issue = api.addIssue({
      title: body.title,
      description: body.description ?? null,
      status: body.status ?? (body.assigneeAgentId ? 'todo' : 'backlog'),
      assigneeAgentId: body.assigneeAgentId ?? null,
      projectId: body.projectId ?? null,
    });
    if (key) idempotency.set(key, issue);
    return { status: 201, body: issueView(issue) };
  });

  route('GET', '/api/issues/:id/interactions', ({ params }) => {
    getIssue(params.id);
    return [...interactions.values()].filter((i) => i.issueId === params.id).map(visibleInteraction);
  });

  route('POST', '/api/issues/:id/interactions/:iid/accept', ({ params, body }) => {
    const interaction = pendingInteraction(params.id, params.iid);
    const result = { version: 1, outcome: 'accepted' };
    if (interaction.kind === 'request_checkbox_confirmation') {
      const selected = body.selectedOptionIds ?? [];
      const valid = new Set(interaction.payload.options.map((o) => o.id));
      if (selected.some((id) => !valid.has(id))) throw new HttpError(422, 'Unknown option selected');
      if (selected.length < (interaction.payload.minSelected ?? 0)) throw new HttpError(422, 'Too few options selected');
      if (interaction.payload.maxSelected != null && selected.length > interaction.payload.maxSelected) throw new HttpError(422, 'Too many options selected');
      result.selectedOptionIds = selected;
    }
    return settle(interaction, 'accepted', result);
  });

  route('POST', '/api/issues/:id/interactions/:iid/reject', ({ params, body }) => {
    const interaction = pendingInteraction(params.id, params.iid);
    if (interaction.payload.rejectRequiresReason === true && !body.reason?.trim()) {
      throw new HttpError(422, 'A decline reason is required for this confirmation');
    }
    return settle(interaction, 'rejected', { version: 1, outcome: 'rejected', ...(body.reason ? { reason: body.reason } : {}) });
  });

  route('POST', '/api/issues/:id/interactions/:iid/respond', ({ params, body }) => {
    const interaction = pendingInteraction(params.id, params.iid);
    if (interaction.kind !== 'ask_user_questions') throw new HttpError(422, 'Only ask_user_questions interactions can be answered');
    if (!Array.isArray(body.answers) || body.answers.length > 20) throw new HttpError(400, 'Validation error');
    const answers = normalizeAnswers(interaction, body.answers);
    return settle(interaction, 'answered', { version: 1, answers, summaryMarkdown: null });
  });

  route('GET', '/api/issues/:id/comments', ({ params, query }) => {
    getIssue(params.id);
    const limit = Number(query.get('limit') ?? 0) || Infinity;
    const list = comments.filter((c) => c.issueId === params.id);
    list.sort((a, b) => (query.get('order') === 'asc' ? 1 : -1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt)));
    return list.slice(0, limit);
  });

  route('POST', '/api/issues/:id/comments', ({ params, body }) => {
    getIssue(params.id);
    if (typeof body.body !== 'string' || !body.body.length) throw new HttpError(400, 'Validation error');
    return { status: 201, body: api.addComment(params.id, { body: body.body, authorType: 'user' }) };
  });

  route('GET', '/api/companies/:cid/agents', () => agents);

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (dropConnections) return req.socket.destroy();
      const url = new URL(req.url, 'http://fake');
      let body;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) body = JSON.parse(raw);
      requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });

      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (unauthorized || req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Board authentication required' });
      const failure = failures.find((f) => f.method === req.method && f.pattern.test(url.pathname));
      if (failure) {
        failure.times -= 1;
        if (failure.times <= 0) failures.splice(failures.indexOf(failure), 1);
        return send(failure.status, { error: 'Injected failure' });
      }
      try {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const match = r.regex.exec(url.pathname);
          if (!match) continue;
          const out = r.handler({ params: match.groups ?? {}, query: url.searchParams, body: body ?? {} });
          return out && typeof out === 'object' && 'status' in out && 'body' in out ? send(out.status, out.body) : send(200, out);
        }
        return send(404, { error: 'Not found' });
      } catch (err) {
        if (err instanceof HttpError) return send(err.status, { error: err.message, ...(err.code ? { code: err.code } : {}) });
        return send(500, { error: 'Internal server error' });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const api = {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    companyId,
    prefix,
    agents,
    requests,
    issues,
    interactions,
    comments,
    failedRuns,
    requestsTo: (method, pathPattern) => requests.filter((r) => r.method === method && pathPattern.test(r.path)),
    setUnauthorized: (value) => {
      unauthorized = value;
    },
    setDropConnections: (value) => {
      dropConnections = value;
    },
    // Makes matching requests answer with `status` (for `times` calls) instead of reaching the route.
    failRequests(method, pattern, status = 500, times = Infinity) {
      failures.push({ method, pattern, status, times });
    },
    clearFailures: () => failures.splice(0),
    addIssue({ title, description = null, status = 'todo', assigneeAgentId = null, projectId = null, createdAt, updatedAt } = {}) {
      issueNumber += 1;
      const now = tick();
      const issue = {
        id: randomUUID(),
        companyId,
        projectId,
        title,
        description,
        status,
        priority: 'medium',
        assigneeAgentId,
        assigneeUserId: null,
        issueNumber,
        identifier: `${prefix}-${issueNumber}`,
        createdAt: createdAt ?? now,
        updatedAt: updatedAt ?? now,
      };
      issues.set(issue.id, issue);
      return issue;
    },
    setStatus(issueId, status) {
      const issue = getIssue(issueId);
      issue.status = status;
      issue.updatedAt = tick();
      return issue;
    },
    addInteraction(issueId, { kind, title = null, summary = null, payload, createdAt } = {}) {
      getIssue(issueId);
      const now = createdAt ?? tick();
      const interaction = {
        id: randomUUID(),
        companyId,
        issueId,
        kind,
        idempotencyKey: null,
        status: 'pending',
        continuationPolicy: 'wake_assignee',
        title,
        summary,
        createdByAgentId: 'agent-1',
        createdByUserId: null,
        addresseeAgentId: null,
        addresseeUserId: null,
        resolvedByAgentId: null,
        resolvedByUserId: null,
        payload,
        result: null,
        requestedResolverPolicy: 'anyone',
        effectiveResolverPolicy: 'anyone',
        resolverPolicyProvenance: 'inherited',
        effectiveResolverPolicySource: 'requested',
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      interactions.set(interaction.id, interaction);
      return interaction;
    },
    // Settles a card as if someone had answered it in the Paperclip UI.
    resolveElsewhere(interactionId, status = 'accepted', result = { version: 1, outcome: status }) {
      return settle(interactions.get(interactionId), status, result);
    },
    addComment(issueId, { body, authorType = 'agent' }) {
      const comment = {
        id: randomUUID(),
        companyId,
        issueId,
        authorAgentId: authorType === 'agent' ? 'agent-1' : null,
        authorUserId: authorType === 'user' ? 'board-user-1' : null,
        authorType,
        body,
        createdAt: tick(),
        updatedAt: tick(),
      };
      comments.push(comment);
      return comment;
    },
    addFailedRun({ agentId = 'agent-1', issueId = null, errorCode = 'adapter_failed', error = 'The adapter exited with code 1' } = {}) {
      const run = { id: randomUUID(), agentId, issueId, errorCode, error, at: tick() };
      failedRuns.push(run);
      return run;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  return api;
}
