// The messages that may make a sound, told by their first line: questions, items the owner must act on,
// a failed run, a finished task and a rejected token. Every other message is sent silently.
const KIND = /^<b>(?:<a [^>]*>)?(Question|Approval|Decision|Blocked|Recovery|Join request|Run failed|Done)(?:<\/a>)?<\/b>/;
const TOKEN_ALERT = /^Paperclip token rejected/;
// The summary of many changes: it may make a sound only when it counts a finished task.
const SUMMARY_WITH_DONE = /^[1-9]\d* done, \d+ in review since the last check/;

// A review only makes a sound when it is stalled, which shows as its Request changes button.
const stalledReview = (entry) => /^<b>(?:<a [^>]*>)?Review(?:<\/a>)?<\/b>/.test(entry.text) && JSON.stringify(entry.markup ?? {}).includes('Request changes');

export const isAlertKind = (entry) => KIND.test(entry.text) || TOKEN_ALERT.test(entry.text) || SUMMARY_WITH_DONE.test(entry.text) || stalledReview(entry);

// The first line of each loud message that is not an alert kind.
export const unexpectedLoud = (entries) => entries.filter((entry) => !isAlertKind(entry)).map((entry) => entry.text.split('\n')[0]);
