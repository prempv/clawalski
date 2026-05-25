# Security policy

## Reporting a vulnerability

If you've found a security issue in clawalski — credential exposure, command injection, sandbox escape, anything that could compromise an instance or its host — **do not file a public issue**. Email the maintainer (see GitHub profile for contact) with:

- A description of the issue
- Steps to reproduce
- Affected versions
- Any proof-of-concept

You'll get a response within a reasonable window, and a fix or disclosure plan from there.

## What clawalski stores locally

Each clawalski instance directory contains:

- `config/.env` — Telegram bot token (chmod 600 by `init`)
- `config/access.json` — chat IDs, optional admin chat id
- `data/sessions.db` — SQLite of Claude session ids per conversation
- `data/conversations/` — JSONL log of every message exchange and tool call
- `data/logs/` — daily-rotated app logs
- `workspace/` — the directory where the spawned Claude process runs

**These directories must not be checked into version control.** `.gitignore` blocks the patterns repo-wide, and `.githooks/pre-commit` scans staged content for known secret formats (Telegram bot tokens, API keys for several providers).

## Bot security checklist

- Don't use `dmPolicy: "open"` outside of testing — anyone who finds the bot can talk to it.
- Set `adminChatId` in `access.json` so unauthorized-access alerts go somewhere.
- Run each instance under a separate Telegram bot (separate token), not a shared one.
- The systemd unit emitted by `service install` runs under your user account; the spawned Claude processes inherit that scope. Don't point `workingDir` at directories you wouldn't trust the bot's senders to read or modify.
- Claude and Codex backends use non-interactive permission-bypass flags by default. Treat every allowlisted Telegram sender as able to delegate agent work inside the configured `workingDir`.

## Updating

Run `clawalski update` to pull the latest master tarball. Pin to a tag for reproducibility:

```bash
npm i -g https://github.com/prempv/clawalski/archive/refs/tags/v0.1.0.tar.gz
```
