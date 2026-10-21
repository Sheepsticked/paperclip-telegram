# paperclip-telegram

[![test](https://github.com/Sheepsticked/paperclip-telegram/actions/workflows/test.yml/badge.svg)](https://github.com/Sheepsticked/paperclip-telegram/actions/workflows/test.yml)

A Telegram bot that works as a phone remote for [Paperclip](https://github.com/paperclipai/paperclip): follow your agents, answer their questions and manage tasks from your phone.

## What it does

- **Cards with buttons.** When an agent asks you something (a confirmation, a checkbox list or a form), the bot sends a card. Tap a button to answer. Approvals, decisions and stalled reviews that wait for you arrive the same way.
- **Done and failed alerts.** You get a message when a task is done or ready for review, and an alert when an agent run fails.
- **One topic per task.** In a group with Topics, every task gets its own topic with a pinned task view. A pinned board in General shows what needs you. Finished topics are deleted after a few days.
- **Task control.** Open a task to finish, reopen, cancel, comment, assign, set the project, read its documents or stop its run. Pause, resume and run agents. Create tasks from text, photos, files or voice notes.
- **Voice notes.** Send a voice note instead of typing. It is turned into text on your own machine, and the text is used only after you confirm it.
- **Model and reasoning choice.** Pick the model and reasoning level of an agent, of one task, or of a new task before you create it.
- **Works in a muted group.** Mute the group in Telegram. Only the messages that need you mention you, so only those pop up with a sound.

## How it works

The bot polls Paperclip and uses long polling for Telegram. Both connections start from the bot, so it needs no public URL and opens no port.

It signs in to Paperclip with a board key, so your replies and changes are recorded as yours. It makes no AI calls. Voice is transcribed locally with [faster-whisper](https://github.com/SYSTRAN/faster-whisper), so audio never leaves your machine.

Only one Telegram user is accepted. Every other update is dropped.

## Requirements

- A Paperclip server that the bot can reach. Tested with Paperclip 2026.1012.0.
- A Telegram account, and a bot made with [@BotFather](https://t.me/BotFather). A group with Topics is best. A private chat works too.
- Docker with the Compose plugin, or Node.js 22 or newer on a Linux machine with systemd.
- For voice: about 1 GB of disk. A GPU is not needed.
- `curl` and `jq` for the setup commands below.

## Quick start with Docker Compose

The commands are for `bash`. None of them puts a token on the screen or in your shell history. Commands marked **needs a real token** talk to Telegram or Paperclip.

1. Get the code.

   ```bash
   git clone https://github.com/Sheepsticked/paperclip-telegram.git
   cd paperclip-telegram
   ```

2. Create the bot. In Telegram open [@BotFather](https://t.me/BotFather) and send `/newbot`. Pick a name and a username that ends in `bot`. BotFather replies with a token that looks like `123456789:AA…`. Keep that chat open.

3. Create a group and turn on Topics in its settings. If Telegram does not let you add the bot to a group, send `/setjoingroups` to BotFather, pick your bot and choose **Enable**. To use a private chat instead, skip this step and the next.

4. Add the bot to the group and make it an admin with **Manage topics**, **Pin messages** and **Delete messages**, and nothing else.

5. Create a Paperclip board key and the folders for the bot. **Needs a real token.** If the CLI says you are not logged in, run `paperclipai auth login` first. Find your company id with `paperclipai company list`.

   ```bash
   mkdir -p config state && chmod 700 config state
   (umask 077; paperclipai token board create --name telegram-bot --never-expires -C <companyId> --json | jq -er .key.token > config/paperclip-token)
   test -s config/paperclip-token && grep -q '^pcp_board_' config/paperclip-token && echo saved
   ```

   If the last line does not print `saved`, remove the file and try again. Find your agent id with `paperclipai agent list -C <companyId>`.

6. Save the Telegram token and write the config. **Needs a real token.**

   ```bash
   (umask 077; read -rsp 'Bot token: ' token && printf '%s\n' "$token" > config/telegram-token; echo)
   test -s config/telegram-token && echo saved
   cp docker/config.example.json config/config.json
   chmod 600 config/config.json
   ```

   The bot refuses to start when a token file can be read by group or others. Now send any message to your new bot in a private chat and ask Telegram for your user id:

   ```bash
   curl -s --config <(printf 'url = "https://api.telegram.org/bot%s/getUpdates"\n' "$(cat config/telegram-token)") \
     | jq '.result[].message.from.id' | sort -u
   ```

   Edit `config/config.json`: set at least `paperclipUrl`, `uiBaseUrl`, `companyId`, `leadAgentId`, and `telegramUserId` and `telegramChatId` (both your user id for now). See [Configuration](#configuration). Delete the `voice` block unless you use the voice image (see below). If your Linux user id is not 1000, run `cp .env.example .env` and set `PUID` and `PGID` to the output of `id -u` and `id -g`.

7. Build and start the bot.

   ```bash
   docker compose up -d --build
   docker compose logs --no-log-prefix --tail 20 paperclip-telegram
   ```

   A healthy start logs `started`. Send `/status` to the bot; it should answer.

8. For a group, find its id. Write any message in the group. The bot ignores it and logs the group id once:

   ```bash
   docker compose logs --no-log-prefix --tail 50 paperclip-telegram | grep 'ignored an update from chat'
   ```

   The line ends with a negative number such as `-1001234567890 (supergroup)`. Put that number in `telegramChatId`, then run `docker compose restart`. The log now says `topics on`.

**Voice notes (optional).** Set `BOT_TARGET=voice` in `.env` (copy it from `.env.example` first), then run `docker compose up -d --build` again. This builds an image with Python and the Whisper `small` model, so it works offline. The image is about 1 GB bigger. If you deleted the `voice` block from `config/config.json`, copy it back from `docker/config.example.json`, then run `docker compose restart`.

For another model, set `WHISPER_MODEL` in `.env` (for example `base`) and `voice.model` in `config/config.json` to the same name, then run `docker compose up -d --build`.

To update, run `git pull` and then `docker compose up -d --build`. To stop and remove the container, run `docker compose down`.

### Networking

The container uses `network_mode: host`, so `paperclipUrl` can be `http://127.0.0.1:3100`, as with systemd. The bot opens no ports. On Docker Desktop, host networking does not reach your machine. Remove `network_mode: host` from `docker-compose.yaml`, add `extra_hosts: ["host.docker.internal:host-gateway"]`, and set `paperclipUrl` to `http://host.docker.internal:3100`.

### Troubleshooting

- **The bot keeps restarting.** A config or token error makes the bot exit with status 78 and a message that names the problem. systemd stops there, but Docker has no such setting. It starts the container again, waiting longer each time. Read the message, fix the file, then run `docker compose restart`:

  ```bash
  docker compose logs --no-log-prefix --tail 20 paperclip-telegram
  ```

- **`token file must not be accessible by group or others`.** Run `chmod 600 config/*`.
- **`token file cannot be read` or the state cannot be written.** `PUID` and `PGID` must be the owner of `config/` and `state/`.
- **`Telegram 409`.** A webhook is set for the bot, or another copy of it is polling. Use a separate bot, or remove the webhook. The bot never removes it for you.
- **HTTP 401 from Paperclip.** The log says so, and the bot sends at most one Telegram alert an hour. Create a new key (step 5) and restart.

## Run with systemd

Use this if you would rather run the bot as a user service. It needs Node.js 22 or newer. The bot has no npm dependencies.

1. Do steps 2 to 4 above.
2. Save the two tokens as in steps 5 and 6, with `~/.config/paperclip-telegram/` in place of `config/`. Create that folder first with mode 700. The commands that save and check the tokens are the same.
3. Copy `config.example.json` to `~/.config/paperclip-telegram/config.json`, set its mode to 600 and edit it. Find your user id as in step 6.
4. Install and start the service:

   ```bash
   scripts/install-service.sh
   systemctl --user daemon-reload
   systemctl --user enable --now paperclip-telegram
   loginctl enable-linger "$USER"    # keep the service running when you are logged out
   ```

   The script writes the unit file for this checkout and the `node` found on your `PATH`, and creates the state folder `~/.local/state/paperclip-telegram` with mode 700. After you update the checkout, run it again and then `systemctl --user daemon-reload`.

5. Check it:

   ```bash
   systemctl --user status paperclip-telegram
   journalctl --user -u paperclip-telegram -n 50 --no-pager
   ```

   For a group, find its id with `journalctl --user -u paperclip-telegram -n 50 --no-pager | grep 'ignored an update from chat'`, set `telegramChatId`, and run `systemctl --user restart paperclip-telegram`.

If the unit stopped with status 78, it is a configuration problem and systemd does not restart it. Fix the file named in the journal, then run `systemctl --user start paperclip-telegram`. For voice notes, run `scripts/install-voice.sh` and add the `voice` block that it prints to the config.

## Configuration

These are the main keys. [docs/configuration.md](docs/configuration.md) lists every key, its default and the voice settings.

| Key | Meaning |
| --- | --- |
| `paperclipUrl` | API address of the Paperclip server, reachable from the bot. |
| `uiBaseUrl` | The address you open Paperclip at in a browser. Used for the links in messages. |
| `companyId` | The company to watch. |
| `leadAgentId` | The agent that gets tasks created from Telegram. |
| `newTaskProjectId` | Default project for new tasks, or `null` for none. |
| `telegramUserId` | Your Telegram user id. Only this user is served. |
| `telegramChatId` | The chat the bot writes to. For a group, its id (a negative number). Defaults to `telegramUserId`. |
| `telegramTokenFile`, `paperclipTokenFile` | Paths of the two token files. |
| `topics` | `"auto"` (default) or `"off"`. Topics are used when the chat is a forum group where the bot may manage them. |
| `pollSeconds` | Seconds between Paperclip polls. Default 15. |
| `voice` | Turns voice notes on. Without it a voice note gets a short "not set up" reply. |

## Using it

Send plain text in the main chat and the bot offers to create a task, with buttons for the agent, model and reasoning level. Inside a task's topic, plain text is a comment. A reply to any bot message about a task is a comment too.

| Command | What it does |
| --- | --- |
| `/new [@agent] [#project] <text>` | Creates a task. |
| `/task <ID>` | Opens a task, with buttons to finish, reopen, cancel, assign, comment and more. |
| `/tasks`, `/find <text>` | Lists open tasks, or searches them. |
| `/status` | Shows what is running and what waits for you. |
| `/following` | Lists the tasks you follow. |
| `/agents` | Lists the agents. Open one to pause, resume, run it, or pick its model and reasoning level. |
| `/projects` | Lists the projects with their open tasks. |
| `/settings` | Choose which messages you get, and mute for 1 or 8 hours. |
| `/help` | Shows the commands, with buttons for the common ones. |

A short tour:

- **Answer an agent.** A card arrives with the question and its buttons. Tap one. The card keeps its text, loses its buttons and ends with a line that says what happened.
- **Follow a task.** In a group each task has a topic, and agent comments appear there. Write in the topic to comment.
- **Send a file or a photo.** As a reply to a task message, or in the task's topic, it is attached to the task.
- **Send a voice note.** The bot shows the text it heard. Tap **Send** to use it as a comment or an answer, or to create a task.

[docs/usage.md](docs/usage.md) describes every message and button.

## Security notes

- Only the configured user, in the configured chat, is served. The bot never sends messages anywhere else.
- Token files must be regular files with mode 600. Tokens are never logged.
- The bot opens no port. The container runs as an unprivileged user with a read-only root file system, no capabilities and a read-only config folder.
- Voice notes are transcribed on your machine. The log holds the length and language of a note, never its text.

More in [SECURITY.md](SECURITY.md), including how to report a vulnerability.

## Development

```bash
npm test
```

The bot has no dependencies. The tests run the real bot against fake Telegram and Paperclip servers on local ports, so nothing leaves the machine. They need Node.js 22 or newer. Voice is tested with a small script that stands in for `scripts/transcribe.py`, so no model is needed. `npm start` runs the bot in the foreground with the same config and token files.

GitHub Actions runs the tests on Node.js 22 and 24 and builds both Docker targets.

## Limitations

- **Polling delay.** Paperclip is polled every `pollSeconds` (15 by default), so a message can come that much later than the event. A board key cannot open Paperclip's websocket.
- **Failed runs.** Paperclip lists a failed run only after it has used up its retries, so the alert comes after the retries.
- **Cards.** Item verdicts, task suggestions, connection requests and other card kinds are sent as text with a link. Answer them in Paperclip.
- **Size limits.** Telegram lets a bot download files up to 20 MB, and Paperclip accepts up to 10 MB. Voice notes are accepted up to 5 minutes by default.
- **Voice.** Transcription runs on the CPU, so a long note takes a while. A failed audio download is not retried. Only voice notes are read, not audio files or video notes.
- **Large installations.** Project counts are read from at most 1000 tasks, and a single poll reads at most 2000 changed tasks.
- **One of each.** One Telegram user, one chat and one Paperclip company per bot.
- **Albums.** Each photo of an album is handled on its own.

## Credits

Paperclip's card API was learned from [iosayin/paperclip-telegram](https://github.com/iosayin/paperclip-telegram) (MIT). Voice notes use [faster-whisper](https://github.com/SYSTRAN/faster-whisper).

## License

[MIT](LICENSE)
