# paperclip-telegram

A small Telegram bot that works as a phone remote for [Paperclip](https://github.com/paperclipai/paperclip): follow your agents, answer them, and open, change and create tasks.

It watches a Paperclip company and sends you:

- a card for every question an agent asks you (confirmations, checkbox lists and question forms), with buttons you can tap;
- a message for everything else that waits for you in the Paperclip attention feed: approvals, decisions, stalled reviews, blocked tasks, recovery actions and join requests (see [Inbox items](#inbox-items));
- a message when a task becomes **done** or **in review**, with the last agent comment;
- an alert when an agent run fails;
- the new comments of the tasks you follow.

From the chat you can open any task and act on it (finish, reopen, cancel, comment, assign, set the project, read its documents, stop its run), list and search tasks and projects, create tasks (also from a photo or file), pause, resume and run agents, and choose which notifications you get. Your Telegram replies become Paperclip comments and answers, and the photos and files you send are attached to tasks.

The bot works in a private chat, or in a group with topics where every top-level task gets its own topic (see [Group with topics](#group-with-topics)). Its messages use one plain style: no emoji, a bold kind and the task on the first line, and the link `Open in Paperclip` on the last.

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

Line 1 of every task message is `Kind · ID Title` with the kind in bold. Inside the task's own topic the title is left out and the id stays. The last line is the link **Open in Paperclip**. Buttons have one or two words.

### Cards

A card is sent when an agent asks you something in a task thread. Every card has an **Open in Paperclip** link to the exact card.

| Kind | Card | Buttons |
| --- | --- | --- |
| Approval | Confirmation | The accept and decline labels set by the agent. If a decline needs a reason, the bot asks you to reply to a prompt message and sends your reply as the reason. |
| Decision | Checkbox list (up to 30 options) | One button per option to tick (`☑`) or untick (`☐`), then accept or decline. The minimum and maximum selection are enforced before anything is sent. |
| Question | Questions (up to 20 questions) | One button per option. A form with a single choice question is submitted by tapping the option. Other forms have a **Submit** button. For a text question, reply to the card message with your answer. Required questions must be answered first. |
| Review, Decision, Approval | Item verdicts, task suggestions, connection requests, any other kind, or a card too large | Text and the link only. Answer it in Paperclip. |

When a card is answered, in the bot or in Paperclip, its message loses the buttons and gets a closing line (`Confirmed`, `Declined`, `Answered`, or `... in Paperclip`). Tapping an old button gives a short note ("Already answered or closed") instead of failing. If Paperclip cannot be reached the tap answers "Paperclip unreachable, try again" and the card stays open.

### Inbox items

Everything else in the attention feed that waits for you gets one message: the kind and the task on line 1, the title, the reason it needs you, an **Open task** button when it belongs to a task, and a link to the item in Paperclip. These messages are always sent; the toggles and the mute do not stop them.

| Kind | Message | Buttons |
| --- | --- | --- |
| Approval | The approval type, who asked and the payload as `key: value` lines (800 characters at most). | **Approve** and **Reject** when Paperclip allows answering the approval inline; each needs a second tap within 30 seconds ("Tap again to confirm"). Other approvals (for example a board approval) are text and a link: answer them in Paperclip. |
| Decision | The decision text (800 characters at most). The options are listed when they have descriptions or when the decision needs input. | One button per option, and **Dismiss**. A decision that asks for input values has no option buttons; the message says "More options in Paperclip". An option marked destructive needs a second tap. |
| Review | A review that Paperclip marks as stalled (nobody is set to move it on). | **Approve**, **Request changes** and **Send back**. Request changes asks you to reply to a prompt; your reply is the note. A review that is not stalled is text, a link and **Open task**, and it is left out when an in-review message, a card or an approval message about the same task was just sent. |
| Blocked, Recovery, Join request | Text and the reason. | **Open task** when there is a task; answer it in Paperclip. |

When an item leaves the feed (answered here or in Paperclip, or dismissed in Paperclip), its message is edited to end with `Resolved` and loses its buttons. A tap on an old button answers "Already resolved". An item about a task in a topic goes to that topic; the others go to the main chat.

### Updates

| Message | Meaning |
| --- | --- |
| **Done** | A task changed to `done`, with the last agent comment (5 lines at most) and a link. |
| **In review** | A task changed to `in_review`. Not sent when a card for the same task was just sent or is still waiting. |
| **Run failed** | A run failed. One alert per run. Runs that end for routine reasons (cancelled, paused, and so on) are skipped. |
| **Comment** | A new comment from an agent on a task you follow (see below). |
| `+N more, see /status` | More than 10 cards and inbox items were waiting when the bot first started. The extra ones are not sent later; `/status` lists them. |
| `N done, M in review since the last check, see /status` | More than 10 tasks changed in one poll (for example after the bot was stopped for a while). |

Every message about one task (cards, done, in review, run failed, followed comments, the reply to `/new`) has an **Open task** button that opens the task view.

On the very first start the bot sends the cards and inbox items that are waiting (at most 10 together) and nothing else: older done and in-review tasks and old failed runs are not reported.

### Task view

`/task <ID>` (for example `/task ABC-12`, any case; `/task 12` uses the company prefix seen most) sends the task: status, who is running it right now (the `Running` line, only while a run is active), assignee, project, priority, when it was last updated, the description (300 characters), the last three comments and a link. The message is edited in place after every action.

| Button | What it does |
| --- | --- |
| Comment | Asks for a reply; your reply becomes a comment. A plain reply to the task message works too. |
| Refresh | Reads the task again. |
| Done, To do, Cancel | Change the status; only the moves that change it are shown. Done and Cancel need a second tap within 30 seconds (the label says "Tap again to confirm"). To do also reopens a finished task. |
| Assign | Shows the agents; tap one to assign the task to it. |
| Project | Shows the projects (8 per page) and "No project". |
| Follow, Unfollow | Starts or stops following the task. |
| Docs | Shown when the task has documents. Turns the buttons into a list of the documents (title and key) with **Back**; tapping one sends it as plain text in at most three messages. A longer document ends with "The document continues in Paperclip" and the link. Documents are read-only. |
| Stop run | Shown when the task has an active run. Needs a second tap within 30 seconds; cancels that run. |

If Paperclip refuses a change, its error text is shown as an alert and the view stays as it was.

### Finding tasks

- `/tasks` lists the open tasks (to do, in progress, in review, blocked), most recently updated first, 10 per page with ◀ ▶ and a filter row (All open, Running, Review, Blocked; the chosen one is marked `☑`). Each task is a button that opens the task view.
- `/find <text>` searches tasks (10 results at most).
- `/status` shows what is running and what waits for you (cards and every kind of inbox item), as buttons: the task view when the item has a task, otherwise the item's message again.
- `/following` lists the tasks you follow.
- `/projects` lists the projects with their open tasks (see [Projects](#projects)).
- `/agents` lists the agents (see [Agents](#agents)).

### Agents

`/agents` lists every agent as a button with its status and the number of tasks it has in progress. A button opens the agent view: name, title or role, status (with the pause reason when paused), the last run and when it ended, and the tasks in progress as buttons.

| Button | What it does |
| --- | --- |
| Pause (stops its current run) | Needs a second tap within 30 seconds. Pauses the agent, which stops its current run. |
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

### Following

The new comments of followed tasks are sent as **Comment**, then the author and 5 lines or 400 characters of the comment. Your own comments are not sent, and a comment that a done or in-review message already quotes is not sent twice. More than five new comments on one task arrive as one summary line. A task stops being followed when it is done or cancelled. At most 50 tasks are followed; following one more drops the oldest. Tasks you create from Telegram are followed by default (the **Follow new tasks** setting), and so are tasks that have a topic. The **Followed comments** setting decides whether their comments are sent.

### Settings and mute

`/settings` has a toggle for each kind of message (done, in review, failed run, followed comments) and for following the tasks you create, plus **Mute 1 h**, **Mute 8 h** and **Unmute**. A toggle shows `☑` when on and `☐` when off. While muted, those messages are not sent; when the mute ends, one line says how many were hidden. Cards that need an answer and inbox items are always sent.

### Commands

| Command | What it does |
| --- | --- |
| `/new [@agent] [#project] <text>` | Creates a task. The first line is the title (100 characters at most), the whole text is the description. `@agent` is an agent's URL key or name without spaces; `#project` is a project's URL key or name. The default is the lead agent and `newTaskProjectId`. Without `#project` (and without a default project) it first asks which project. An unknown name gets a reply that lists the valid ones, and nothing is created. Sending the same message twice does not create a second task. |
| plain text | Offers "Create a task from this?" with **For \<lead>**, **Other agent** and **Cancel**, then asks for the project. An offer expires after 24 hours. In a task topic, plain text is a comment instead. |
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

Reply to any message the bot sent about a task (including the task view and inbox items) and your text becomes a comment on that task. With topics on, the bot reacts to your message with a thumbs-up; otherwise it answers with the lines `Comment · ID` and `Posted`. A reply to a card with an open text question answers the question instead, a reply to a decline prompt is the decline reason, and a reply to the note prompt of a stalled review is its note. The bot remembers the last 2000 messages; for an older or unrelated message it answers "I don't know which task this is". Only text replies are supported.

## Group with topics

A forum group gives every top-level task its own topic, so each task is a separate conversation and the chat stays tidy. Subtasks do not get topics: their messages go to the topic of the top-level task they belong to, and their id and title are on line 1.

### Setup

1. In Telegram, create a group and add yourself. In the group settings turn on **Topics**; the group becomes a forum.
2. If Telegram does not let you add the bot to a group, open [@BotFather](https://t.me/BotFather), send `/setjoingroups`, pick your bot and choose **Enable**.
3. Add the bot to the group, open the group's administrators and make the bot an admin. Give it **Manage topics** and **Pin messages** and nothing else. Admin bots receive every message in the group, so the privacy mode setting does not matter.
4. Write any message in the group. The bot ignores it, and logs the group id once:

   ```bash
   journalctl --user -u paperclip-telegram -n 50 --no-pager | grep 'ignored an update from chat'
   ```

   The line is `ignored an update from chat -100... (supergroup)`. The negative number is the group id. Nothing else about the message is logged.
5. Put that number in `telegramChatId` in the config, keep `telegramUserId` as it is, and restart:

   ```bash
   systemctl --user restart paperclip-telegram
   ```

6. The first log lines after the start say `topics on`, or `topics off: <reason>` (not a forum, the bot is not an admin, the bot lacks the Manage topics right, off in the config, or the chat cannot be read). Without **Pin messages** topics still work; the task views are just not pinned, and one warning is logged.

Only the configured user in the configured chat is served. Updates from any other chat are ignored.

### How topics work

- A topic is made the first time the bot has something to say about a top-level task (a card, a done or in-review message, a comment on a followed task), or when you create a task from Telegram. Its name is `ID Title` (128 characters at most) and its colour depends on the project. The first message is the task view, pinned without a notification.
- A task with a topic is followed, so its new agent comments appear there.
- When the task is done or cancelled the topic is renamed to `... (done)` or `... (cancelled)` and closed. When the task is open again the name is restored and the topic is reopened.
- Plain text you write in a task topic is a comment on that task, and the bot reacts to it with a thumbs-up. If Paperclip refuses it, the bot replies with the error. A reply to a bot message about a subtask is a comment on that subtask. `/task` without an ID shows the topic's task.
- Plain text in a topic that has no task yet offers "Create a task from this?" in the same topic. Creating the task renames the topic, links it and pins the task view; **Cancel** links nothing.
- Commands such as `/status`, `/tasks`, `/agents` and `/settings` are answered in the General topic, together with the mute summary, token alerts and anything not about one task.
- If you delete a topic, the bot makes a new one the next time it has something to say about that task. If a topic cannot be created, the message goes to General and one warning an hour is logged.
- With `"topics": "off"`, or in a chat that is not a forum, the bot behaves as in a private chat: everything goes to the one chat.

## Security

- Only the configured user, in the configured chat, is served. Every other update is dropped: a log line without content and no Paperclip call. The first update from another chat logs its id and type once, so you can find a group id.
- Service messages (a topic renamed, a member added, a message pinned) and messages from bots are ignored.
- The bot sends messages only to the configured chat.
- Token files must be regular files with mode 600 (or stricter). Tokens are never logged; URLs and errors are wrapped so they cannot leak one.
- Paperclip requests use the board key as a bearer token and carry no run id, so your replies and task changes are recorded as yours.
- The download address of a Telegram file contains the bot token, so it is never logged, shown or put in an error message.

## Development

```bash
npm test
```

The tests run the real bot against fake Telegram and Paperclip servers on random local ports; nothing leaves the machine. `npm start` runs the bot in the foreground with the same config and token files.
