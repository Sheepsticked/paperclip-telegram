# paperclip-telegram

A small Telegram bot that works as a phone remote for [Paperclip](https://github.com/paperclipai/paperclip): follow your agents, answer them, and open, change and create tasks.

It watches a Paperclip company and sends you:

- a card for every question an agent asks you (confirmations, checkbox lists and question forms), with buttons you can tap;
- a message for everything else that waits for you in the Paperclip attention feed: approvals, decisions, stalled reviews, blocked tasks, recovery actions and join requests (see [Inbox items](#inbox-items));
- a message when a task becomes **done** or **in review**, with the last agent comment;
- an alert when an agent run fails;
- the new comments of the tasks you follow.

From the chat you can open any task and act on it (finish, reopen, cancel, comment, assign, set the project, read its documents, stop its run), list and search tasks and projects, create tasks (also from a photo, a file or a voice note), pause, resume and run agents, and choose which notifications you get. Your Telegram replies become Paperclip comments and answers, and the photos and files you send are attached to tasks.

The bot works in a private chat, or in a group with topics where every top-level task gets its own topic (see [Group with topics](#group-with-topics)). Its messages use one plain style: no emoji, a bold kind and the task on the first line, and the task id on that line is the link to Paperclip.

The bot makes no AI calls. Voice notes are turned into text on this machine, with no cloud service (see [Voice notes](#voice-notes)). It has no runtime dependencies and needs Node.js 22 or newer. It polls Paperclip (default every 15 seconds) and uses Telegram long polling, so it needs no public address.

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

The number is your user id. In a private chat the chat id is the same number. To use a group instead, see [Group with topics](#group-with-topics). If the call answers with a conflict error, a webhook is set for this bot or another program is polling it: use a fresh bot or remove the webhook first (the bot never removes it for you).

### 4. Create a Paperclip board key

The key lets the bot read the attention feed and answer cards as you. Create it without printing it:

```bash
(umask 077; paperclipai token board create --name telegram-bot --never-expires --json | jq -er .key.token > ~/.config/paperclip-telegram/paperclip-token)
test -s ~/.config/paperclip-telegram/paperclip-token && grep -q '^pcp_board_' ~/.config/paperclip-telegram/paperclip-token && echo saved
```

If the last line does not print `saved`, the key was not created; remove the file and try again. If `paperclipai token board create` says you are not logged in, run `paperclipai auth login` first.

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
| `leadAgentId` | The agent that gets tasks created with `/new` and from plain text. |
| `newTaskProjectId` | Default project for new tasks, or `null` for none. `/new #project` overrides it. |
| `telegramUserId` | Your Telegram user id from step 3. Only this user is served. |
| `telegramChatId` | Chat the bot writes to. Optional; defaults to `telegramUserId`. For a group with topics, the group id (a negative number). |
| `topics` | Optional, `"auto"` (default) or `"off"`. With `"auto"` topics are used when the chat is a forum group where the bot is an admin who may manage topics; `"off"` keeps everything in one chat. |
| `closedTopicDays` | Optional, default `7`. Topics of finished tasks are deleted this many days after they were closed; `0` keeps them for ever. See [Finished topics](#finished-topics). |
| `richMessages` | Optional, `"auto"` (default) or `"off"`. With `"auto"` messages that hold Paperclip Markdown are sent as Telegram rich messages; `"off"` sends only plain messages. See [Rich messages](#rich-messages). |
| `telegramTokenFile`, `paperclipTokenFile` | Paths of the two token files. `~/` is expanded. |
| `telegramApiUrl` | Optional, defaults to `https://api.telegram.org`. |
| `pollSeconds` | Optional, seconds between Paperclip polls (default 15). |
| `voice` | Optional. Turns voice notes on: the Python of the voice setup and the folder of its model, plus a few settings. Without it a voice note gets "Voice notes are not set up on this machine." See [Voice notes](#voice-notes). |
| `routineRunErrorCodes` | Optional. Failed runs with one of these error codes do not raise an alert (the defaults are in `config.example.json`). |

The bot reads `$PAPERCLIP_TELEGRAM_CONFIG`, or `~/.config/paperclip-telegram/config.json` when that is not set. A missing or invalid config, or a bad token file, makes it exit with status 78 and a message that names the problem (never the token).

### 6. Install and start the service

```bash
scripts/install-service.sh
systemctl --user daemon-reload
systemctl --user enable --now paperclip-telegram
loginctl enable-linger "$USER"    # keep the user service running when you are logged out
```

The script writes `~/.config/systemd/user/paperclip-telegram.service` for this checkout and the `node` found on your `PATH`, and creates the state directory. State (the update offset, sent cards and inbox items, seen statuses, settings, followed tasks) is kept in `$STATE_DIRECTORY/state.json`, which systemd sets to `~/.local/state/paperclip-telegram` with mode 700. The state directory mode is part of the unit file: after updating the checkout, run `scripts/install-service.sh` and `systemctl --user daemon-reload` again.

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

If the log shows `Telegram 409`, a webhook is set for the bot or another copy of it is polling; use a separate bot or remove the webhook.

If Paperclip rejects the key (HTTP 401), the log says so and the bot sends one Telegram alert per hour at most. Create a new key (step 4) and restart.

## What you see and what the buttons do

Line 1 of a task message is `Kind · ID Title` with the kind in bold and the id linked to the task (or, for a card or inbox item, to that card or item) in Paperclip. Inside the task's own topic line 1 is only the kind, and the pinned task view there links the task. A message without a task links its title instead (or ends with an **Open in Paperclip** link when it has no title), and the run-failed alert links to the agent's name. A comment's kind is the agent's name. There is no separate link line.

Quoted text (the last agent comment, a description) is cut at 2000 characters with `…` and is folded in Telegram when it is longer than 3 lines or 300 characters. With rich messages (the default, see below) a comment is cut at 4000 characters.

### Rich messages

With `richMessages: "auto"` the messages that hold Paperclip Markdown are sent as Telegram rich messages (Bot API 10.1), so bold text, lists, tables, code and links show as their author wrote them: followed comments, the comment quoted in done and in-review messages, the description and last comment in the task view, the prompt and details of a card, the text of a decision and the documents of a task. Command replies, lists, the board, pickers and short notices stay plain messages.

Line 1 is the same as in a plain message. The text below it is a quote when it has up to 3 lines and 300 characters, else it is folded under its first line (plain, up to 80 characters); a text that starts with a code block, table or list is folded under **Show all**. Links to Paperclip are made absolute, `agent://` links show only their text, images become links and raw HTML is shown as text. A text over its limit is cut at a line, an open code block is closed and the cut ends with a **Full text in Paperclip** link. In comments, card texts and decision texts a single line break stays a line break, as Paperclip shows it; in descriptions and documents it stays a space, as in Markdown.

A message sent as a rich message is edited as one. A document is one rich message, or several split at headings (at most three; the last one ends with the link when more was left or a line was too long for one message and its end was dropped).

When Telegram refuses a rich message, or the edit of one, for a reason other than a missing topic, missing rights or an edit that changes nothing, the plain message is sent or edited instead and the log warns (at most once an hour). After three refusals in a row the bot sends plain messages until it is restarted. `"off"` sends plain messages only.

Buttons have one or two words. Some have a colour: green for accept, confirm, approve, submit and **Done**; red for decline, reject, pause, **Stop run** and **Cancel task**; blue for the chosen option or filter. All others are plain. A destructive button needs a second tap within 30 seconds. Messages about a task inside its own topic have no buttons, except cards and inbox items with answer buttons; elsewhere they have **Open task**.

### Cards

A card is sent when an agent asks you something in a task thread. Line 1 is `Question` and the id links to the exact card.

| Card | Buttons |
| --- | --- |
| Confirmation | The accept (green) and decline (red) labels set by the agent. If a decline needs a reason, the bot asks you to reply to a prompt message and sends your reply as the reason. |
| Checkbox list (up to 30 options) | One button per option; a chosen option reads `✓ label` and is blue. Then accept and decline. The minimum and maximum selection are enforced before anything is sent. |
| Questions (up to 20 questions) | One button per option, with the question number in front (`1 · Yes`) when there is more than one question. A form with a single choice question is submitted by tapping the option. Other forms have a green **Submit** button. For a text question, reply to the card message with your answer. Questions that may stay empty say `(optional)`; the others must be answered first. An `Answer:` line shows once a question has an answer. |
| Item verdicts, task suggestions, connection requests, any other kind, or a card too large | Text and the link only. Answer it in Paperclip. |

When a card is answered, in the bot or in Paperclip, its message keeps its text, loses the buttons and ends with an outcome line (see [Settled messages](#settled-messages)). Tapping an old button gives a short note ("Already answered or closed") instead of failing. If Paperclip cannot be reached the tap answers "Paperclip unreachable, try again" and the card stays open.

### Inbox items

Everything else in the attention feed that waits for you gets one message: the kind and the task on line 1, the title, the reason it needs you, and an **Open task** button when it belongs to a task and the message is not in that task's own topic. The task id (or the title, for an item without a task) links to the item in Paperclip. These messages are always sent; the toggles and the mute do not stop them.

| Kind | Message | Buttons |
| --- | --- | --- |
| Approval | The approval type, who asked and the payload as `key: value` lines (800 characters at most). | **Approve** and **Reject** when Paperclip allows answering the approval inline; each needs a second tap within 30 seconds ("Tap again to confirm"). Other approvals (for example a board approval) are text and a link: answer them in Paperclip. |
| Decision | The decision text (800 characters at most). The options are listed when they have descriptions or when the decision needs input. | One button per option, and **Dismiss**. A decision that asks for input values has no option buttons and no **Dismiss**; the message says "More options in Paperclip". An option marked destructive needs a second tap. |
| Review | A review that Paperclip marks as stalled (nobody is set to move it on). | **Approve**, **Request changes** and **Send back**. Approve and Send back each need a second tap within 30 seconds. Request changes asks you to reply to a prompt; your reply is the note. A review that is not stalled is text and **Open task**, and it is left out when a card, an approval message or an in-review message about the same task was sent, as long as the task stays in review. |
| Blocked, Recovery, Join request | Text and the reason. | **Open task** when there is a task; answer it in Paperclip. |

When an item leaves the feed (answered here or in Paperclip, or dismissed in Paperclip), its message keeps its text, loses its buttons and ends with an outcome line (see [Settled messages](#settled-messages)). A tap on an old button answers "Already resolved". An item about a task in a topic goes to that topic; the others go to the main chat.

### Settled messages

When the bot settles a message in place (a card is answered or closed, an inbox item is resolved, a task offer is created, cancelled or expires, a voice note is sent or cancelled), it edits the message instead of sending a new one: the text stays as it was, the buttons go, and the last block is a highlighted line that says what happened, with which answer, and when. The line is a quote in a plain message and marked text in a rich message. Its parts, separated by `·`:

| Part | Content |
| --- | --- |
| Kind (bold) | Card: `Confirmed`, `Declined` or `Answered`; with `in Paperclip` added when it was settled there; `Closed` when the card ended without an answer. Inbox item: `Approved`, `Rejected`, `Decided`, `Dismissed`, `Changes requested`, `Sent back`, or `Resolved in Paperclip` when it was settled elsewhere. Offer: `Created`, `Cancelled` or `Expired`. |
| Detail | The accept or decline label, unless it only repeats the kind (`Confirm`, `Yes`, `OK`, `Decline`, `No`); the decline reason (200 characters at most); for a card with one question, the picked answers, joined with commas (120 characters at most; a written answer is not shown), and the card no longer shows them under the question; a card with several questions keeps each answer under its question, and its line has no detail; for a card closed without an answer, why (`replaced by a comment`, `expired`, `task closed`); for a decision, the chosen option; for a created task, its id as a link, then who it is for and the project. |
| Time | When it was settled (for a card settled in Paperclip, the time Paperclip recorded), as a Telegram date-time entity that clients show relative to now ("2 minutes ago"). Clients that do not know the entity show the UTC time. |

A settled message keeps the text it had; when a very long card has no room left for the whole line, the detail is dropped first. Live views (the task view, the board, lists, pickers, settings and a button waiting for its second tap) have no outcome line. A message saved by an older version with a plain closing line shows that line highlighted, without a time.

### Updates

| Message | Meaning |
| --- | --- |
| **Done** | A task changed to `done`. It quotes the last agent comment, unless a message in this chat already showed that comment. |
| **In review** | A task changed to `in_review`, with the same quote rule as **Done**. Not sent when a card for the same task was just sent or is still waiting. |
| **Run failed** | A run failed; the agent's name links to the run. One alert per run. Runs that end for routine reasons (cancelled, paused, and so on) are skipped. |
| The agent's name | A new comment from an agent on a task you follow (see below). |
| `+N more, see /status` | More than 10 cards and inbox items were waiting when the bot first started, after an upgrade that added new kinds of inbox items, or after `telegramChatId` changed. The extra ones are not sent later; `/status` lists them. |
| `N done, M in review since the last check, see /status` | More than 10 tasks changed in one poll (for example after the bot was stopped for a while). |

Every message about one task (cards, done, in review, run failed, followed comments, the reply to `/new`) has an **Open task** button that opens the task view, except in the task's own topic, where the pinned task view is already at hand. A subtask's messages in its parent's topic keep the button.

On the very first start the bot sends the cards and inbox items that are waiting (at most 10 together) and nothing else: older done and in-review tasks and old failed runs are not reported. When an upgrade adds inbox items, the first poll sends at most 10 of them (approvals, decisions and stalled reviews first) and marks the rest as seen; a review of a task that was already in review is not sent.

### Task view

`/task <ID>` (for example `/task ABC-12`, any case; `/task 12` uses the company prefix seen most) sends the task. Line 1 is the id (linked to Paperclip) and the title. Line 2 is the status, the assignee (with `running` while a run is active), the project, when it was last updated, and `high priority` or `critical priority` when it is one of those. Then come the description (300 characters) and, in the main chat only, the last comment (200 characters) as a preview; a followed task still sends that comment in full. In the task's own topic the view has no comments, because the topic already holds them. The message is edited in place after every action.

The first row has **Done** (green, needs a second tap within 30 seconds) and **More**. While the task has an active run, **Stop run** (red, also two taps; it cancels that run) comes before **More**. A done or cancelled task has **Reopen** (blue, sets the status to to do) instead of **Done**.

**More** replaces the buttons with these rows, leaving out the ones that do not apply; after any action the first row is shown again. Opening **More**, a picker or **Docs** cancels a pending second tap, and **Back** shows the first row without one.

| Button | What it does |
| --- | --- |
| Assign | Shows the agents; tap one to assign the task to it. |
| Project | Shows the projects (8 per page) and "No project". |
| To do | Sets the status to to do. Only shown when it changes the status. |
| Cancel task | Cancels the task (red). Needs a second tap within 30 seconds (the label says "Tap again to confirm"). |
| Docs | Shown when the task has documents. Turns the buttons into a list of the documents (title and key) with **Back**; tapping one sends it as a rich message, split at headings into at most three messages when it is long (with `richMessages: "off"` as plain text in at most three messages). A longer document ends with a link to the full text in Paperclip. Documents are read-only. |
| Follow, Unfollow | Starts or stops following the task. Not shown in the task's own topic, where the task is already followed. |
| Comment | Asks for a reply; your reply becomes a comment. A plain reply to the task message works too. Not shown in the task's own topic, where plain text is a comment. |
| Refresh | Reads the task again. |
| ◀ Back | Returns to the first row. |

If Paperclip refuses a change, its error text is shown as an alert and the view stays as it was.

### Finding tasks

- `/tasks` lists the open tasks (to do, in progress, in review, blocked), most recently updated first, 10 per page with ◀ ▶ and a filter row on two lines (All open, Running, Review, Blocked, Done; the chosen one is blue). The Done tab lists finished tasks, newest first. Each task is a button that opens the task view.
- `/find <text>` searches tasks (10 results at most).
- `/status` shows what is running and what waits for you (cards and every kind of inbox item), as buttons: the task view when the item has a task, otherwise the item's message again.
- `/following` lists the tasks you follow.
- `/projects` lists the projects with their open tasks (see [Projects](#projects)).
- `/agents` lists the agents (see [Agents](#agents)).

### Agents

`/agents` lists every agent as a button with its status and the number of tasks it has in progress. A button opens the agent view: name, title or role, status (with the pause reason when paused), the last run and when it ended, and the tasks in progress as buttons.

| Button | What it does |
| --- | --- |
| Pause (stops its current run) | Red. Needs a second tap within 30 seconds. Pauses the agent, which stops its current run. |
| Resume | Resumes a paused agent. |
| Run now | Starts a run for the agent. |
| Refresh | Reads the agent again. |

The bot cannot terminate agents or change their configuration, budget or team.

### Projects

`/projects` lists the projects as buttons with their number of open tasks, most recently active first, 10 per page. A button opens the list of open tasks limited to that project; the filter row keeps the project, and **All projects** drops it.

When no default project is set in the config and there is a project to pick, `/new` without `#project` and the plain-text offer ask "Which project?" before the task is created: the projects, most recently active first (8 per page), **No project** and **Cancel**. `/new #project ...` skips the question. The waiting text is kept for 24 hours, like an offer.

### Photos and files

Send a photo or a file as a reply to a bot message about a task, or inside the task's topic, and the bot attaches it to the task: it uploads the file, posts a comment that carries it (your caption, or `Attachment: <file name>`) and replies `Attached to ID`. Telegram lets a bot download up to 20 MB and Paperclip accepts up to 10 MB; a file over a limit is refused with a message. Telegram compresses photos, so send a file to keep the original.

Sent on its own, a file with a caption offers "Create a task from this?" with the caption as the text, and the file is attached once the task exists. Without a caption the bot asks for one, or for a reply to a task message. Each photo or file of an album is handled by itself.

### Voice notes

Send a voice note instead of typing. The bot turns it into text on this machine with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (the `small` model, on the CPU), shows you the text it heard and uses it only after you confirm. The audio never leaves the machine and no API key is involved.

Where you send the note decides what happens, as for typed text:

- **In General** (or anywhere the bot would offer a task for typed text): the bot replies `Transcribing…` and then edits that reply into the task offer: `Heard:`, the text in a quote, then `Create a task from this?` with the usual buttons. The task is created from the text.
- **In a task topic, or as a reply to a bot message**: the reply becomes **Heard**, the text in a quote, and the buttons **Send** (green) and **Cancel** (red). **Send** handles the text exactly as if you had typed it there: a reply to a card's text question answers it, a reply to a decline prompt is the reason, a reply to a note prompt of a stalled review is the note, and anything else is a comment on the task. If Paperclip refuses it, the buttons stay and you can tap **Send** again. **Cancel** does nothing else.

A settled message keeps the text and ends with the outcome line `Sent`, `Cancelled` or `Expired` (see [Settled messages](#settled-messages)); a transcript that waited 24 hours expires. The comment or answer is the text only, with no marker. A long text is folded in an expandable quote; if the message would pass Telegram's length limit the shown text is cut with `…`, and **Send** still uses all of it. The text is HTML-escaped.

A note without speech gets `No speech heard.`, and one that could not be transcribed (or took more than four times its length, at least a minute) gets `Could not transcribe this voice note.`; the log tells why, but never holds the text. A note longer than `voice.maxSeconds` is refused with `Voice notes can be up to 5 minutes long.` without being downloaded. The `Transcribing…` job is saved in the state file, so a restart picks it up again. Notes are transcribed one at a time, apart from the rest of the bot, so buttons keep working meanwhile. All these messages are silent.

Setup, once:

```bash
scripts/install-voice.sh
```

The script is safe to run again. It creates a Python virtual environment in `${XDG_DATA_HOME:-~/.local/share}/paperclip-telegram/voice` with `faster-whisper==1.2.1` and `av>=15,<16` (PyAV 16 and later break that faster-whisper), downloads the `small` model into its `models` folder (plan for about 1 GB of disk for the environment and the model together), and prints the `voice` block for the config. It needs `python3` with the `venv` module (`python3-venv` on Debian and Ubuntu) and a network connection for the one-time download. Add the block to the config and restart the service.

| `voice` key | Meaning |
| --- | --- |
| `python` | The Python of the virtual environment (`<venv>/bin/python`). `~/` is expanded. |
| `modelsDir` | The folder the model was downloaded to (`<venv>/models`). |
| `model` | Optional, default `small`. The installer only fetches `small`. |
| `language` | Optional, default `null`: the language is detected for every note. A code such as `"en"` fixes it. |
| `beamSize` | Optional, default `1` (fastest). |
| `threads` | Optional, default `4`. CPU threads for one transcription. |
| `maxSeconds` | Optional, default `300`. The longest note that is accepted. |

The bot starts `scripts/transcribe.py` with `nice -n 10`, without a shell, for each note: the audio goes into a private temporary folder that is removed afterwards, the helper is killed when it runs too long or the bot stops, and it never uses the network at run time (`HF_HUB_OFFLINE=1`). You can run it by hand: `<venv>/bin/python scripts/transcribe.py note.ogg --models-dir <venv>/models` prints one JSON line with `text`, `language` and `seconds` (the time the transcription took). How long that is depends on the CPU.

### Following

Each new comment of a followed task is one message: the agent's name in bold as the kind (and the task, outside its own topic), then the comment as a quote of up to 4000 characters (2000 as a plain message). Your own comments are not sent. Every comment is said once: the bot remembers the last 500 comment ids it showed (in follow messages and in done and in-review quotes; a task view does not count), and a comment in that memory is not sent or quoted again, in the same poll or a later one. The memory is kept across restarts and cleared when `telegramChatId` changes. More than five new comments on one task arrive as one summary line. A task stops being followed when it is done or cancelled. At most 50 tasks are followed; following one more drops the oldest. Tasks you create from Telegram are followed by default (the **Follow new tasks** setting), and so are tasks that have a topic. The **Followed comments** setting decides whether their comments are sent.

### Settings and mute

`/settings` has a toggle for each kind of message (done, in review, failed run, followed comments) and for following the tasks you create, plus **Mute 1 h**, **Mute 8 h** and **Unmute**. A toggle reads `Done messages · On` (green) or `Done messages · Off`. While muted, those messages are not sent; when the mute ends, one line says how many were hidden. Cards that need an answer and inbox items are always sent.

Only what needs you makes a sound: cards, approvals, decisions, stalled reviews, blocked tasks, recovery items, join requests, a failed run, **Done** of a top-level task and a rejected Paperclip token. The summary line for many changes makes a sound only when it counts a finished top-level task. Everything else is delivered silently: agent comments, **In review**, **Done** of a subtask, task views, replies to your commands and lists. The mute and the toggles above decide what is sent at all; they do not change the sound.

To get a pop-up only when you are needed, mute the group in Telegram.
Every message that makes a sound mentions you: its bold first word (for example **Question**, **Done** or **Run failed**) links to your profile, and Telegram still notifies a muted chat about mentions of you.
Everything else only raises the unread count.
A private chat gets no mention.

### Commands

| Command | What it does |
| --- | --- |
| `/new [@agent] [#project] <text>` | Creates a task. The first line is the title (100 characters at most), the whole text is the description. `@agent` is an agent's URL key or name without spaces; `#project` is a project's URL key or name. The default is the lead agent and `newTaskProjectId`. Without `#project` (and without a default project) it first asks which project. An unknown name gets a reply that lists the valid ones, and nothing is created. Sending the same message twice does not create a second task. |
| plain text | Offers "Create a task from this?" with **For \<lead>**, **Other agent** and **Cancel**, then asks for the project. An offer expires after 24 hours. In a task topic, plain text is a comment instead. |
| voice note | Turns it into text on this machine and shows it before it is used: an offer for a new task in General, **Send** and **Cancel** in a task topic or as a reply. See [Voice notes](#voice-notes). |
| photo or file | Attaches it to the task of the message it replies to, or of the topic it is written in. With a caption and no task it offers a new task. See [Photos and files](#photos-and-files). |
| `/task <ID>` | Opens a task. In a task topic, without an ID, it opens that topic's task. |
| `/tasks` | Lists open tasks. |
| `/find <text>` | Searches tasks. |
| `/status` | Lists what is running and what waits for you (open cards, inbox items and tasks in review), 15 buttons per section. |
| `/following` | Lists the followed tasks. |
| `/agents` | Lists the agents; a button opens the agent view. |
| `/projects` | Lists the projects with their open tasks. |
| `/settings` | Notification toggles and mute. |
| `/help`, `/start` | Show the command list. |

The same commands are in the Telegram menu. The bot also sets its profile text (short description and description) once at start.

### Replies

Reply to any message the bot sent about a task (including the task view and inbox items) and your text becomes a comment on that task. With topics on, the bot reacts to your message with a thumbs-up; otherwise it answers `Comment posted · ID`. A reply to a card with an open text question answers the question instead, a reply to a decline prompt is the decline reason, and a reply to the note prompt of a stalled review is its note. The bot remembers the last 2000 messages; for an older or unrelated message it answers "I don't know which task this is". A photo or file as a reply is attached to the task (see [Photos and files](#photos-and-files)); a voice note as a reply is turned into text first and used after you tap **Send** (see [Voice notes](#voice-notes)); other message types are not supported.

## Group with topics

A forum group gives every top-level task its own topic, so each task is a separate conversation and the chat stays tidy. Subtasks do not get topics: their messages go to the topic of the top-level task they belong to, and their id and title are on line 1.

### Setup

1. In Telegram, create a group and add yourself. In the group settings turn on **Topics**; the group becomes a forum.
2. If Telegram does not let you add the bot to a group, open [@BotFather](https://t.me/BotFather), send `/setjoingroups`, pick your bot and choose **Enable**.
3. Add the bot to the group, open the group's administrators and make the bot an admin. Give it **Manage topics**, **Pin messages** and **Delete messages** and nothing else. Admin bots receive every message in the group, so the privacy mode setting does not matter. **Pin messages** is for the task views and the board, **Delete messages** only for removing finished topics (see [Finished topics](#finished-topics)).
4. Write any message in the group. The bot ignores it, and logs the group id once:

   ```bash
   journalctl --user -u paperclip-telegram -n 50 --no-pager | grep 'ignored an update from chat'
   ```

   The line is `ignored an update from chat -100... (supergroup)`. The negative number is the group id. Nothing else about the message is logged.
5. Put that number in `telegramChatId` in the config, keep `telegramUserId` as it is, and restart:

   ```bash
   systemctl --user restart paperclip-telegram
   ```

6. The first log lines after the start say `topics on`, or `topics off: <reason>` (not a forum, the bot is not an admin, the bot lacks the Manage topics right, off in the config, or the chat cannot be read). Without **Pin messages** topics still work; the task views and the board are just not pinned, and one warning is logged. Without **Delete messages** finished topics are kept, and one warning is logged.

Only the configured user in the configured chat is served. Updates from any other chat are ignored.

When `telegramChatId` changes, the bot logs `chat changed` and forgets the message ids of the old chat, because ids restart in every chat. The old messages are left as they are. Open cards and inbox items are sent to the new chat (at most 10, then a `+N more` line). Settings and followed tasks are kept.

### How topics work

- A topic is made the first time the bot has something to say about a top-level task (a card, a done or in-review message, a comment on a followed task), or when you create a task from Telegram. Its name is `ID Title` (128 characters at most) and its colour depends on the project. The first message is the task view, pinned without a notification.
- A task with a topic is followed, so its new agent comments appear there.
- When the task is done or cancelled the topic is closed; its name stays as it is. When the task is open again the topic is reopened (a name that an older version suffixed with `(done)` or `(cancelled)` is restored).
- Plain text you write in a task topic is a comment on that task, and the bot reacts to it with a thumbs-up. If Paperclip refuses it, the bot replies with the error. A reply to a bot message about a subtask is a comment on that subtask. `/task` without an ID shows the topic's task.
- Plain text in a topic that has no task yet offers "Create a task from this?" in the same topic. Creating the task renames the topic, links it and pins the task view; **Cancel** links nothing.
- Commands such as `/status`, `/tasks`, `/agents` and `/settings` are answered in the topic they were sent from. The mute summary, token alerts and anything not about one task go to General.
- Finished topics are deleted after a while (see [Finished topics](#finished-topics)).
- If you delete a topic, the bot makes a new one the next time it has something to say about that task. If a topic cannot be created, the message goes to General and one warning an hour is logged.
- With `"topics": "off"`, or in a chat that is not a forum, the bot behaves as in a private chat: everything goes to the one chat.

### The board

With topics on, one message in General is kept up to date and pinned: what needs you, what is running and what waits for review. It has up to three sections, each left out when empty:

- **Needs you** (n): the cards and inbox items that `/status` shows under "Waiting for you".
- **Working** (n): tasks in progress, each followed by the agent's name.
- **In review** (n): tasks in review that are not already under Needs you.

When all three are empty the board says `Nothing waiting or running.` Each line is the task id and as much of its title as fits one line. The whole line is a link to the topic of the task's top-level task, or to the task in Paperclip when it has no topic. A section shows 10 lines and then `+N more`. The board is built at the end of every poll and edited only when its text changed. It never makes a sound, never mentions you and has no buttons. If you delete it, the next change sends a new one. Without **Pin messages** it is sent but not pinned.

### Finished topics

When a task is done or cancelled its topic is closed, and the bot notes the time. After `closedTopicDays` days (default 7) the topic is deleted with everything in it, and the bot forgets it, together with offers made in it. Reopening a task before that clears the time. The check runs once an hour. `closedTopicDays: 0` never deletes.

Deleting needs the **Delete messages** right. Without it the bot keeps the topics, tries again at every check and logs `the bot lacks the Delete messages right, so finished topics are kept` at most once an hour. A task whose topic was deleted gets a new topic the next time the bot has something to say about it. General, and topics that are not linked to a task, are never deleted.

## Security

- Only the configured user, in the configured chat, is served. Every other update is dropped: a log line without content and no Paperclip call. The first update from another chat logs its id and type once, so you can find a group id.
- Service messages (a topic created or renamed, a member added, a message pinned) and the bot's own messages are dropped without a log line. Messages from other bots are ignored.
- The bot sends messages only to the configured chat.
- Token files must be regular files with mode 600 (or stricter). Tokens are never logged; URLs and errors are wrapped so they cannot leak one.
- Paperclip requests use the board key as a bearer token and carry no run id, so your replies and task changes are recorded as yours.
- The download address of a Telegram file contains the bot token, so it is never logged, shown or put in an error message.
- Voice notes are transcribed on this machine. The audio is written to a private temporary folder (mode 700) that is removed afterwards, and the helper reads the model from disk and does not use the network. The log holds the length, language and time of a transcription, never the text.

## Development

```bash
npm test
```

The tests run the real bot against fake Telegram and Paperclip servers on random local ports; nothing leaves the machine. Voice notes are tested with a small Node script (`test/fakes/transcriber.mjs`) that stands in for `scripts/transcribe.py`, so no model is needed. `npm start` runs the bot in the foreground with the same config and token files.
