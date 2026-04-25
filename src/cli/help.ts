export function printTopHelp(): void {
	console.log(`clawalski — Telegram bot gateway to Claude Code CLI

Usage:
  clawalski init <path> [flags]            Scaffold a new instance directory
  clawalski run <path>                     Run an instance in the foreground
  clawalski service install <path> --name <n>
                                           Register and start a systemd user service
  clawalski service uninstall <path>       Remove the systemd user service
  clawalski service start|stop|restart|status|logs <path>
                                           Manage the instance's service
  clawalski list                           List registered clawalski-* services
  clawalski update                         Upgrade via \`pnpm add -g git+…\`
  clawalski version                        Show version
  clawalski help                           Show this help

Init flags:
  --token <T>           Bot token (interactive prompt if missing on a TTY)
  --admin-chat-id <ID>  Optional admin chat id
  --no-interactive      Fail instead of prompting
`);
}
