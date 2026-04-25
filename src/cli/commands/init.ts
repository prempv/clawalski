import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import * as readline from "node:readline/promises";
import { resolveInstancePaths } from "../instance.js";

interface InitArgs {
	path: string;
	token?: string;
	adminChatId?: string;
	noInteractive: boolean;
}

function parseInitArgs(argv: string[]): InitArgs | { error: string } {
	let path: string | undefined;
	let token: string | undefined;
	let adminChatId: string | undefined;
	let noInteractive = false;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (a === "--token") {
			token = argv[++i];
		} else if (a === "--admin-chat-id") {
			adminChatId = argv[++i];
		} else if (a === "--no-interactive") {
			noInteractive = true;
		} else if (!path && !a.startsWith("-")) {
			path = a;
		} else {
			return { error: `Unknown argument: ${a}` };
		}
	}
	if (!path) return { error: "Path is required: clawalski init <path>" };
	return { path, token, adminChatId, noInteractive };
}

async function promptToken(): Promise<string> {
	const rl = readline.createInterface({ input: stdin, output: stdout });
	const answer = await rl.question("Telegram bot token (from @BotFather): ");
	rl.close();
	return answer.trim();
}

export async function initCommand(argv: string[]): Promise<number> {
	const parsed = parseInitArgs(argv);
	if ("error" in parsed) {
		console.error(parsed.error);
		return 2;
	}

	const paths = resolveInstancePaths(parsed.path);
	if (existsSync(paths.envFile)) {
		console.error(`Instance already exists at ${paths.root}`);
		return 1;
	}

	let token = parsed.token;
	if (!token) {
		if (parsed.noInteractive || !stdin.isTTY) {
			console.error(
				"--token is required. Pass --token <T> or run interactively (without --no-interactive).",
			);
			return 2;
		}
		token = await promptToken();
		if (!token) {
			console.error("Empty token; aborting.");
			return 2;
		}
	}

	mkdirSync(paths.configDir, { recursive: true });
	mkdirSync(paths.dataDir, { recursive: true });
	mkdirSync(paths.workspaceDir, { recursive: true });
	mkdirSync(paths.promptsDir, { recursive: true });

	writeFileSync(paths.envFile, `TELEGRAM_BOT_TOKEN=${token}\n`, {
		mode: 0o600,
	});

	const access = {
		dmPolicy: "allowlist",
		groupPolicy: "allowlist",
		allowedUsers: [] as number[],
		allowedGroups: [] as number[],
		adminChatId: parsed.adminChatId ? Number(parsed.adminChatId) : null,
	};
	writeFileSync(paths.accessFile, `${JSON.stringify(access, null, 2)}\n`);

	writeFileSync(paths.cronFile, `${JSON.stringify({ jobs: [] }, null, 2)}\n`);

	console.log(`Scaffolded clawalski instance at ${paths.root}`);
	console.log("Next steps:");
	console.log(
		`  - Edit ${paths.accessFile} (set allowedUsers / allowedGroups)`,
	);
	console.log(`  - Run: clawalski run ${paths.root}`);
	console.log(
		`  - Or as a service: clawalski service install ${paths.root} --name <name>`,
	);
	return 0;
}
