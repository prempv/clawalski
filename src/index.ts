import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { loadAccessConfig, watchAccessConfig } from "./access.js";
import {
	DefaultBackendRegistry,
	PendingBackendStore,
} from "./backend-registry.js";
import type {
	BackendBridgeOptions,
	BackendCronPool,
	BackendId,
	BackendPool,
} from "./backend.js";
import { loadBindingConfig } from "./binding-config.js";
import { ProcessPool } from "./claude-bridge.js";
import type { HandleUpdateOptions } from "./claude-handler.js";
import { ClaudeInteractiveProcessPool } from "./claude-interactive-bridge.js";
import { CodexCronProcessPool, CodexProcessPool } from "./codex-bridge.js";
import { type Config, loadConfig } from "./config.js";
import {
	createConversationLogger,
	migrateConversationLogs,
} from "./conversation-logger.js";
import {
	jobNameToCommand,
	loadCronConfig,
	watchCronConfig,
} from "./cron-config.js";
import type { CronConfig } from "./cron-config.js";
import { CronProcessPool } from "./cron-process-pool.js";
import { CronScheduler } from "./cron-scheduler.js";
import { createCronStateStore } from "./cron-state.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { startPolling } from "./poller.js";
import { createApp } from "./server.js";
import { SessionRecorder } from "./session-stats/index.js";
import { createSessionStore } from "./session-store.js";
import {
	notifyReady,
	notifyStopping,
	startWatchdog,
} from "./systemd-notify.js";
import { TelegramClient } from "./telegram-client.js";

export interface RunInstanceOptions {
	instancePath: string;
}

export async function runInstance({
	instancePath,
}: RunInstanceOptions): Promise<void> {
	const startedAt = Date.now();
	const config = loadConfig({ instancePath });
	const { logger: log, close: closeLogger } = createLogger(config);
	log.info({ instancePath }, "starting instance");

	const client = new TelegramClient(config.telegramBotToken, { logger: log });

	const me = await client.getMe();
	log.info({ bot: me.username, name: me.first_name }, "authenticated");

	let access = loadAccessConfig(config.accessFile, log);
	const stopAccessWatch = watchAccessConfig(
		config.accessFile,
		(updated) => {
			access = updated;
		},
		log,
	);

	const bindings = loadBindingConfig(config.bindingsFile, log);

	const sessionStore = createSessionStore(config.sessionDbPath);
	log.info({ dbPath: config.sessionDbPath }, "session store ready");

	const sessionRecorder = new SessionRecorder();

	mkdirSync(config.claudeWorkingDir, { recursive: true });

	const conversationLogDir = config.conversationLogDir;
	const migrated = migrateConversationLogs(conversationLogDir);
	if (migrated > 0) {
		log.info({ migrated }, "migrated conversation logs to subdirectories");
	}
	const conversationLogger = createConversationLogger(conversationLogDir);

	// Resolve cron config path up-front so both process pools can grant it
	// --rw in the sandbox. landrun requires the path to exist when applying
	// Landlock rules, so ensure the file (and its parent dir) exist.
	mkdirSync(dirname(config.cronFile), { recursive: true });
	if (!existsSync(config.cronFile)) {
		writeFileSync(config.cronFile, '{\n  "jobs": []\n}\n');
	}

	const claudeOpts: BackendBridgeOptions = {
		workingDir: config.claudeWorkingDir,
		model: config.claudeModel,
		cronFilePath: config.cronFile,
		stateDir: join(config.instancePath, "data/claude-v2"),
		log,
	};
	const codexOpts: BackendBridgeOptions = {
		workingDir: config.claudeWorkingDir,
		model: config.codexModel,
		cronFilePath: config.cronFile,
		log,
	};

	const claudePool = new ProcessPool(claudeOpts);
	const claudeV2Pool = new ClaudeInteractiveProcessPool(claudeOpts);
	const codexPool = new CodexProcessPool(codexOpts);
	const claudeCronPool = new CronProcessPool(claudeOpts);
	// Cron runs are intentionally one-shot; the v2 Telegram backend is
	// interactive/tmux-only, so cron keeps using Claude's stream-json path.
	const claudeV2CronPool = new CronProcessPool(claudeOpts);
	const codexCronPool = new CodexCronProcessPool(codexOpts);

	const backendPools = new Map<BackendId, BackendPool>([
		["claude", claudePool],
		["claude-v2", claudeV2Pool],
		["codex", codexPool],
	]);
	const backendCronPools = new Map<BackendId, BackendCronPool>([
		["claude", claudeCronPool],
		["claude-v2", claudeV2CronPool],
		["codex", codexCronPool],
	]);
	const backends = new DefaultBackendRegistry(
		config.defaultBackend,
		backendPools,
		backendCronPools,
	);
	const pendingBackends = new PendingBackendStore();
	log.info({ defaultBackend: config.defaultBackend }, "backends ready");

	const db = new Database(config.sessionDbPath);
	db.pragma("journal_mode = WAL");
	const cronStateStore = createCronStateStore(db);

	let cronConfig = loadCronConfig(config.cronFile, log);

	const cronScheduler = new CronScheduler({
		getCronConfig: () => cronConfig,
		stateStore: cronStateStore,
		handlerDeps: {
			client,
			backends,
			stateStore: cronStateStore,
			sessionStore,
			sessionRecorder,
			conversationLogger,
			log,
			defaultWorkingDir: config.claudeWorkingDir,
			defaultOpts: claudeOpts,
			promptsDir: config.promptsDir,
			retryMaxAttempts: config.cronRetryMaxAttempts,
			stuckTimeoutMs: config.cronStuckTimeoutMs,
			failureAlertAfter: config.cronFailureAlertAfter,
			failureAlertCooldownMs: config.cronFailureAlertCooldownMs,
			autoDisableAfter: config.cronAutoDisableAfter,
			getAdminChatId: () => access.adminChatId,
		},
		log,
	});

	const stopCronWatch = watchCronConfig(
		config.cronFile,
		(updated) => {
			cronConfig = updated;
			cronScheduler.onConfigReload(updated);
			void registerCronCommands(client, updated, log);
		},
		log,
	);

	await registerCronCommands(client, cronConfig, log);
	cronScheduler.start();

	const handlerOpts: HandleUpdateOptions = {
		respondMode: config.respondMode,
		botUsername: me.username ?? "",
		getAccess: () => access,
		sessionStore,
		sessionRecorder,
		backends,
		pendingBackends,
		conversationLogger,
		cronScheduler,
		promptsDir: config.promptsDir,
		cronFilePath: config.cronFile,
		conversationLogDir,
		bindings,
	};

	const ac = new AbortController();
	const stopWatchdog = startWatchdog(log);

	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		process.on(sig, () => {
			log.info({ signal: sig }, "shutting down");
			notifyStopping();
			stopWatchdog();
			ac.abort();
			stopAccessWatch();
			stopCronWatch();
			cronScheduler.stop();
			backends.closeAll();
			sessionStore.close();
			db.close();
			closeLogger();
		});
	}

	notifyReady();

	if (config.mode === "webhook") {
		await runWebhook(client, log, config, ac, handlerOpts, startedAt);
	} else {
		await client.deleteWebhook();
		await startPolling(client, log, ac.signal, handlerOpts);
	}
}

async function runWebhook(
	client: TelegramClient,
	log: Logger,
	config: Config,
	ac: AbortController,
	handlerOpts: HandleUpdateOptions,
	startedAt: number,
): Promise<void> {
	const app = createApp({
		client,
		log,
		webhookSecret: config.webhookSecret,
		webhookPath: config.webhookPath,
		startedAt,
		handlerOpts,
	});

	const webhookUrl = config.webhookUrl ?? "";
	const fullUrl = `${webhookUrl.replace(/\/$/, "")}${config.webhookPath}`;
	await client.setWebhook(fullUrl, config.webhookSecret);
	log.info({ url: fullUrl }, "webhook registered");

	const server = serve({ fetch: app.fetch, port: config.webhookPort }, () => {
		log.info({ port: config.webhookPort }, "webhook server listening");
	});

	await new Promise<void>((resolve) => {
		ac.signal.addEventListener("abort", () => {
			server.close();
			resolve();
		});
	});

	await client.deleteWebhook().catch(() => {});
	log.info("webhook server stopped");
}

async function registerCronCommands(
	client: TelegramClient,
	config: CronConfig,
	log: Logger,
): Promise<void> {
	// Telegram bot commands only allow [a-z0-9_], so the menu uses
	// underscores; the parser accepts both `_` and `-` for forgiveness.
	const commands = [
		{ command: "new_claude", description: "Start fresh — use Claude" },
		{ command: "new_claude_v2", description: "Start fresh — use Claude v2" },
		{ command: "new_claudev2", description: "Start fresh — use Claude v2" },
		{ command: "new_codex", description: "Start fresh — use Codex" },
		{ command: "stats", description: "Show session statistics" },
		{ command: "cron", description: "Manage cron jobs" },
		...config.jobs
			.filter((j) => j.enabled)
			.map((j) => ({
				command: jobNameToCommand(j.name),
				description: `Run: ${j.name}`,
			})),
	];
	try {
		await client.setMyCommands(commands);
		log.info(
			{ count: commands.length, cron: commands.length - 6 },
			"registered bot commands",
		);
	} catch (err) {
		log.error({ err }, "setMyCommands failed — continuing without refresh");
	}
}
