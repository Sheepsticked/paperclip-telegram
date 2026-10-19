// The messages that may make a sound, told by their first line: questions, items the owner must act on,
// a failed run, a finished task and a rejected token. Every other message is sent silently.
const KIND = /^<b>(?:<a [^>]*>)?(Question|Approval|Decision|Blocked|Recovery|Join request|Run failed|Done)(?:<\/a>)?<\/b>/;
const TOKEN_ALERT = /^<b>(?:<a [^>]*>)?Token rejected(?:<\/a>)?<\/b>/;
// The summary of many changes: it may make a sound only when it counts a finished task.
const SUMMARY_WITH_DONE = /^<b>(?:<a [^>]*>)?[1-9]\d* done(?:<\/a>)?<\/b>, \d+ in review since the last check/;

// A review only makes a sound when it is stalled, which shows as its Request changes button.
const stalledReview = (entry) => /^<b>(?:<a [^>]*>)?Review(?:<\/a>)?<\/b>/.test(entry.text) && JSON.stringify(entry.markup ?? {}).includes('Request changes');

export const isAlertKind = (entry) => KIND.test(entry.text) || TOKEN_ALERT.test(entry.text) || SUMMARY_WITH_DONE.test(entry.text) || stalledReview(entry);

// The first line of each loud message that is not an alert kind.
export const unexpectedLoud = (entries) => entries.filter((entry) => !isAlertKind(entry)).map((entry) => entry.text.split('\n')[0]);

// The first bold word of an alert as it is sent to a group.
export const mentioned = (word, ownerId) => `<b><a href="tg://user?id=${ownerId}">${word}</a></b>`;

// The text of a group alert without its owner mention, for tests that check the rest of the layout.
export const unmentioned = (text) => text.replace(/<a href="tg:\/\/user\?id=\d+">([^<]*)<\/a>/, '$1');

const MENTION = /tg:\/\/user\?id=/g;

// In a group, a message that makes a sound carries exactly one mention of the owner, on its first bold word;
// a silent message and an edit carry none. `calls` are the recorded Telegram calls.
export function mentionProblems(calls, ownerId) {
  const head = new RegExp(`^<b><a href="tg://user\\?id=${ownerId}">[^<]+</a></b>`);
  const problems = [];
  for (const { method, params } of calls) {
    const isSend = method === 'sendMessage' || method === 'sendRichMessage';
    if ((!isSend && method !== 'editMessageText') || params.chat_id === ownerId) continue;
    const text = String(params.text ?? params.rich_message?.markdown ?? '');
    const count = (text.match(MENTION) ?? []).length;
    const loud = isSend && params.disable_notification !== true;
    const first = text.split('\n')[0];
    if (loud && !(count === 1 && head.test(text))) problems.push(`a message with a sound needs one mention on its first bold word: ${first}`);
    if (!loud && count > 0) problems.push(`${isSend ? 'a silent message' : 'an edit'} mentions the owner: ${first}`);
  }
  return problems;
}
