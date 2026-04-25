import { join } from "node:path";
import { z } from "zod";

const backendIdSchema = z.enum(["claude", "codex"]);

const configSchema = z.object({
	telegramBotToken: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
	mode: z.enum(["polling", "webhook"]).default("polling"),
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
	respondMode: z.enum(["all", "mention"]).default("all"),

	instancePath: z.string().min(1),
	accessFile: z.string().min(1),
	cronFile: z.string().min(1),
	sessionDbPath: z.string().min(1),
	logDir: z.string().min(1),
	conversationLogDir: z.string().min(1),
	claudeWorkingDir: z.string().min(1),
	promptsDir: z.string().min(1),

	defaultBackend: backendIdSchema.default("claude"),
	claudeModel: z.string().optional(),
	codexModel: z.string().optional(),

	cronRetryMaxAttempts: z.coerce.number().int().positive().default(3),
	cronStuckTimeoutMs: z.coerce.number().int().positive().default(2_700_000),
	cronFailureAlertAfter: z.coerce.number().int().positive().default(2),
	cronFailureAlertCooldownMs: z.coerce
		.number()
		.int()
		.positive()
		.default(3_600_000),
	cronAutoDisableAfter: z.coerce.number().int().positive().default(5),

	webhookUrl: z.string().optional(),
	webhookSecret: z.string().optional(),
	webhookPort: z.coerce.number().int().positive().default(8787),
	webhookPath: z.string().default("/telegram-webhook"),
});

export type Config = z.infer<typeof configSchema>;

export interface LoadConfigOptions {
	instancePath: string;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export function loadConfig({ instancePath }: LoadConfigOptions): Config {
	const result = configSchema.safeParse({
		telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
		mode: process.env.MODE || undefined,
		logLevel: process.env.LOG_LEVEL || undefined,
		respondMode: process.env.RESPOND_MODE || undefined,

		instancePath,
		accessFile:
			process.env.ACCESS_FILE || join(instancePath, "config/access.json"),
		cronFile: process.env.CRON_FILE || join(instancePath, "config/crons.json"),
		sessionDbPath:
			process.env.SESSION_DB_PATH || join(instancePath, "data/sessions.db"),
		logDir: process.env.LOG_DIR || join(instancePath, "data/logs"),
		conversationLogDir:
			process.env.CONVERSATION_LOG_DIR ||
			join(instancePath, "data/conversations"),
		claudeWorkingDir:
			process.env.CLAUDE_WORKING_DIR || join(instancePath, "workspace"),
		promptsDir: process.env.PROMPTS_DIR || join(instancePath, "config/prompts"),

		defaultBackend: process.env.DEFAULT_BACKEND || undefined,
		claudeModel: process.env.CLAUDE_MODEL || undefined,
		codexModel: process.env.CODEX_MODEL || undefined,

		cronRetryMaxAttempts: process.env.CRON_RETRY_MAX_ATTEMPTS,
		cronStuckTimeoutMs: process.env.CRON_STUCK_TIMEOUT_MS,
		cronFailureAlertAfter: process.env.CRON_FAILURE_ALERT_AFTER,
		cronFailureAlertCooldownMs: process.env.CRON_FAILURE_ALERT_COOLDOWN_MS,
		cronAutoDisableAfter: process.env.CRON_AUTO_DISABLE_AFTER,

		webhookUrl: process.env.WEBHOOK_URL,
		webhookSecret: process.env.WEBHOOK_SECRET,
		webhookPort: process.env.WEBHOOK_PORT,
		webhookPath: process.env.WEBHOOK_PATH,
	});

	if (!result.success) {
		const errors = result.error.issues
			.map((i) => `  ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		throw new ConfigError(`Configuration error:\n${errors}`);
	}

	const config = result.data;

	if (config.mode === "webhook" && !config.webhookUrl) {
		throw new ConfigError(
			"Configuration error:\n  WEBHOOK_URL is required when MODE=webhook",
		);
	}

	return config;
}
