import { button, escapeHtml, truncate } from './format.js';
import { isRefused } from './guard.js';
import { TelegramError } from './telegram.js';

// The icons a project takes by default, in this order, when they are in Telegram's set and no other project uses them.
// File folder, laptop, memo, light bulb, high voltage, fire, books, direct hit, microscope, bar chart, package, puzzle piece.
const PREFERRED = ['\u{1F4C1}', '\u{1F4BB}', '\u{1F4DD}', '\u{1F4A1}', '\u26A1', '\u{1F525}', '\u{1F4DA}', '\u{1F3AF}', '\u{1F52C}', '\u{1F4CA}', '\u{1F4E6}', '\u{1F9E9}'];
const RETRY_MS = 60 * 60 * 1000;
const PER_ROW = 8;
const PER_PAGE = 48;

// Telegram writes some emoji with the variation selector U+FE0F and some without.
const plain = (emoji) => String(emoji ?? '').replaceAll('\uFE0F', '');

// Telegram's topic icons as { id, emoji }. They are read when topics come on; after a failure a later call tries again
// at most once an hour. Until the list is there it is empty, and topics are made without icons.
export async function iconList(bot) {
  const icons = bot.icons;
  if (icons.list) return icons.list;
  if (icons.triedAt !== null && bot.now() - icons.triedAt < RETRY_MS) return [];
  icons.triedAt = bot.now();
  try {
    const stickers = await bot.tg.getForumTopicIconStickers();
    icons.list = stickers
      .filter((sticker) => typeof sticker?.custom_emoji_id === 'string' && sticker.custom_emoji_id !== '')
      .map((sticker) => ({ id: sticker.custom_emoji_id, emoji: String(sticker.emoji ?? '') }));
  } catch (err) {
    bot.log.warn('could not read the topic icons, topics are made without icons', { error: err.message });
    return [];
  }
  return icons.list;
}

// The icon id of a project's topics, "" for none. A project that has no icon yet takes the first preferred
// one that nobody else uses; none left means no icon. Nothing is remembered while the icon list is missing.
export async function projectIcon(bot, projectId) {
  if (!projectId) return '';
  const { projectIcons } = bot.state;
  if (projectIcons.has(projectId)) return projectIcons.get(projectId);
  const list = await iconList(bot);
  if (list.length === 0) return '';
  const taken = new Set(projectIcons.values());
  const free = (emoji) => list.find((icon) => plain(icon.emoji) === emoji && !taken.has(icon.id));
  const chosen = PREFERRED.map((emoji) => free(plain(emoji))).find(Boolean);
  projectIcons.set(projectId, chosen?.id ?? '');
  bot.state.save();
  return chosen?.id ?? '';
}

// A button that shows the topic icon itself; Telegram allows that only when the bot owner has Premium. The text is one
// non-breaking space, so only the icon shows. Without Premium the button carries the emoji as its label.
const BLANK = '\u00a0';
function iconButton(bot, icon, data, style) {
  const base = button(icon.emoji, data, style);
  return bot.icons.plainLabels ? base : { ...base, text: BLANK, icon_custom_emoji_id: icon.id };
}

// The picker for one project: the icons as buttons, 8 to a row and 48 to a page, then No icon and Back.
// `filter` is the task list the picker was opened from; Back and a pick return to it. Null while there are no icons.
async function iconPickerView(bot, project, filter, page) {
  const list = await iconList(bot);
  if (list.length === 0) return null;
  const current = await projectIcon(bot, project.id);
  const pages = Math.ceil(list.length / PER_PAGE);
  const at = Math.min(Math.max(page, 0), pages - 1);
  const rows = [];
  list.slice(at * PER_PAGE, (at + 1) * PER_PAGE).forEach((icon, offset) => {
    if (offset % PER_ROW === 0) rows.push([]);
    rows.at(-1).push(iconButton(bot, icon, `L:s:${filter}:${at * PER_PAGE + offset}:${project.id}`, icon.id === current ? 'primary' : undefined));
  });
  const nav = [];
  if (at > 0) nav.push(button('◀', `L:i:${filter}:${at - 1}:${project.id}`));
  if (at < pages - 1) nav.push(button('▶', `L:i:${filter}:${at + 1}:${project.id}`));
  if (nav.length > 0) rows.push(nav);
  rows.push([button('No icon', `L:s:${filter}:n:${project.id}`, current === '' ? 'primary' : undefined), button('Back', `L:t:${filter}:0:${project.id}`)]);
  return { text: `<b>Icon</b> · ${escapeHtml(truncate(project.name, 60))}`, keyboard: rows };
}

const notModified = (err) => err instanceof TelegramError && err.code === 400 && /not modified/i.test(err.description);

function drawPicker(bot, messageId, view) {
  return bot.tg
    .editMessageText({
      chat_id: bot.config.telegramChatId,
      message_id: messageId,
      text: view.text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: view.keyboard },
    })
    .catch((err) => {
      if (!notModified(err)) throw err;
    });
}

// Shows one page of the picker in a message; false while there are no icons. The buttons first carry the icons themselves.
// When Telegram refuses that keyboard but accepts the same grid with emoji labels, labels are used until the bot restarts.
export async function showIconPicker(bot, messageId, project, filter, page) {
  const view = await iconPickerView(bot, project, filter, page);
  if (!view) return false;
  try {
    await drawPicker(bot, messageId, view);
  } catch (err) {
    if (bot.icons.plainLabels || !isRefused(err)) throw err;
    bot.icons.plainLabels = true;
    try {
      await drawPicker(bot, messageId, (await iconPickerView(bot, project, filter, page)) ?? view);
    } catch (again) {
      bot.icons.plainLabels = false;
      throw again;
    }
    bot.log.info('icon picker: Telegram refused buttons with icons, so they carry emoji labels until the bot restarts');
    return true;
  }
  if (!bot.icons.plainLabels && !bot.icons.iconsLogged) {
    bot.icons.iconsLogged = true;
    bot.log.info('icon picker: buttons show the topic icons');
  }
  return true;
}

// The icon a picker button stands for: its index in the list, or "n" for no icon. Null for anything else.
export async function pickedIcon(bot, arg) {
  if (arg === 'n') return '';
  const list = await iconList(bot);
  const index = /^\d+$/.test(arg ?? '') ? Number(arg) : -1;
  return list[index]?.id ?? null;
}
