import { readFileSync, watch } from "node:fs";
import { z } from "zod";
import type { Logger } from "./logger.js";

const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{0,27}$/;

const backendIdSchema = z.enum(["claude", "codex"]);

const cronJobSchema = z
	.object({
		id: z
			.string()
			.regex(JOB_ID_RE, "must be lowercase alphanumeric + hyphens, 1-28 chars"),
		name: z
			.string()
			.regex(JOB_ID_RE, "must be lowercase alphanumeric + hyphens, 1-28 chars"),
		enabled: z.boolean().default(true),
		schedule: z.string().min(1, "cron expression required"),
		timezone: z.string().optional(),

		// Prompt — exactly one of prompt or promptFile
		prompt: z.string().optional(),
		promptFile: z.string().optional(),

		// Output destination (optional — if omitted, log-only)
		chatId: z.number().optional(),
		threadId: z.number().optional(),

		// Failure alert destination (falls back to admin chat)
		failureAlertChatId: z.number().optional(),

		// Per-job overrides
		backend: backendIdSchema.optional(),
		systemPrompt: z.string().nullable().optional(),
		workingDir: z.string().nullable().optional(),
		model: z.string().nullable().optional(),
	})
	.refine((j) => j.prompt || j.promptFile, {
		message: "either prompt or promptFile is required",
	})
	.refine((j) => !(j.prompt && j.promptFile), {
		message: "prompt and promptFile are mutually exclusive",
	});

const cronFileSchema = z.object({
	jobs: z.array(cronJobSchema).default([]),
});

export type CronJob = z.infer<typeof cronJobSchema>;

export interface CronConfig {
	jobs: CronJob[];
}

/** Dedup jobs by id — last occurrence wins. */
function dedupJobs(jobs: CronJob[]): CronJob[] {
	const map = new Map<string, CronJob>();
	for (const job of jobs) {
		map.set(job.id, job);
	}
	return [...map.values()];
}

export function parseCronConfig(raw: unknown): CronConfig {
	const parsed = cronFileSchema.parse(raw);
	return { jobs: dedupJobs(parsed.jobs) };
}

export function loadCronConfig(filePath: string, log?: Logger): CronConfig {
	try {
		const content = readFileSync(filePath, "utf-8");
		const config = parseCronConfig(JSON.parse(content));
		log?.info(
			{
				jobs: config.jobs.length,
				enabled: config.jobs.filter((j) => j.enabled).length,
			},
			"cron config loaded",
		);
		return config;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			log?.info({ filePath }, "cron config not found, no cron jobs configured");
			return { jobs: [] };
		}
		throw err;
	}
}

export function watchCronConfig(
	filePath: string,
	onChange: (config: CronConfig) => void,
	log: Logger,
): void {
	let debounce: ReturnType<typeof setTimeout> | null = null;

	try {
		watch(filePath, () => {
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(() => {
				try {
					const config = loadCronConfig(filePath, log);
					onChange(config);
					log.info("cron config reloaded");
				} catch (err) {
					log.error({ err }, "failed to reload cron config, keeping previous");
				}
			}, 300);
		});
		log.info({ filePath }, "watching cron config for changes");
	} catch {
		log.warn({ filePath }, "could not watch cron config file");
	}
}

/** Convert job name to Telegram command name: hyphens → underscores, prefixed with run_ */
export function jobNameToCommand(name: string): string {
	return `run_${name.replace(/-/g, "_")}`;
}

/** Convert Telegram command back to job name: strip run_ prefix, underscores → hyphens */
export function commandToJobName(command: string): string {
	return command.replace(/^run_/, "").replace(/_/g, "-");
}
