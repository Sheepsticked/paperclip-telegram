# Security

## Reporting a vulnerability

Report a vulnerability privately through GitHub: open the **Security** tab of this repository, choose **Report a vulnerability** and describe the problem ([direct link](https://github.com/Sheepsticked/paperclip-telegram/security/advisories/new)). Please do not open a public issue or post a token or log that contains one.

Only the latest commit on `main` is supported.

## What the tokens can do

The bot needs two secrets. Treat both like a password.

| Secret | What it allows |
| --- | --- |
| Telegram bot token | Whoever holds it can act as the bot: read its updates, send messages as it and download the files that were sent to it. Revoke it with `/revoke` in [@BotFather](https://t.me/BotFather). |
| Paperclip board key (`pcp_board_…`) | Whoever holds it acts as the Paperclip board user in that company: it reads the attention feed, answers cards, approvals and decisions, creates and changes tasks, posts comments, and pauses, resumes and runs agents. Its requests carry no run id, so changes are recorded as made by you. It does not expire unless you set an expiry. List and revoke keys with `paperclipai token board list` and `paperclipai token board revoke <keyId>`. |

## How the bot protects them

- Each token lives in its own file. The bot refuses to start when a token file is missing, empty, not a regular file, or readable by group or others, so keep them at mode 600.
- Tokens are never logged. The logger masks the known tokens and anything shaped like one, and errors are wrapped so a request URL cannot leak one. The download address of a Telegram file contains the bot token, so it is never logged or shown.
- Only the configured Telegram user, in the configured chat, is served. Every other update is dropped without a Paperclip call, and the bot sends messages only to the configured chat.
- The bot opens no port and needs no public address: it polls Telegram and Paperclip.
- Voice notes are transcribed on the same machine. The audio goes to a private temporary folder that is removed afterwards, and the helper runs without a shell and reads the model from disk, never from the network.
- The Docker setup runs the bot as an unprivileged user with a read-only root file system, no capabilities and `no-new-privileges`. The config folder is mounted read-only.

## What you need to do

- Keep `config/`, the token files and the state folder out of version control (the repository's `.gitignore` already lists them).
- The state file holds no tokens but does hold task titles, unsent task text and voice transcripts. The bot creates it with mode 600 in a folder with mode 700; keep it that way.
- Use a bot of your own for this. The bot ignores everyone but you, but a leaked bot token still lets others send messages as the bot.
