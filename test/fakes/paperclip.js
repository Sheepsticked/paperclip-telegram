import http from 'node:http';
import { randomUUID } from 'node:crypto';

const FEED_PAGE_MAX = 100;
const ISSUE_LIST_MAX = 1000;
const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const OPEN_APPROVAL = ['pending', 'revision_requested'];
const RUN_ACTIVE = ['queued', 'running'];

const TERMINAL_CODES = {
  stale_target: 'interaction_stale_target',
  superseded_by_comment: 'interaction_superseded',
  superseded_by_newer_request: 'interaction_superseded',
  issue_closed: 'interaction_issue_closed',
};

// A route result with an explicit status code (any other result is sent as 200).
class Reply {
  constructor(status, body) {
    this.status = status;
    this.body = body;
  }
}

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
    { id: 'agent-1', companyId, name: 'Dev', role: 'engineer', title: null, status: 'idle', urlKey: 'dev', pauseReason: null, pausedAt: null, lastHeartbeatAt: null },
    { id: 'agent-lead', companyId, name: 'Lead', role: 'ceo', title: null, status: 'idle', urlKey: 'lead', pauseReason: null, pausedAt: null, lastHeartbeatAt: null },
  ];
  const issues = new Map();
  const interactions = new Map();
  const comments = [];
  const projects = [];
  const failedRuns = [];
  const approvals = new Map();
  const approvalIssues = new Map();
  const decisions = new Map();
  const reviews = new Map();
  const staticItems = [];
  const runs = [];
  const documents = [];
  const attachments = [];
  const dismissed = new Set();
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

  // Routes take the UUID or the identifier (TST-3), like the server.
  function getIssue(ref) {
    const issue = issues.get(ref) ?? [...issues.values()].find((i) => i.identifier.toLowerCase() === String(ref).toLowerCase());
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

  // The fields every real feed item carries.
  function baseItem(sourceKind, dedupKey, fields) {
    return {
      id: `${sourceKind}:${dedupKey}`,
      sourceKind,
      dedupKey,
      dismissalKey: `attention:${dedupKey}`,
      dismissal: dismissed.has(dedupKey) ? { kind: 'dismiss', dismissedAt: tick(), snoozedUntil: null, isActive: true } : null,
      severity: 'medium',
      relatedIssue: null,
      detail: { kind: 'generic', summaryExcerpt: null, images: [] },
      ...fields,
    };
  }

  function approvalItem(approval) {
    return baseItem('approval', `approval:${approval.id}`, {
      subject: {
        kind: 'approval',
        id: approval.id,
        companyId,
        title: approval.payload.title ?? approval.type,
        identifier: null,
        status: approval.status,
        href: `/${prefix}/approvals/${approval.id}`,
        metadata: { type: approval.type, requestedByAgentId: approval.requestedByAgentId, requestedByUserId: approval.requestedByUserId, issueId: approvalIssues.get(approval.id) ?? null },
      },
      whyNow: 'Approval is pending a board decision.',
      inlineResolvable: approval.type !== 'request_board_approval',
      activityAt: approval.updatedAt,
      createdAt: approval.createdAt,
      updatedAt: approval.updatedAt,
      detail: { kind: 'approval', approvalType: approval.type, summaryExcerpt: approval.payload.title ?? null, images: [] },
    });
  }

  function decisionItem(decision) {
    return baseItem('decision', `decision:${decision.id}`, {
      subject: {
        kind: 'decision',
        id: decision.id,
        companyId,
        title: decision.title,
        identifier: null,
        status: decision.status,
        href: `/${prefix}/decisions?decisionId=${decision.id}`,
        metadata: { originIssueId: decision.originIssueId, originAgentId: decision.originAgentId, bundleId: null, bundleTitle: null },
      },
      whyNow: 'An agent decision is waiting for a board response.',
      inlineResolvable: true,
      activityAt: decision.updatedAt,
      createdAt: decision.createdAt,
      updatedAt: decision.updatedAt,
      relatedIssue: issueSummary(issues.get(decision.originIssueId)),
      detail: { kind: 'generic', summaryExcerpt: decision.body.slice(0, 240), images: [] },
    });
  }

  // The subject is the issue itself; a stalled review says so in its metadata.
  function reviewItem(issue, review) {
    const subject = issueSummary(issue);
    return baseItem('review', `review:${issue.id}`, {
      subject: review.stalled ? { ...subject, metadata: { ...subject.metadata, reviewAttentionState: 'stalled' } } : subject,
      whyNow: review.stalled
        ? 'Issue is in review without a maintained reviewer, interaction, approval, monitor, run, wake, or recovery path.'
        : 'Issue is in review and assigned to a user.',
      inlineResolvable: review.stalled,
      severity: review.stalled ? 'high' : 'medium',
      activityAt: issue.updatedAt,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    });
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
    const items = [
      ...shown.map(interactionItem),
      ...failedRuns.map(runItem),
      ...[...approvals.values()].filter((a) => OPEN_APPROVAL.includes(a.status)).map(approvalItem),
      ...[...decisions.values()].filter((d) => d.status === 'open').map(decisionItem),
      ...[...reviews].filter(([issueId]) => issues.get(issueId)?.status === 'in_review').map(([issueId, review]) => reviewItem(issues.get(issueId), review)),
      ...staticItems.filter((entry) => entry.active).map((entry) => baseItem(entry.item.sourceKind, entry.item.dedupKey, entry.item)),
    ];
    return items.sort((a, b) => (a.activityAt < b.activityAt ? 1 : a.activityAt > b.activityAt ? -1 : a.id < b.id ? -1 : 1));
  }

  function issueView(issue) {
    return { ...issue, labels: [], labelIds: [] };
  }

  // Document rows without the body, as the issue detail route lists them.
  const documentSummary = ({ body, ...rest }) => rest;

  // The single-issue route also embeds the project row and the document summaries.
  function issueDetail(issue) {
    const project = projects.find((p) => p.id === issue.projectId);
    const own = documents.filter((d) => d.issueId === issue.id);
    return {
      ...issueView(issue),
      project: project ? { id: project.id, name: project.name, urlKey: project.urlKey, status: project.status } : null,
      planDocument: own.find((d) => d.key === 'plan') ?? null,
      documentSummaries: own.map(documentSummary),
    };
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
    if (query.get('assigneeAgentId')) list = list.filter((i) => i.assigneeAgentId === query.get('assigneeAgentId'));
    if (query.get('projectId')) list = list.filter((i) => i.projectId === query.get('projectId'));
    if (query.get('updatedSince')) {
      const since = Date.parse(query.get('updatedSince'));
      if (!Number.isFinite(since)) throw new HttpError(400, 'updatedSince must be a valid ISO 8601 timestamp when provided');
      list = list.filter((i) => Date.parse(i.updatedAt) >= since);
    }
    const q = query.get('q')?.trim().toLowerCase();
    if (q) {
      const inComments = (issue) => comments.some((c) => c.issueId === issue.id && !c.deletedAt && c.body.toLowerCase().includes(q));
      list = list.filter((i) => [i.title, i.identifier, i.description ?? ''].some((v) => v.toLowerCase().includes(q)) || inComments(i));
    }
    list.sort((a, b) => (query.get('sortDir') === 'asc' ? 1 : -1) * (Date.parse(a.updatedAt) - Date.parse(b.updatedAt)));
    const offset = Number(query.get('offset') ?? 0);
    const limit = Number(query.get('limit') ?? 500);
    if (!Number.isInteger(limit) || limit < 1 || limit > ISSUE_LIST_MAX) throw new HttpError(400, 'Validation error');
    return list.slice(offset, offset + limit).map(issueView);
  });

  route('POST', '/api/companies/:cid/issues', ({ body }) => {
    const key = body.idempotencyKey ?? null;
    if (key && idempotency.has(key)) return new Reply(200, { ...issueView(idempotency.get(key)), deduplicated: true, deduplicationReason: 'idempotency_key' });
    if (!body.title && !body.description) throw new HttpError(422, 'Provide a title or task description');
    const issue = api.addIssue({
      title: body.title,
      description: body.description ?? null,
      status: body.status ?? (body.assigneeAgentId ? 'todo' : 'backlog'),
      assigneeAgentId: body.assigneeAgentId ?? null,
      projectId: body.projectId ?? null,
    });
    if (key) idempotency.set(key, issue);
    return new Reply(201, issueView(issue));
  });

  route('GET', '/api/issues/:id', ({ params }) => issueDetail(getIssue(params.id)));

  route('PATCH', '/api/issues/:id', ({ params, body }) => {
    const issue = getIssue(params.id);
    const allowed = ['status', 'assigneeAgentId', 'assigneeUserId', 'projectId', 'title', 'description', 'priority'];
    if (Object.keys(body).some((k) => !allowed.includes(k))) throw new HttpError(400, 'Validation error');
    if (body.status !== undefined && !STATUSES.includes(body.status)) throw new HttpError(400, 'Validation error');
    if (body.projectId != null && !UUID.test(body.projectId) && !projects.some((p) => p.id === body.projectId)) throw new HttpError(400, 'Validation error');
    if (body.assigneeAgentId != null) {
      const agent = agents.find((a) => a.id === body.assigneeAgentId);
      if (!agent) throw new HttpError(404, 'Agent not found');
      if (['terminated', 'pending_approval'].includes(agent.status)) throw new HttpError(409, `Cannot assign work to ${agent.status} agent`);
    }
    const nextAgent = body.assigneeAgentId !== undefined ? body.assigneeAgentId : issue.assigneeAgentId;
    const nextUser = body.assigneeUserId !== undefined ? body.assigneeUserId : issue.assigneeUserId;
    if (nextAgent && nextUser) throw new HttpError(422, 'Issue can only have one assignee');
    const changes = {};
    for (const key of allowed) {
      if (key === 'assigneeAgentId' || key === 'assigneeUserId') continue;
      if (body[key] !== undefined && body[key] !== issue[key]) {
        changes[key] = body[key];
        issue[key] = body[key];
      }
    }
    if (nextAgent !== issue.assigneeAgentId) changes.assigneeAgentId = nextAgent;
    if (nextUser !== issue.assigneeUserId) changes.assigneeUserId = nextUser;
    issue.assigneeAgentId = nextAgent;
    issue.assigneeUserId = nextUser;
    issue.updatedAt = tick();
    return { ...issueDetail(issue), changes };
  });

  route('GET', '/api/companies/:cid/projects', ({ query }) => {
    const archived = query.get('includeArchived') === 'true';
    return projects.filter((p) => archived || !p.archivedAt);
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
    const issue = getIssue(params.id);
    const limit = Number(query.get('limit') ?? 0) || Infinity;
    const asc = query.get('order') === 'asc';
    let list = comments.filter((c) => c.issueId === issue.id);
    list.sort((a, b) => (asc ? 1 : -1) * (Date.parse(a.createdAt) - Date.parse(b.createdAt)));
    // `after` is exclusive; an unknown or malformed anchor yields an empty page.
    const after = query.get('after');
    if (after) {
      const index = UUID.test(after) ? list.findIndex((c) => c.id === after) : -1;
      list = index < 0 ? [] : list.slice(index + 1);
    }
    return list.slice(0, limit);
  });

  route('POST', '/api/issues/:id/comments', ({ params, body }) => {
    const issue = getIssue(params.id);
    if (typeof body.body !== 'string' || !body.body.length) throw new HttpError(400, 'Validation error');
    const ids = body.attachmentIds ?? [];
    if (!Array.isArray(ids) || ids.length > 20 || new Set(ids).size !== ids.length || ids.some((id) => !UUID.test(id))) throw new HttpError(400, 'Validation error');
    const bound = ids.map((id) => attachments.find((a) => a.id === id && a.issueId === issue.id && a.commentId === null));
    if (bound.some((a) => !a)) throw new HttpError(422, 'Comment attachments must belong to the same task and company');
    const comment = api.addComment(issue.id, { body: body.body, authorType: 'user' });
    for (const attachment of bound) attachment.commentId = comment.id;
    comment.attachmentIds = ids;
    return new Reply(201, comment);
  });

  const only = (body, keys) => {
    if (Object.keys(body).some((key) => !keys.includes(key))) throw new HttpError(400, 'Validation error');
  };

  function approvalRow(id) {
    const approval = approvals.get(id);
    if (!approval) throw new HttpError(404, 'Approval not found');
    return approval;
  }

  route('GET', '/api/approvals/:id', ({ params }) => approvalRow(params.id));

  // An approval already in the target state is a no-op; any other settled one is refused.
  function settleApproval(id, body, status, verb) {
    only(body, ['decisionNote']);
    const approval = approvalRow(id);
    if (approval.status === status) return approval;
    if (!OPEN_APPROVAL.includes(approval.status)) throw new HttpError(422, `Only pending or revision requested approvals can be ${verb}`);
    const stored = approvals.get(id);
    stored.status = status;
    stored.updatedAt = tick();
    return stored;
  }

  route('POST', '/api/approvals/:id/approve', ({ params, body }) => settleApproval(params.id, body, 'approved', 'approved'));
  route('POST', '/api/approvals/:id/reject', ({ params, body }) => settleApproval(params.id, body, 'rejected', 'rejected'));

  function decisionRow(id) {
    const decision = decisions.get(id);
    if (!decision) throw new HttpError(404, 'Decision not found');
    return decision;
  }

  route('GET', '/api/decisions/:id', ({ params }) => ({ ...decisionRow(params.id), executions: [] }));

  route('POST', '/api/decisions/:id/decide', ({ params, body }) => {
    only(body, ['optionId', 'inputValues', 'idempotencyKey']);
    if (typeof body.optionId !== 'string' || body.optionId.length < 1 || body.optionId.length > 120) throw new HttpError(400, 'Validation error');
    const decision = decisionRow(params.id);
    if (decision.status === 'decided' && body.idempotencyKey && decision.idempotencyKey === body.idempotencyKey) return decision;
    if (decision.status === 'expired') throw new HttpError(409, 'Decision has expired', 'decision_expired');
    if (decision.status !== 'open') throw new HttpError(409, 'Decision is already resolved', 'decision_already_resolved');
    const option = decision.options.find((o) => o.id === body.optionId);
    if (!option) throw new HttpError(422, `Unknown option: ${body.optionId}`);
    for (const input of decision.inputs ?? []) {
      if (input.required && !body.inputValues?.[input.id]) throw new HttpError(422, `Input ${input.id} is required`);
    }
    Object.assign(decision, { status: 'decided', chosenOptionId: option.id, inputValues: body.inputValues ?? null, idempotencyKey: body.idempotencyKey ?? null, decidedAt: tick(), updatedAt: tick() });
    return decision;
  });

  route('POST', '/api/decisions/:id/dismiss', ({ params, body }) => {
    only(body, ['reason']);
    const decision = decisionRow(params.id);
    if (decision.status !== 'open') throw new HttpError(409, 'Decision is already resolved', 'decision_already_resolved');
    // Like the server, a dismiss decides the first option without effects, so an empty required input refuses it.
    if (decision.options.some((option) => option.effects.length === 0)) {
      for (const input of decision.inputs ?? []) if (input.required) throw new HttpError(422, `Input ${input.id} is required`);
    }
    Object.assign(decision, { status: 'cancelled', updatedAt: tick() });
    return decision;
  });

  // A stalled review is decided in place: approve closes the issue, the other two send it back to todo.
  route('POST', '/api/issues/:id/stalled-review-decision', ({ params, body }) => {
    only(body, ['action', 'note']);
    if (!['approve', 'request_changes', 'send_back'].includes(body.action)) throw new HttpError(400, 'Validation error');
    if (body.note !== undefined && (typeof body.note !== 'string' || !body.note.length)) throw new HttpError(400, 'Validation error');
    if (body.action === 'request_changes' && !body.note?.trim()) throw new HttpError(400, 'Validation error');
    const issue = getIssue(params.id);
    if (issue.status !== 'in_review' || !reviews.get(issue.id)?.stalled) throw new HttpError(409, 'Issue is no longer a stalled review');
    const comment = body.note ? api.addComment(issue.id, { body: body.note, authorType: 'user' }) : null;
    api.setStatus(issue.id, body.action === 'approve' ? 'done' : 'todo');
    return { issue: issueDetail(issue), action: body.action, comment, wakeQueued: body.action !== 'approve' };
  });

  function agentRow(id) {
    const agent = agents.find((a) => a.id === id);
    if (!agent) throw new HttpError(404, 'Agent not found');
    return agent;
  }

  function releaseIssue(runId) {
    for (const issue of issues.values()) {
      if (issue.executionRunId === runId) Object.assign(issue, { executionRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    }
  }

  function cancelRun(run) {
    if (!RUN_ACTIVE.includes(run.status)) return run;
    Object.assign(run, { status: 'cancelled', finishedAt: tick() });
    releaseIssue(run.id);
    return run;
  }

  route('GET', '/api/agents/:id', ({ params }) => agentRow(params.id));

  // Pausing also cancels the agent's active runs.
  route('POST', '/api/agents/:id/pause', ({ params }) => {
    const agent = agentRow(params.id);
    if (agent.status === 'terminated') throw new HttpError(409, 'Cannot pause a terminated agent');
    Object.assign(agent, { status: 'paused', pauseReason: 'manual', pausedAt: tick() });
    for (const run of runs.filter((r) => r.agentId === agent.id)) cancelRun(run);
    return agent;
  });

  route('POST', '/api/agents/:id/resume', ({ params }) => {
    const agent = agentRow(params.id);
    if (agent.status === 'terminated') throw new HttpError(409, 'Cannot resume a terminated agent');
    Object.assign(agent, { status: 'idle', pauseReason: null, pausedAt: null });
    return agent;
  });

  // An empty body is valid; a paused agent answers 202 "skipped".
  route('POST', '/api/agents/:id/heartbeat/invoke', ({ params, body }) => {
    only(body, ['reason', 'triggerDetail', 'payload', 'idempotencyKey', 'forceFreshSession']);
    const agent = agentRow(params.id);
    if (agent.status === 'terminated') throw new HttpError(409, 'Cannot run a terminated agent');
    if (agent.status === 'paused') return new Reply(202, { status: 'skipped' });
    return api.addRun({ agentId: agent.id, status: 'queued', source: 'on_demand' });
  });

  route('GET', '/api/companies/:cid/heartbeat-runs', ({ query }) => {
    let list = [...runs].reverse();
    if (query.get('agentId')) list = list.filter((r) => r.agentId === query.get('agentId'));
    const limit = Number(query.get('limit') ?? 200);
    return list.slice(0, limit);
  });

  route('POST', '/api/heartbeat-runs/:id/cancel', ({ params }) => {
    const run = runs.find((r) => r.id === params.id);
    if (!run) throw new HttpError(404, 'Heartbeat run not found');
    return cancelRun(run);
  });

  route('GET', '/api/issues/:id/documents', ({ params }) => documents.filter((d) => d.issueId === getIssue(params.id).id));

  route('GET', '/api/issues/:id/documents/:key', ({ params }) => {
    const doc = documents.find((d) => d.issueId === getIssue(params.id).id && d.key === params.key.toLowerCase());
    if (!doc) throw new HttpError(404, 'Document not found');
    return doc;
  });

  // Multipart upload with the file in the field "file".
  route('POST', '/api/companies/:cid/issues/:iid/attachments', async ({ params, form }) => {
    const issue = getIssue(params.iid);
    const file = form?.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, 'Missing file field "file"');
    if (file.size === 0) throw new HttpError(422, 'Attachment is empty');
    if (file.size > MAX_ATTACHMENT_BYTES) throw new HttpError(422, 'Attachment is larger than the 10 MB limit');
    const attachment = {
      id: randomUUID(),
      companyId,
      issueId: issue.id,
      issueCommentId: null,
      contentType: file.type,
      byteSize: file.size,
      originalFilename: file.name,
      createdAt: tick(),
    };
    attachments.push({ ...attachment, commentId: null, data: Buffer.from(await file.arrayBuffer()) });
    return new Reply(201, attachment);
  });

  // The server rejects query parameters on this route.
  route('GET', '/api/companies/:cid/agents', ({ query }) => {
    if ([...query.keys()].length > 0) throw new HttpError(400, 'Validation error');
    return agents;
  });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      if (dropConnections) return req.socket.destroy();
      const url = new URL(req.url, 'http://fake');
      const raw = Buffer.concat(chunks);
      const type = req.headers['content-type'] ?? '';
      let body;
      let form;
      if (type.startsWith('multipart/form-data')) {
        form = await new Response(raw, { headers: { 'content-type': type } }).formData();
        // The request log keeps the structure of the parts, not their bytes.
        body = { multipart: [...form].map(([name, value]) => (typeof value === 'string' ? { name, value } : { name, filename: value.name, type: value.type, size: value.size })) };
      } else if (raw.length > 0) {
        body = JSON.parse(raw.toString('utf8'));
      }
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
        return send(failure.status, { error: failure.message });
      }
      try {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const match = r.regex.exec(url.pathname);
          if (!match) continue;
          const out = await r.handler({ params: match.groups ?? {}, query: url.searchParams, body: form ? {} : (body ?? {}), form });
          return out instanceof Reply ? send(out.status, out.body) : send(200, out);
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
    projects,
    failedRuns,
    approvals,
    decisions,
    reviews,
    runs,
    documents,
    attachments,
    requestsTo: (method, pathPattern) => requests.filter((r) => r.method === method && pathPattern.test(r.path)),
    setUnauthorized: (value) => {
      unauthorized = value;
    },
    setDropConnections: (value) => {
      dropConnections = value;
    },
    // Makes matching requests answer with `status` (for `times` calls) instead of reaching the route.
    failRequests(method, pattern, status = 500, times = Infinity, message = 'Injected failure') {
      failures.push({ method, pattern, status, times, message });
    },
    clearFailures: () => failures.splice(0),
    addIssue({ title, description = null, status = 'todo', assigneeAgentId = null, assigneeUserId = null, projectId = null, parentId = null, createdAt, updatedAt } = {}) {
      issueNumber += 1;
      const now = tick();
      const issue = {
        id: randomUUID(),
        companyId,
        projectId,
        parentId,
        title,
        description,
        status,
        priority: 'medium',
        assigneeAgentId,
        assigneeUserId,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
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
    addProject({ name, urlKey = name.toLowerCase().replace(/\W+/g, '-'), archived = false } = {}) {
      const project = { id: randomUUID(), companyId, name, urlKey, status: 'in_progress', archivedAt: archived ? tick() : null };
      projects.push(project);
      return project;
    },
    addAgent({ name, role = 'engineer', title = null, status = 'idle', pauseReason = null } = {}) {
      const agent = { id: `agent-${agents.length + 1}`, companyId, name, role, title, status, urlKey: name.toLowerCase().replace(/\W+/g, '-'), pauseReason, pausedAt: pauseReason ? tick() : null, lastHeartbeatAt: null };
      agents.push(agent);
      return agent;
    },
    // A comment from the board user, an agent (default), the system, or an agent posting under the local board user.
    addComment(issueId, { body, authorType = 'agent', authorAgentId, authorUserId, derivedAuthorAgentId = null, deletedAt = null } = {}) {
      const issue = getIssue(issueId);
      const comment = {
        id: randomUUID(),
        companyId,
        issueId: issue.id,
        authorAgentId: authorAgentId !== undefined ? authorAgentId : authorType === 'agent' ? 'agent-1' : null,
        authorUserId: authorUserId !== undefined ? authorUserId : authorType === 'user' ? 'board-user-1' : null,
        derivedAuthorAgentId,
        authorType,
        body,
        createdAt: tick(),
        updatedAt: tick(),
        deletedAt,
      };
      comments.push(comment);
      // A new comment counts as an update of its issue, so update polls see it.
      issue.updatedAt = tick();
      return comment;
    },
    // A pending approval; `issueId` links it to a task the way the issue-approval link does.
    addApproval({ type = 'hire_agent', payload = {}, requestedByAgentId = 'agent-1', requestedByUserId = null, issueId = null, status = 'pending' } = {}) {
      const now = tick();
      const approval = { id: randomUUID(), companyId, type, requestedByAgentId, requestedByUserId, status, payload, decisionNote: null, decidedByUserId: null, decidedAt: null, createdAt: now, updatedAt: now };
      approvals.set(approval.id, approval);
      if (issueId) approvalIssues.set(approval.id, issueId);
      return approval;
    },
    // An open decision; options default to one plain button-able choice.
    addDecision({ issueId, title = 'Pick a path', body = 'Which way should we go?', options, inputs = null, originAgentId = 'agent-1' } = {}) {
      const now = tick();
      const decision = {
        id: randomUUID(),
        companyId,
        bundleId: null,
        originAgentId,
        originIssueId: issueId,
        originRunId: randomUUID(),
        ruleKey: null,
        title,
        body,
        options: options ?? [{ id: 'go', label: 'Go ahead', effects: [] }, { id: 'hold', label: 'Hold', effects: [] }],
        inputs,
        status: 'open',
        executionStatus: null,
        chosenOptionId: null,
        inputValues: null,
        decidedByUserId: null,
        decidedAt: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        idempotencyKey: null,
        createdAt: now,
        updatedAt: now,
      };
      decisions.set(decision.id, decision);
      return decision;
    },
    // Marks an in-review issue as needing the owner's review; `stalled` makes it the in-place kind.
    addReview(issueId, { stalled = false } = {}) {
      reviews.set(getIssue(issueId).id, { stalled });
    },
    // `owner` is the blocked issue itself; `terminal` is the issue at the end of a blocker chain.
    addBlocker(issueId, { variant = 'owner', blockedIssueId = null, whyNow = 'Provide the missing access key.' } = {}) {
      const issue = getIssue(issueId);
      const blocked = blockedIssueId ? getIssue(blockedIssueId) : null;
      const entry = {
        active: true,
        item: {
          sourceKind: 'blocker_attention',
          dedupKey: variant === 'owner' ? `blocked-owner:${issue.id}:${tick()}` : `blocker:${issue.id}`,
          subject: issueSummary(issue),
          whyNow,
          inlineResolvable: false,
          severity: 'high',
          activityAt: tick(),
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          relatedIssue: variant === 'owner' || !blocked ? null : issueSummary(blocked),
          detail: { kind: 'blocker', blockingIssue: null, images: [] },
        },
      };
      staticItems.push(entry);
      return { close: () => { entry.active = false; } };
    },
    addRecovery(sourceIssueId, { nextAction = 'Decide how to recover this task' } = {}) {
      const issue = getIssue(sourceIssueId);
      const id = randomUUID();
      const entry = {
        active: true,
        item: {
          sourceKind: 'recovery_action',
          dedupKey: `recovery:stranded:${issue.id}:cause:${id}`,
          subject: { kind: 'recovery_action', id, companyId, title: nextAction, identifier: null, status: 'active', href: `/${prefix}/issues/${issue.identifier}`, metadata: { kind: 'stranded', cause: 'cause', ownerType: 'board', sourceIssueId: issue.id, recoveryIssueId: null } },
          whyNow: 'Recovery action is assigned to a human owner.',
          inlineResolvable: false,
          severity: 'medium',
          activityAt: tick(),
          createdAt: tick(),
          updatedAt: tick(),
          relatedIssue: issueSummary(issue),
        },
      };
      staticItems.push(entry);
      return { close: () => { entry.active = false; } };
    },
    addJoinRequest({ name = 'New agent' } = {}) {
      const id = randomUUID();
      const entry = {
        active: true,
        item: {
          sourceKind: 'join_request',
          dedupKey: `join:${id}`,
          subject: { kind: 'join_request', id, companyId, title: name, identifier: null, status: 'pending_approval', href: `/${prefix}/settings/access`, metadata: { requestType: 'agent', requestingUserId: null, adapterType: 'process' } },
          whyNow: 'Join request is pending approval.',
          inlineResolvable: true,
          severity: 'medium',
          activityAt: tick(),
          createdAt: tick(),
          updatedAt: tick(),
        },
      };
      staticItems.push(entry);
      return { close: () => { entry.active = false; } };
    },
    // The owner dismisses an item in the Paperclip UI: it stays in the feed with an active dismissal.
    dismissAttention(dedupKey) {
      dismissed.add(dedupKey);
    },
    // A run row; a running one with an issue holds that issue's execution lock.
    addRun({ agentId = 'agent-1', issueId = null, status = 'running', source = 'timer', errorCode = null } = {}) {
      const agent = agents.find((a) => a.id === agentId);
      const now = tick();
      const run = {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: source,
        status,
        startedAt: status === 'queued' ? null : now,
        finishedAt: RUN_ACTIVE.includes(status) ? null : now,
        errorCode,
        createdAt: now,
        updatedAt: now,
      };
      runs.push(run);
      if (agent) agent.lastHeartbeatAt = now;
      if (status === 'running' && issueId) Object.assign(getIssue(issueId), { executionRunId: run.id, executionAgentNameKey: agent?.name.trim().toLowerCase() ?? null, executionLockedAt: now });
      return run;
    },
    addDocument(issueId, { key = 'plan', title = 'Plan', body = '' } = {}) {
      const now = tick();
      const doc = { id: randomUUID(), companyId, issueId: getIssue(issueId).id, key, title, format: 'markdown', body, latestRevisionNumber: 1, createdAt: now, updatedAt: now };
      documents.push(doc);
      return doc;
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
