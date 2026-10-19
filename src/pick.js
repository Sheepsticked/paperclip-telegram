// Pickers carry the first characters of an id in the button, so no per-button state is kept.
export const ID_PREFIX = 8;

export const byPrefix = (items, prefix) => {
  const found = items.filter((item) => item.id.startsWith(prefix));
  return found.length === 1 ? found[0] : null;
};
