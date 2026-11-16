// The local board sentinel is the user id agents post under when they use the owner's credentials.
const NON_HUMAN_USER_ID = 'local-board';

export function authorAgentId(comment) {
  return comment.authorAgentId ?? comment.derivedAuthorAgentId ?? null;
}

// True for a comment written by the board user (the owner), false for agents and the system.
export function isBoardComment(comment) {
  return comment.authorType === 'user' && !authorAgentId(comment) && comment.authorUserId !== NON_HUMAN_USER_ID;
}

// True for a comment an agent wrote.
export function isAgentComment(comment) {
  return comment.authorType === 'agent' || (!comment.authorType && Boolean(comment.authorAgentId));
}

export async function authorName(bot, comment) {
  const agentId = authorAgentId(comment);
  if (agentId) return (await bot.agentName(agentId)) ?? 'An agent';
  if (comment.authorType === 'system') return 'System';
  return isBoardComment(comment) ? 'You' : 'An agent';
}
