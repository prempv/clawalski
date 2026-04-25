import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BackendBridgeOptions, BackendRegistry } from "./backend.js";
import { sendMessageWithAuthRetry } from "./claude-bridge.js";
import { ensureFreshCliToken } from "./cli-token-warmup.js";
import type { ConversationLogger } from "./conversation-logger.js";
import type { CronJob } from "./cron-config.js";
import type { CronStateStore } from "./cron-state.js";
import type { Logger } from "./logger.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { RequestTimer } from "./request-timer.js";
import type { SessionStore } from "./session-store.js";
import { consumeEvents, streamToTelegram } from "./streaming.js";
import type { TelegramClient } from "./telegram-client.js";
import type { ContentBlock } from "./types.js";

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

const TRANSIENT_PATTERNS = [
	"rate_limit",
	"overloaded",
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"timeout",
	"spawn",
	"529",
	"503",
	"interrupted",
];

export function isTransientError(err: unknown): boolean {
	const msg = String(err);
	return TRANSIENT_PATTERNS.some((p) => msg.includes(p));
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000];

export function computeBackoffMs(consecutiveErrors: number): number {
	const idx = Math.min(consecutiveErrors - 1, BACKOFF_MS.length - 1);
	return BACKOFF_MS[idx] ?? 900_000;
}

// ---------------------------------------------------------------------------
// Prompt resolution
// ---------------------------------------------------------------------------

export function resolvePrompt(job: CronJob, defaultWorkingDir: string): string {
	if (job.prompt) return job.prompt;

	if (job.promptFile) {
		const baseDir =
			job.workingDir != null ? String(job.workingDir) : defaultWorkingDir;
		const filePath = resolve(baseDir, job.promptFile);
		return readFileSync(filePath, "utf-8");
	}

	throw new Error(
		`Job "${job.name}" (${job.id}) has neither prompt nor promptFile`,
	);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface CronRunOptions {
	manual?: boolean;
	overrideChatId?: number;
	overrideThreadId?: number;
}

export interface CronHandlerDeps {
	client: TelegramClient;
	backends: BackendRegistry;
	stateStore: CronStateStore;
	sessionStore: SessionStore;
	conversationLogger: ConversationLogger;
	log: Logger;
	defaultWorkingDir: string;
	defaultOpts: BackendBridgeOptions;
	promptsDir: string;
	retryMaxAttempts: number;
	stuckTimeoutMs: number;
	failureAlertAfter: number;
	failureAlertCooldownMs: number;
	autoDisableAfter: number;
	getAdminChatId: () => number | null;
}

export interface CronRunResult {
	status: "ok" | "error";
	error?: string;
	durationMs: number;
}

export async function executeCronJob(
	job: CronJob,
	deps: CronHandlerDeps,
	opts: CronRunOptions = {},
): Promise<CronRunResult> {
	const timer = new RequestTimer();
	const runKey = `cron:${job.id}:${Date.now()}`;
	const { log, backends, stateStore, client, conversationLogger } = deps;
	const backendId = job.backend ?? backends.defaultId;
	const cronPool = backends.cronPool(backendId);

	log.info(
		{
			job: job.name,
			id: job.id,
			backend: backendId,
			manual: opts.manual ?? false,
			runKey,
		},
		"cron job starting",
	);

	// Resolve prompt
	let prompt: string;
	try {
		prompt = resolvePrompt(job, deps.defaultWorkingDir);
	} catch (err) {
		// Prompt file errors are permanent — no retry
		const errorMsg = String(err);
		log.error({ job: job.name, id: job.id, err }, "prompt resolution failed");
		recordFailure(job, deps, errorMsg, false);
		return { status: "error", error: errorMsg, durationMs: 0 };
	}

	timer.mark("prompt_resolved");

	// Build per-job bridge options
	const jobOpts: Partial<BackendBridgeOptions> = {};
	if (job.workingDir != null) jobOpts.workingDir = job.workingDir;
	if (job.model != null) jobOpts.model = job.model;
	const cronSystemPrompt = buildSystemPrompt(
		deps.promptsDir,
		"cron",
		job.systemPrompt,
	);
	if (cronSystemPrompt !== undefined) jobOpts.systemPrompt = cronSystemPrompt;

	const jobOptsArg = Object.keys(jobOpts).length > 0 ? jobOpts : undefined;

	try {
		if (backendId === "claude") {
			try {
				await ensureFreshCliToken(log);
			} catch (err) {
				log.error({ err }, "CLI token warmup failed — proceeding anyway");
			}
		}

		const content: ContentBlock[] = [{ type: "text", text: prompt }];
		const events = sendMessageWithAuthRetry(
			() => cronPool.create(runKey, jobOptsArg, timer),
			() => cronPool.remove(runKey),
			content,
			timer,
			log,
		);

		const chatId = opts.overrideChatId ?? job.chatId;
		const threadId = opts.overrideThreadId ?? job.threadId;

		let result: import("./streaming.js").StreamResult;
		if (chatId) {
			result = await streamToTelegram(
				client,
				{
					chatId,
					messageThreadId: threadId,
				},
				events,
				log,
				timer,
			);
		} else {
			result = await consumeEvents(events, timer);
		}

		timer.mark("done");
		const timings = timer.summary();

		const failureReason =
			result.error ?? (result.interrupted ? "stream interrupted" : null);

		// Log to conversation logger and update stats
		const cronConvId = `cron:${job.id}`;
		conversationLogger.log({
			timestamp: new Date().toISOString(),
			conversationId: cronConvId,
			sessionId: result.sessionId ?? runKey,
			sender: { id: null, name: `cron:${job.name}`, username: null },
			input: `[cron:${job.name}] ${prompt.slice(0, 200)}`,
			output: result.responseText,
			tools: result.toolHistory,
			durationMs: timings.total ?? 0,
			timings,
			error: failureReason,
		});
		deps.sessionStore.updateStats(cronConvId, {
			backend: backendId,
			claudeSessionId: result.sessionId,
			model: result.model,
			inputTokens: result.inputTokens,
			outputTokens: result.outputTokens,
			costUsd: result.costUsd,
			contextWindow: result.contextWindow,
		});

		if (failureReason) {
			const isTransient = isTransientError(failureReason);
			recordFailure(job, deps, failureReason, isTransient);
			return {
				status: "error",
				error: failureReason,
				durationMs: timings.total ?? 0,
			};
		}

		// Success — reset consecutive errors
		const state = stateStore.get(job.id);
		stateStore.upsert({
			jobId: job.id,
			nextRunAtMs: state?.nextRunAtMs ?? null,
			lastRunAtMs: Date.now(),
			lastRunStatus: "ok",
			lastError: null,
			lastDurationMs: timings.total ?? 0,
			consecutiveErrors: 0,
			runningAtMs: null,
			lastFailureAlertAtMs: state?.lastFailureAlertAtMs ?? null,
		});

		log.info(
			{
				job: job.name,
				id: job.id,
				durationMs: timings.total,
				tools: result.toolHistory.length,
			},
			"cron job completed",
		);

		return { status: "ok", durationMs: timings.total ?? 0 };
	} catch (err) {
		const errorMsg = String(err);
		const isTransient = isTransientError(err);
		log.error(
			{ job: job.name, id: job.id, err, transient: isTransient },
			"cron job failed",
		);

		recordFailure(job, deps, errorMsg, isTransient);
		return {
			status: "error",
			error: errorMsg,
			durationMs: timer.summary().total ?? 0,
		};
	} finally {
		cronPool.remove(runKey);
	}
}

// ---------------------------------------------------------------------------
// Failure recording + alerting
// ---------------------------------------------------------------------------

function recordFailure(
	job: CronJob,
	deps: CronHandlerDeps,
	errorMsg: string,
	isTransient: boolean,
): void {
	const { stateStore, log } = deps;
	const existing = stateStore.get(job.id);
	const consecutive = (existing?.consecutiveErrors ?? 0) + 1;

	stateStore.upsert({
		jobId: job.id,
		nextRunAtMs: existing?.nextRunAtMs ?? null,
		lastRunAtMs: Date.now(),
		lastRunStatus: "error",
		lastError: errorMsg.slice(0, 1000),
		lastDurationMs: null,
		consecutiveErrors: consecutive,
		runningAtMs: null,
		lastFailureAlertAtMs: existing?.lastFailureAlertAtMs ?? null,
	});

	// Check if we should send a failure alert
	if (consecutive >= deps.failureAlertAfter) {
		const lastAlertAt = existing?.lastFailureAlertAtMs ?? 0;
		const now = Date.now();
		if (now - lastAlertAt >= deps.failureAlertCooldownMs) {
			sendFailureAlert(job, deps, consecutive, errorMsg, isTransient);
			stateStore.upsert({
				jobId: job.id,
				nextRunAtMs: existing?.nextRunAtMs ?? null,
				lastRunAtMs: Date.now(),
				lastRunStatus: "error",
				lastError: errorMsg.slice(0, 1000),
				lastDurationMs: null,
				consecutiveErrors: consecutive,
				runningAtMs: null,
				lastFailureAlertAtMs: now,
			});
		}
	}

	// Auto-disable after persistent failures
	if (consecutive >= deps.autoDisableAfter) {
		log.warn(
			{ job: job.name, id: job.id, consecutiveErrors: consecutive },
			"auto-disabling cron job after persistent failures",
		);
	}
}

function sendFailureAlert(
	job: CronJob,
	deps: CronHandlerDeps,
	consecutive: number,
	errorMsg: string,
	isTransient: boolean,
): void {
	const chatId = job.failureAlertChatId ?? deps.getAdminChatId();
	if (!chatId) {
		deps.log.warn(
			{ job: job.name },
			"failure alert skipped — no alert chat configured",
		);
		return;
	}

	const lines = [
		`Cron job "${job.name}" failed (${consecutive} consecutive)`,
		`Transient: ${isTransient ? "yes" : "no"}`,
		`Error: ${errorMsg.slice(0, 500)}`,
	];

	if (consecutive >= deps.autoDisableAfter) {
		lines.push("Job has been auto-disabled.");
	}

	deps.client
		.sendMessage({ chat_id: chatId, text: lines.join("\n") })
		.catch((err) => {
			deps.log.error({ err, job: job.name }, "failed to send failure alert");
		});
}
