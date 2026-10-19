// Topics and buttons carry no custom icon. The one call that may name an icon is an edit that sets an empty icon
// without renaming the topic, which takes an old icon off.
const KEY = 'icon_custom_emoji_id';

// What `calls` (the recorded Telegram calls) did with icons that it should not have.
export function iconProblems(calls) {
  const problems = [];
  for (const { method, params } of calls) {
    if (method === 'getForumTopicIconStickers') problems.push('the bot read the list of topic icons');
    const mentions = JSON.stringify(params).split(`"${KEY}"`).length - 1;
    const removal = method === 'editForumTopic' && params[KEY] === '' && params.name === undefined;
    if (mentions > (removal ? 1 : 0)) problems.push(`${method} carries ${KEY}`);
  }
  return problems;
}
