# Clawalski

Installable, path-addressed Telegram-to-Claude Code CLI gateway. Each instance is a free-standing directory at any path; `clawalski init <path>` scaffolds it, `clawalski run <path>` runs it, `clawalski service install <path> --name <n>` registers it as a systemd user service.

## Stack
TypeScript, Hono, better-sqlite3, Zod, pino. Built with tsdown targeting Node 22. Biome for linting/formatting (tab indent).

## Commands
- `pnpm dev` — `tsx watch src/cli.ts` (pass CLI args after)
- `pnpm build` — bundle via tsdown into `dist/cli.js` (with shebang)
- `pnpm lint` / `pnpm typecheck` / `pnpm test` — quality checks

## Instance layout (created by `init`)
```
<path>/
├── config/{access,crons,service}.json, .env, prompts/
├── workspace/
└── data/{sessions.db, logs/, conversations/}
```
