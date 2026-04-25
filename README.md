# clawalski

Path-addressed Telegram bot gateway to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI subprocesses. Each instance is a free-standing directory; install once, scaffold instances anywhere, run them as systemd user services. Forked from the reference [telegram-gateway](https://github.com/prempv/telegram-gateway).

## Install

Installed from GitHub (no npm registry) using `npm` (or `pnpm`):

```bash
npm i -g git+https://github.com/prempv/clawalski
```

Pin to a tag:

```bash
npm i -g git+https://github.com/prempv/clawalski#v0.1.0
```

`pnpm add -g …` works too, but requires `pnpm setup` to have been run first on the machine.

### Prerequisites

- Node ≥ 22
- `npm` on `PATH`
- A C toolchain for `better-sqlite3`'s native build: `python3`, `make`, `gcc` (Linux). On Arch: `base-devel`. On Debian/Ubuntu: `build-essential python3`.

## Quick start

```bash
clawalski init ~/bots/personal --token "$TELEGRAM_BOT_TOKEN" --admin-chat-id 123456789
clawalski service install ~/bots/personal --name personal
clawalski service logs    ~/bots/personal
```

Each instance is fully isolated. To run another:

```bash
clawalski init /srv/work-bot --token "$WORK_TOKEN"
clawalski service install /srv/work-bot --name work
```

## Commands

```
clawalski init <path> [flags]              Scaffold a new instance directory
clawalski run <path>                        Run an instance in the foreground
clawalski service install <path> --name <n> Register + start a systemd user service
clawalski service uninstall <path>          Stop, disable, remove the unit (data preserved)
clawalski service start|stop|restart|status|logs <path>
                                            Manage the instance's service
clawalski list                              List registered clawalski-* services
clawalski update                            Re-run pnpm to pull latest from GitHub
clawalski version | help
```

`<path>` is the absolute (or resolvable) instance directory — required on every instance-scoped command.

### `init` flags

| Flag | Description |
|---|---|
| `--token <T>` | Telegram bot token from [@BotFather](https://t.me/BotFather). If omitted on a TTY, you'll be prompted. |
| `--admin-chat-id <ID>` | Chat ID that receives unauthorized-access alerts. Optional. |
| `--no-interactive` | Fail with a clear error instead of prompting. Use in scripts. |

## Instance layout

`init <path>` creates this skeleton:

```
<path>/
├── config/
│   ├── .env                  # TELEGRAM_BOT_TOKEN, env overrides (chmod 600)
│   ├── access.json           # hot-reloadable access policy
│   ├── crons.json            # hot-reloadable cron jobs
│   ├── service.json          # written by `service install` — { "name": "..." }
│   └── prompts/              # base.md, dm.md, group.md, cron.md (you populate)
├── workspace/                # default working dir for spawned Claude processes
└── data/
    ├── sessions.db           # SQLite — Claude session ids per conversation
    ├── logs/                 # daily-rotated app logs
    └── conversations/        # per-session JSONL conversation logs
```

The bot won't start until `config/.env` has a non-empty `TELEGRAM_BOT_TOKEN`.

## Configuration

### `config/access.json`

Hot-reloadable access policy. Edit at any time; the running instance picks up changes.

```json
{
  "dmPolicy": "open",
  "groupPolicy": "allowlist",
  "allowedUsers": [123456789],
  "allowedGroups": [-100123456789, "*"],
  "adminChatId": 987654321
}
```

- `dmPolicy` / `groupPolicy`: `"open"` (anyone) or `"allowlist"` (specific IDs).
- `"*"` in `allowedUsers` / `allowedGroups` allows all.
- `adminChatId` receives notifications about unauthorized access attempts (throttled per sender).

### `config/crons.json`

Scheduled Claude invocations. Hot-reloadable. Each job is a standalone session.

```json
{
  "jobs": [
    {
      "id": "standup-v1",
      "name": "standup",
      "enabled": true,
      "schedule": "0 9 * * 1-5",
      "timezone": "America/New_York",
      "prompt": "Review the git log from the last 24 hours and write a standup summary.",
      "chatId": 123456789,
      "threadId": 15,
      "failureAlertChatId": 987654321,
      "systemPrompt": "You are a dev team assistant. Be concise.",
      "workingDir": "/home/dev/work/my-project",
      "model": "sonnet"
    }
  ]
}
```

Each enabled job registers a `/run_<name>` Telegram command for manual triggering.

Fields: `id`, `name`, `enabled`, `schedule`, `timezone`, `prompt` or `promptFile`, `chatId`, `threadId`, `failureAlertChatId`, `systemPrompt`, `workingDir`, `model`.

### `config/prompts/`

Tiered system-prompt composition. Files are read on each Claude process spawn.

| File | When applied |
|---|---|
| `base.md` | Always |
| `dm.md` | Direct messages (highest privilege) |
| `group.md` | Group chats |
| `cron.md` | Cron jobs (combined with each job's `systemPrompt`) |

Missing or empty files are silently skipped. See [`examples/prompts/`](./examples/prompts/) for a starter set.

### Environment variables

The full set of overrides is read from `config/.env`. Most users only need `TELEGRAM_BOT_TOKEN`. Available variables:

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *required* | Bot token from @BotFather |
| `MODE` | `polling` | `polling` or `webhook` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `RESPOND_MODE` | `all` | `all` or `mention` (groups: only @-mentions) |
| `DEFAULT_BACKEND` | `claude` | `claude` or `codex` |
| `CLAUDE_MODEL` | *(default)* | e.g. `sonnet`, `opus`, `haiku` |
| `CODEX_MODEL` | *(default)* | Override for codex backend |
| `CRON_RETRY_MAX_ATTEMPTS` | `3` | Per-run transient retry cap |
| `CRON_STUCK_TIMEOUT_MS` | `2700000` | Stuck-job force clear (45min) |
| `CRON_FAILURE_ALERT_AFTER` | `2` | Alert after N consecutive failures |
| `CRON_FAILURE_ALERT_COOLDOWN_MS` | `3600000` | Min gap between alerts per job |
| `CRON_AUTO_DISABLE_AFTER` | `5` | Auto-disable after N consecutive failures |

Webhook-only:

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_URL` | *required* | Full URL Telegram POSTs to |
| `WEBHOOK_SECRET` | — | Optional secret token validation |
| `WEBHOOK_PORT` | `8787` | HTTP server port |
| `WEBHOOK_PATH` | `/telegram-webhook` | Endpoint path |

Path overrides (rarely needed; defaults derive from the instance dir):
`ACCESS_FILE`, `CRON_FILE`, `SESSION_DB_PATH`, `LOG_DIR`, `CONVERSATION_LOG_DIR`, `CLAUDE_WORKING_DIR`, `PROMPTS_DIR`.

## Service

`clawalski service install <path> --name <name>` writes a systemd user unit at `~/.config/systemd/user/clawalski-<name>.service`, then `daemon-reload`s, `enable`s, and `start`s it. The `--name` is recorded in `<path>/config/service.json`, so subsequent `service start|stop|restart|status|logs <path>` only need the path.

```bash
clawalski service install ~/bots/personal --name personal
clawalski service status   ~/bots/personal
clawalski service logs     ~/bots/personal       # journalctl -f
clawalski service uninstall ~/bots/personal      # data is left intact
clawalski list                                    # all clawalski-* services on this machine
```

The service runs `clawalski run <path>` under the user's systemd, with `EnvironmentFile=<path>/config/.env`. The unit file references the absolute `clawalski` binary path resolved at install time (via `which clawalski`).

## Conversation IDs

Sessions are scoped by conversation context:

| Context | ID Format |
|---|---|
| Private DM | `tg:dm:{userId}` |
| Group chat | `tg:group:{chatId}` |
| Forum topic | `tg:group:{chatId}:topic:{threadId}` |

## Development

```bash
git clone https://github.com/prempv/clawalski
cd clawalski
pnpm install
pnpm dev init /tmp/cw-dev --token $YOUR_TEST_TOKEN
pnpm dev run /tmp/cw-dev
pnpm test && pnpm lint && pnpm typecheck
```

`pnpm dev` runs `tsx watch src/cli.ts` — pass any clawalski args after.

## License

MIT
