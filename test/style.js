// Symbols the bot may use; every other emoji is a style violation.
export const ALLOWED_SYMBOLS = ['✓', '◀', '▶', '·'];

// The ballot boxes are listed on top of the pictographs, since the bot shows choices with a colour and a check mark instead.
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u2610-\u2612]|️|⃣/gu;

// The emoji in `text` that are not on the allowed list.
export function findEmoji(text) {
  return (String(text ?? '').match(PICTOGRAPH) ?? []).filter((ch) => !ALLOWED_SYMBOLS.includes(ch));
}
