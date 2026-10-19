import { button, cardUrl, escapeHtml, fitMessage, link, taskButton, truncate } from './format.js';

export const MAX_CHECKBOX_OPTIONS = 30;
export const MAX_FORM_QUESTIONS = 20;
const MAX_BUTTONS = 90;
const ALERT_MAX = 190;

// Progressively smaller text budgets used until the message fits the Telegram limit.
const LEVELS = [
  { title: 100, prompt: 1000, details: 800, preview: 600, question: 200, answer: 200 },
  { title: 80, prompt: 500, details: 300, preview: 300, question: 100, answer: 100 },
  { title: 60, prompt: 200, details: 0, preview: 0, question: 50, answer: 50 },
  { title: 50, prompt: 0, details: 0, preview: 0, question: 0, answer: 0 },
];

const ICONS = {
  request_confirmation: '🔔',
  request_checkbox_confirmation: '☑️',
  ask_user_questions: '❓',
  request_item_verdicts: '🧾',
  suggest_tasks: '📝',
};

const KIND_LABELS = {
  request_item_verdicts: 'Verdicts requested',
  suggest_tasks: 'Task suggestions',
  connection_intent: 'Connection request',
};

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanOptions(options) {
  return (Array.isArray(options) ? options : []).map((option) => ({ id: option.id, label: String(option.label ?? option.id) }));
}

// Questions come from the canonical question set when present, else the legacy list.
function normalizeQuestions(payload) {
  const set = payload.questionSet;
  if (set && Array.isArray(set.questions) && set.questions.length > 0) {
    return set.questions.map((q) => ({
      id: q.id,
      header: text(q.header),
      prompt: String(q.prompt ?? ''),
      required: q.required === true,
      mode: q.answerMode === 'text' ? 'text' : q.answerMode === 'multi_select' ? 'multi' : 'single',
      options: q.answerMode === 'text' ? [] : cleanOptions(q.options),
    }));
  }
  if (!Array.isArray(payload.questions)) return null;
  return payload.questions.map((q) => {
    const all = Array.isArray(q.options) ? q.options : [];
    const choices = all.filter((option) => !option.freeText);
    const writtenOnly = choices.length === 0 && all.some((option) => option.freeText);
    return {
      id: q.id,
      header: null,
      prompt: String(q.prompt ?? ''),
      required: q.required === true,
      mode: writtenOnly ? 'text' : q.selectionMode === 'multi' ? 'multi' : 'single',
      options: writtenOnly ? [] : cleanOptions(choices),
    };
  });
}

function describeOther(interaction) {
  const payload = interaction.payload ?? {};
  const label = KIND_LABELS[interaction.kind] ?? 'Request';
  let list = [];
  if (interaction.kind === 'request_item_verdicts') list = (payload.items ?? []).map((item) => item.label);
  if (interaction.kind === 'suggest_tasks') list = (payload.tasks ?? []).map((task) => task.title);
  const shown = list.slice(0, 8).map((entry) => `• ${truncate(String(entry ?? ''), 100)}`);
  const more = list.length > 8 ? [`+${list.length - 8} more`] : [];
  return { label, details: [...shown, ...more].join('\n') || null };
}

export function buildCard({ interaction, issue, key }) {
  const payload = interaction.payload ?? {};
  const card = {
    key,
    interactionId: interaction.id,
    issueId: issue.id,
    identifier: issue.identifier,
    issueTitle: issue.title,
    kind: interaction.kind,
    mode: 'text',
    status: 'pending',
    messageId: null,
    resolvedAt: null,
    resolution: null,
    policy: interaction.effectiveResolverPolicy ?? null,
    cardTitle: text(interaction.title),
    prompt: text(payload.prompt) ?? text(interaction.summary),
    details: text(payload.detailsMarkdown),
    toolAction: null,
    note: null,
    reasonPromptMessageId: null,
  };
  const confirm = () => ({
    acceptLabel: text(payload.acceptLabel) ?? 'Confirm',
    rejectLabel: text(payload.rejectLabel) ?? 'Decline',
    requiresReason: payload.rejectRequiresReason === true,
    reasonLabel: text(payload.rejectReasonLabel),
  });

  if (interaction.kind === 'request_confirmation') {
    card.mode = 'confirm';
    card.confirm = confirm();
    if (payload.toolAction) {
      card.toolAction = {
        name: text(payload.toolAction.toolDisplayName),
        risk: text(payload.toolAction.risk),
        preview: text(payload.toolAction.previewMarkdown),
      };
    }
    return card;
  }

  if (interaction.kind === 'request_checkbox_confirmation') {
    const options = cleanOptions(payload.options);
    if (options.length === 0 || options.length > MAX_CHECKBOX_OPTIONS) {
      card.note = `${options.length} options: answer in Paperclip.`;
      return card;
    }
    const defaults = new Set(payload.defaultSelectedOptionIds ?? []);
    card.mode = 'checkbox';
    card.confirm = confirm();
    card.options = options;
    card.selected = options.map((option) => defaults.has(option.id));
    card.min = payload.minSelected ?? 0;
    card.max = payload.maxSelected ?? null;
    return card;
  }

  if (interaction.kind === 'ask_user_questions') {
    const questions = normalizeQuestions(payload);
    card.cardTitle = text(payload.questionSet?.title) ?? text(payload.title) ?? card.cardTitle;
    card.details = text(payload.questionSet?.description);
    const buttons = (questions ?? []).reduce((sum, q) => sum + q.options.length, 1);
    if (!questions || questions.length === 0 || questions.length > MAX_FORM_QUESTIONS || buttons > MAX_BUTTONS) {
      card.note = `${questions?.length ?? 0} questions: answer in Paperclip.`;
      return card;
    }
    card.mode = 'form';
    card.questions = questions;
    card.answers = questions.map(() => ({ sel: [], text: null }));
    card.submitLabel = text(payload.submitLabel) ?? text(payload.questionSet?.submitLabel) ?? 'Submit';
    return card;
  }

  const other = describeOther(interaction);
  card.cardTitle = card.cardTitle ?? other.label;
  card.details = other.details ?? card.details;
  return card;
}

export function isInstantForm(card) {
  return card.mode === 'form' && card.questions.length === 1 && card.questions[0].mode !== 'multi';
}

function questionLabel(q) {
  return truncate(q.header ?? q.prompt, 100);
}

function composeText(card, uiBaseUrl, level) {
  const lines = [];
  const icon = ICONS[card.kind] ?? '📌';
  lines.push(`${icon} <b>${escapeHtml(card.identifier)}</b> ${escapeHtml(truncate(card.issueTitle, level.title))}`);
  if (level.prompt > 0) {
    if (card.cardTitle && card.cardTitle !== card.prompt) lines.push(`<b>${escapeHtml(truncate(card.cardTitle, 200))}</b>`);
    if (card.prompt) lines.push(escapeHtml(truncate(card.prompt, level.prompt)));
    if (card.details && level.details > 0) lines.push('', escapeHtml(truncate(card.details, level.details)));
    if (card.toolAction) {
      const head = [card.toolAction.name, card.toolAction.risk ? `risk: ${card.toolAction.risk}` : null].filter(Boolean).join(' · ');
      if (head) lines.push('', `<b>${escapeHtml(truncate(head, 200))}</b>`);
      if (card.toolAction.preview && level.preview > 0) lines.push(escapeHtml(truncate(card.toolAction.preview, level.preview)));
    }
    if (card.note) lines.push('', escapeHtml(card.note));
    if (card.mode === 'form' && level.question > 0) {
      lines.push('');
      card.questions.forEach((q, index) => {
        lines.push(`${index + 1}. ${escapeHtml(truncate(q.prompt, level.question))}${q.required ? ' *' : ''}`);
        const answer = card.answers[index];
        let shown = '—';
        if (q.mode === 'text' && answer.text) shown = `“${truncate(answer.text, level.answer)}”`;
        else if (q.mode !== 'text' && answer.sel.length > 0) {
          shown = answer.sel.map((i) => truncate(q.options[i].label, 60)).join(', ');
        }
        lines.push(`   ▸ ${escapeHtml(shown)}`);
      });
      if (card.status === 'pending' && openTextQuestion(card) >= 0) lines.push('', '↩ Reply to this message to answer the text question.');
    }
    if (card.reasonPromptMessageId && card.status === 'pending') lines.push('', 'Waiting for the decline reason (reply to the prompt below).');
  }
  lines.push('', link(cardUrl(uiBaseUrl, card.identifier, card.interactionId), 'Open in Paperclip'));
  if (card.resolution) lines.push('', escapeHtml(card.resolution));
  return lines.join('\n');
}

function answerRows(card) {
  const k = card.key;
  if (card.mode === 'confirm') {
    return [[button(card.confirm.acceptLabel, `${k}:a`), button(card.confirm.rejectLabel, `${k}:d`)]];
  }
  if (card.mode === 'checkbox') {
    const rows = card.options.map((option, i) => [button(`${card.selected[i] ? '☑' : '☐'} ${option.label}`, `${k}:t:${i}`)]);
    rows.push([button(card.confirm.acceptLabel, `${k}:a`), button(card.confirm.rejectLabel, `${k}:d`)]);
    return rows;
  }
  if (card.mode === 'form') {
    const rows = [];
    card.questions.forEach((q, qi) => {
      q.options.forEach((option, oi) => {
        const on = card.answers[qi].sel.includes(oi);
        const mark = q.mode === 'multi' ? (on ? '☑' : '☐') : on ? '◉' : '○';
        const prefix = card.questions.length > 1 ? `${qi + 1}. ` : '';
        rows.push([button(`${prefix}${mark} ${option.label}`, `${k}:o:${qi}:${oi}`)]);
      });
    });
    if (!isInstantForm(card)) rows.push([button(card.submitLabel, `${k}:s`)]);
    return rows;
  }
  return [];
}

// Pending cards get the answer buttons plus a button that opens the task.
function keyboardFor(card) {
  if (card.status !== 'pending') return [];
  return [...answerRows(card), [taskButton(card.issueId)]];
}

export function renderCard(card, uiBaseUrl) {
  const html = fitMessage((level) => composeText(card, uiBaseUrl, level), LEVELS);
  return { text: html, keyboard: keyboardFor(card) };
}

export function parseCallback(data) {
  const [key, op, ...rest] = String(data ?? '').split(':');
  if (!key || !op) return null;
  const args = rest.map(Number);
  if (args.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return { key, op, args };
}

const countOn = (flags) => flags.filter(Boolean).length;

export function toggleCheckbox(card, index) {
  if (!card.options[index]) return { alert: 'Unknown option' };
  if (!card.selected[index] && card.max != null && countOn(card.selected) >= card.max) {
    return { alert: `Select at most ${card.max}` };
  }
  card.selected[index] = !card.selected[index];
  return {};
}

export function checkboxAcceptBody(card) {
  const count = countOn(card.selected);
  if (count < card.min) return { alert: `Select at least ${card.min}` };
  if (card.max != null && count > card.max) return { alert: `Select at most ${card.max}` };
  return { body: { selectedOptionIds: card.options.filter((_, i) => card.selected[i]).map((option) => option.id) } };
}

export function chooseOption(card, qIndex, oIndex) {
  const q = card.questions[qIndex];
  if (!q || q.mode === 'text' || !q.options[oIndex]) return { alert: 'Unknown option' };
  const answer = card.answers[qIndex];
  if (q.mode === 'multi') {
    answer.sel = answer.sel.includes(oIndex) ? answer.sel.filter((i) => i !== oIndex) : [...answer.sel, oIndex].sort((a, b) => a - b);
  } else if (isInstantForm(card)) {
    answer.sel = [oIndex];
  } else {
    answer.sel = answer.sel.includes(oIndex) ? [] : [oIndex];
  }
  return { submit: isInstantForm(card) };
}

// Index of the first text question that has no answer yet, or -1.
export function openTextQuestion(card) {
  if (card.mode !== 'form') return -1;
  return card.questions.findIndex((q, i) => q.mode === 'text' && !card.answers[i].text);
}

export function setTextAnswer(card, value) {
  const index = openTextQuestion(card);
  if (index < 0) return -1;
  card.answers[index].text = value;
  return index;
}

function isAnswered(q, answer) {
  return q.mode === 'text' ? Boolean(answer.text) : answer.sel.length > 0;
}

// Builds the respond body; otherText is only ever the text the owner typed.
export function formRespondBody(card) {
  const missing = card.questions.findIndex((q, i) => q.required && !isAnswered(q, card.answers[i]));
  if (missing >= 0) return { alert: truncate(`Answer the required question first: ${questionLabel(card.questions[missing])}`, ALERT_MAX) };
  const answers = [];
  card.questions.forEach((q, i) => {
    const answer = card.answers[i];
    if (!isAnswered(q, answer)) return;
    if (q.mode === 'text') answers.push({ questionId: q.id, optionIds: [], otherText: answer.text });
    else answers.push({ questionId: q.id, optionIds: answer.sel.map((oi) => q.options[oi].id) });
  });
  return { body: { answers } };
}

export function resolveCard(card, line, nowIso) {
  card.status = 'resolved';
  card.resolvedAt = nowIso;
  card.resolution = line;
}

// The closing line for a card whose interaction was settled elsewhere.
export function lineForInteraction(interaction) {
  if (interaction.status === 'accepted') return '✅ Confirmed in Paperclip';
  if (interaction.status === 'rejected') return '❌ Declined in Paperclip';
  if (interaction.status === 'answered') return '✅ Answered in Paperclip';
  return 'Closed in Paperclip';
}
