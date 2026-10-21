# Configuration

The bot reads one JSON file and two token files. Start from `config.example.json` (systemd) or `docker/config.example.json` (Docker Compose). Both use placeholder values only.

## Where things are

| What | Where |
| --- | --- |
| Config file | `$PAPERCLIP_TELEGRAM_CONFIG`, or `~/.config/paperclip-telegram/config.json` when that is not set. The Docker setup sets it to `/config/config.json`. |
| State file | `state.json` in `$STATE_DIRECTORY` (the first folder, if it lists several), or `~/.local/state/paperclip-telegram` when that is not set. systemd sets it from the unit, Docker Compose sets it to `/state`. |
| Telegram token | The file named by `telegramTokenFile`. It holds the token from BotFather and nothing else. |
| Paperclip key | The file named by `paperclipTokenFile`. It holds a Paperclip board key (`pcp_board_…`). |

A token file must be a regular file with mode 600 or stricter, and not empty. A missing or invalid config, or a bad token file, makes the bot exit with status 78 and a message that names the problem and the file, never the token. All problems are listed at once.

The state file keeps the update offset, the sent cards and inbox items, the seen statuses, the settings, the followed tasks, open task offers and voice jobs. It is written with mode 600.

## Keys

`~/` is expanded at the start of a path. Keys marked required have no default.

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `paperclipUrl` | yes | | API address of the Paperclip server, reachable from where the bot runs. An `http(s)` URL. |
| `uiBaseUrl` | yes | | Address you open Paperclip at in a browser. Used for the links in messages (`<uiBaseUrl>/<PREFIX>/issues/<ID>`). An `http(s)` URL. |
| `companyId` | yes | | The company to watch. |
| `leadAgentId` | yes | | The agent that gets tasks created with `/new` and from plain text. |
| `newTaskProjectId` | no | `null` | Default project for new tasks, or `null` for none. `/new #project` overrides it. |
| `telegramUserId` | yes | | Your Telegram user id. Only this user is served. A positive integer. |
| `telegramChatId` | no | `telegramUserId` | Chat the bot writes to. For a group with topics, the group id (a negative number). A non-zero integer. |
| `telegramTokenFile` | yes | | Path of the Telegram token file. |
| `paperclipTokenFile` | yes | | Path of the Paperclip key file. |
| `telegramApiUrl` | no | `https://api.telegram.org` | Telegram Bot API address. An `http(s)` URL. |
| `pollSeconds` | no | `15` | Seconds between Paperclip polls. A positive number. |
| `topics` | no | `"auto"` | `"auto"` or `"off"`. With `"auto"` topics are used when the chat is a forum group where the bot is an admin who may manage topics; `"off"` keeps everything in one chat. See [Group with topics](usage.md#group-with-topics). |
| `closedTopicDays` | no | `7` | Topics of finished tasks are deleted this many days after they were closed; `0` keeps them for ever. See [Finished topics](usage.md#finished-topics). |
| `richMessages` | no | `"auto"` | `"auto"` or `"off"`. With `"auto"` messages that hold Paperclip Markdown are sent as Telegram rich messages; `"off"` sends only plain messages. See [Rich messages](usage.md#rich-messages). |
| `routineRunErrorCodes` | no | the list in `config.example.json` | Failed runs with one of these error codes do not raise an alert. A list of strings; setting it replaces the default list. |
| `voice` | no | off | Turns voice notes on. See below. Without it a voice note gets "Voice notes are not set up on this machine." |

## Voice

The `voice` block is an object. Its `python` and `modelsDir` are required when the block is present.

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `python` | yes | | The Python of the voice setup (`<venv>/bin/python`). `~/` is expanded. In the Docker voice image it is `/opt/voice/bin/python`. |
| `modelsDir` | yes | | The folder the model was downloaded to (`<venv>/models`). In the Docker voice image it is `/opt/voice/models`. |
| `model` | no | `small` | The Whisper model to load. It must be the one that was downloaded: `scripts/install-voice.sh` and the `WHISPER_MODEL` build argument choose it. |
| `language` | no | `null` | `null` detects the language of every note. A code such as `"en"` fixes it. Not together with `languages`. |
| `languages` | no | unset | A list of 1 to 4 different [Whisper language codes](https://github.com/openai/whisper/blob/main/whisper/tokenizer.py) (2 or 3 lowercase letters), for example `["en", "ru"]`; the first is the default. The bot then never detects the language: every note is read in a named one. See [Choosing the language](usage.md#choosing-the-language). Setting both `language` and `languages` is a config error. |
| `beamSize` | no | `1` | Beam size of the search; `1` is the fastest. A positive integer. |
| `threads` | no | `4` | CPU threads for one transcription. A positive integer. |
| `maxSeconds` | no | `300` | The longest note that is accepted. A positive number. |

Voice notes are described in [Voice notes](usage.md#voice-notes).

## Docker Compose

| Setting | Where | Meaning |
| --- | --- | --- |
| `BOT_TARGET` | `.env` | `bot` (default) builds the image without Python. `voice` builds the image with local speech-to-text. |
| `PUID`, `PGID` | `.env` | User and group the bot runs as (default 1000). They must be able to read the files in `config/` and write `state/`. |
| `WHISPER_MODEL` | build argument | Model downloaded into the voice image (default `small`). Build it with `docker compose build --build-arg WHISPER_MODEL=base`, set `voice.model` to the same name, and start with `docker compose up -d` (a later `--build` without the argument builds `small` again). |
| `PAPERCLIP_TELEGRAM_CONFIG`, `STATE_DIRECTORY` | `docker-compose.yaml` | The paths inside the container: `/config/config.json` and `/state`. |
