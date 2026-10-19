// Symbols the bot may use; every other emoji is a style violation.
export const ALLOWED_SYMBOLS = ['☑', '☐', '◀', '▶', '·'];

const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|️|⃣/gu;

// The emoji in `text` that are not on the allowed list.
export function findEmoji(text) {
  return (String(text ?? '').match(PICTOGRAPH) ?? []).filter((ch) => !ALLOWED_SYMBOLS.includes(ch));
}
