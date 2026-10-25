export class TooBigError extends Error {}

// Reads a response body into one buffer; throws TooBigError as soon as it passes `maxBytes`.
export async function readCapped(body, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (maxBytes !== undefined && size > maxBytes) throw new TooBigError('body is too big');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
