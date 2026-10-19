# paperclip-telegram

A small Telegram bot for following and answering [Paperclip](https://github.com/paperclipai/paperclip) agents from a phone.

It watches a Paperclip company and sends you:

- a card for every question an agent asks you (confirmations, checkbox lists and question forms), with buttons you can tap;
- a message when a task becomes **done** or **in review**, with the last agent comment;
- an alert when an agent run fails.

It also turns your Telegram replies into Paperclip comments and answers, and lets you create tasks (`/new`) and see what is going on (`/status`).

The bot makes no AI calls. It has no runtime dependencies and needs Node.js 22 or newer. It polls Paperclip (default every 15 seconds) and uses Telegram long polling, so it needs no public address.

## Setup

All commands below are for `bash`. Nothing here puts a token in your shell history or on the screen.

### 1. Create the bot with BotFather

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a name and a username (it must end in `bot`).
3. BotFather replies with a token that looks like `123456789:AA…`. Keep that chat open for the next step.

### 2. Save the Telegram token

```bash
mkdir -p ~/.config/paperclip-telegram && chmod 700 ~/.config/paperclip-telegram
(umask 077; read -rsp 'Bot token: ' token && printf '%s\n' "$token" > ~/.config/paperclip-telegram/telegram-token; echo)
test -s ~/.config/paperclip-telegram/telegram-token && echo saved
```

`read -s` does not echo what you paste, the token is never part of a command line, and the file is created with mode 600. The bot refuses to start if a token file is readable by group or others, is empty, or is not a regular file.

### 3. Find your Telegram user id

Open a chat with your new bot and send it any message. Then, before the service is running, ask Telegram for the pending updates. The `--config` file keeps the token out of the process list and the shell history:

```bash
curl -s --config <(printf 'url = "https://api.telegram.org/bot%s/getUpdates"\n' "$(cat ~/.config/paperclip-telegram/telegram-token)") \
  | jq '.result[].message.from.id' | sort -u
```

The number is your user id. In a private chat the chat id is the same number. If the call answers with a conflict error, a webhook is set for this bot: use a fresh bot or remove the webhook first (the bot never removes it for you).

### 4. Create a Paperclip board key

The key lets the bot read the attention feed and answer cards as you. Create it without printing it:

```bash
(umask 077; paperclipai token board create --name telegram-bot --never-expires --json | jq -er .key.token > ~/.config/paperclip-telegram/paperclip-token)
test -s ~/.config/paperclip-telegram/paperclip-token && grep -q '^pcp_board_' ~/.config/paperclip-telegram/paperclip-token && echo saved
```

If the last line does not print `saved`, the key was not created; remove the file and try again.

### 5. Write the config

```bash
cp config.example.json ~/.config/paperclip-telegram/config.json
chmod 600 ~/.config/paperclip-telegram/config.json
```

Edit it:

| Key | Meaning |
| --- | --- |
| `paperclipUrl` | API address of the Paperclip server, reachable from this machine. |
| `uiBaseUrl` | Address you open Paperclip at in a browser. Used for the links in messages (`<uiBaseUrl>/<PREFIX>/issues/<ID>`). |
| `companyId` | The company to watch. |
| `leadAgentId` | The agent that gets tasks created with `/new`. |
| `newTaskProjectId` | Project for `/new` tasks, or `null` for none. |
| `telegramUserId` | Your Telegram user id from step 3. Only this user is served. |
| `telegramChatId` | Chat the bot writes to. Optional; defaults to `telegramUserId`. |
| `telegramTokenFile`, `paperclipTokenFile` | Paths of the two token files. `~/` is expanded. |
| `telegramApiUrl` | Optional, defaults to `https://api.telegram.org`. |
| `pollSeconds` | Optional, seconds between Paperclip polls (default 15). |
| `routineRunErrorCodes` | Optional. Failed runs with one of these error codes do not raise an alert (the defaults are in `config.example.json`). |

The bot reads `$PAPERCLIP_TELEGRAM_CONFIG`, or `~/.config/paperclip-telegram/config.json` when that is not set. A missing or invalid config, or a bad token file, makes it exit with status 78 and a message that names the problem (never the token).

### 6. Install and start the service

```bash
scripts/install-service.sh
systemctl --user daemon-reload
systemctl --user enable --now paperclip-telegram
loginctl enable-linger "$USER"    # keep the user service running when you are logged out
```

The script writes `~/.config/systemd/user/paperclip-telegram.service` for this checkout and the `node` found on your `PATH`, and creates the state directory. State (the update offset, sent cards, seen statuses) is kept in `$STATE_DIRECTORY/state.json`, which systemd sets to `~/.local/state/paperclip-telegram`.

### 7. Check it

```bash
systemctl --user status paperclip-telegram
journalctl --user -u paperclip-telegram -n 50 --no-pager
```

A healthy start logs `started`. Send `/status` to the bot; it should answer. After changing the config or a token file:

```bash
systemctl --user restart paperclip-telegram
```

If the unit stopped with status 78, it is a configuration problem and systemd does not restart it. Read the message in the journal, fix the file, and start it again with `systemctl --user start paperclip-telegram`.

If Paperclip rejects the key (HTTP 401), the log says so and the bot sends one Telegram alert per hour at most. Create a new key (step 4) and restart.

## What you see and what the buttons do

### Cards

A card is sent when an agent asks you something in a task thread. Every card has an **Open in Paperclip** link to the exact card.

| Card | Buttons |
| --- | --- |
| 🔔 Confirmation | The accept and decline labels set by the agent. If a decline needs a reason, the bot asks you to reply to a prompt message and sends your reply as the reason. |
| ☑️ Checkbox list (up to 30 options) | One button per option to tick or untick, then accept or decline. The minimum and maximum selection are enforced before anything is sent. |
| ❓ Questions (up to 20 questions) | One button per option. A form with a single choice question is submitted by tapping the option. Other forms have a **Submit** button. For a text question, reply to the card message with your answer. Required questions must be answered first. |
| Anything else, or a card too large | Text and the link only. Answer it in Paperclip. |

When a card is answered, in the bot or in Paperclip, its message loses the buttons and gets a closing line (confirmed, declined, answered or closed). Tapping an old button gives a short note ("Already answered or closed") instead of failing. If Paperclip cannot be reached the tap answers "Paperclip unreachable, try again" and the card stays open.

### Updates

| Message | Meaning |
| --- | --- |
| ✅ **Done** | A task changed to `done`, with the last agent comment (5 lines at most) and a link. |
| 👀 **In review** | A task changed to `in_review`. Not sent when a card for the same task was just sent or is still waiting. |
| ⚠️ **Run failed** | A run failed. One alert per run. Runs that end for routine reasons (cancelled, paused, and so on) are skipped. |
| `+N more, see /status` | More than 10 cards were waiting when the bot first started. |
| `N done, M in review while the bot was offline` | More than 10 tasks changed in one poll. |

On the very first start the bot sends the cards that are waiting (at most 10) and nothing else: older done and in-review tasks and old failed runs are not reported.

### Commands

| Command | What it does |
| --- | --- |
| `/new <text>` | Creates a task assigned to the lead agent. The first line is the title (100 characters at most), the whole text is the description. Sending the same message twice does not create a second task. |
| `/status` | Lists what is running and what waits for you (open cards and tasks in review), 15 lines per section. |
| `/help`, `/start` | Show the command list. |

### Replies

Reply to any message the bot sent about a task and your text becomes a comment on that task ("💬 Posted on …"). A reply to a card with an open text question answers the question instead, and a reply to a decline prompt is the decline reason. The bot remembers the last 2000 messages; for an older or unrelated message it answers "I don't know which task this is". Only text replies are supported.

## Security

- Only the configured user, in the configured chat, is served. Every other update is dropped silently: one log line without content and no Paperclip call.
- The bot sends messages only to the configured chat.
- Token files must be regular files with mode 600 (or stricter). Tokens are never logged; URLs and errors are wrapped so they cannot leak one.
- Paperclip requests use the board key as a bearer token and carry no run id, so your replies are recorded as yours.

## Development

```bash
npm test
```

The tests run the real bot against fake Telegram and Paperclip servers on random local ports; nothing leaves the machine. `npm start` runs the bot in the foreground with the same config and token files.
