import { Cron } from "croner";
import type { CronConfig, CronJob } from "./cron-config.js";
import {
	type CronHandlerDeps,
	type CronRunOptions,
	computeBackoffMs,
	executeCronJob,
} from "./cron-handler.js";
import type { CronStateStore } from "./cron-state.js";
import type { Logger } from "./logger.js";

const MAX_TIMER_DELAY_MS = 60_000;
const STARTUP_MAX_IMMEDIATE = 3;
const STARTUP_STAGGER_MS = 10_000;

export interface CronSchedulerOptions {
	getCronConfig: () => CronConfig;
	stateStore: CronStateStore;
	handlerDeps: CronHandlerDeps;
	log: Logger;
}

export class CronScheduler {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private activeJobs = new Set<string>();
	private disabledRuntime = new Set<string>();
	private opts: CronSchedulerOptions;

	constructor(opts: CronSchedulerOptions) {
		this.opts = opts;
	}

	start(): void {
		if (this.running) return;
		this.running = true;

		const config = this.opts.getCronConfig();
		if (config.jobs.length === 0) {
			this.opts.log.info("no cron jobs configured, scheduler idle");
			this.armTimer();
			return;
		}

		// Initialize state for new jobs
		this.initializeJobStates(config.jobs);

		// Defer startup catchup until the event loop has ticked once. This
		// lets the poller (or webhook server) issue its first I/O call before
		// any cron job spawns a subprocess, so a catchup-time crash can never
		// prevent message handling from coming up. The setImmediate itself is
		// cheap and the catchup still runs within milliseconds of start().
		setImmediate(() => {
			if (!this.running) return;
			try {
				this.runStartupCatchup(config.jobs);
			} catch (err) {
				this.opts.log.error({ err }, "startup catchup threw — continuing");
			}
		});

		this.armTimer();
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	onConfigReload(config: CronConfig): void {
		// Clear runtime disabled flags for jobs that have been re-enabled or re-added
		for (const job of config.jobs) {
			if (job.enabled) {
				this.disabledRuntime.delete(job.id);
			}
		}

		// Initialize state for any new jobs
		this.initializeJobStates(config.jobs);

		// Re-arm timer to pick up changes immediately
		if (this.running) {
			if (this.timer) clearTimeout(this.timer);
			this.armTimer();
		}
	}

	/** Manual trigger from /run_* command. Looks up job by name. */
	async runJob(
		jobName: string,
		opts?: CronRunOptions,
	): Promise<{ found: boolean; busy?: boolean; error?: string }> {
		const config = this.opts.getCronConfig();
		const job = config.jobs.find((j) => j.name === jobName);
		if (!job) return { found: false };

		if (this.activeJobs.has(job.id)) {
			return { found: true, busy: true };
		}

		// Run async — don't block the caller beyond the initial check
		this.executeWithGuard(job, { ...opts, manual: true });
		return { found: true };
	}

	// -----------------------------------------------------------------------
	// Timer loop
	// -----------------------------------------------------------------------

	private armTimer(): void {
		if (!this.running) return;

		const config = this.opts.getCronConfig();
		const now = Date.now();
		let soonest = now + MAX_TIMER_DELAY_MS;

		for (const job of config.jobs) {
			if (!this.isJobEnabled(job)) continue;
			const state = this.opts.stateStore.get(job.id);
			if (state?.nextRunAtMs && state.nextRunAtMs < soonest) {
				soonest = state.nextRunAtMs;
			}
		}

		const delay = Math.max(0, Math.min(soonest - now, MAX_TIMER_DELAY_MS));
		this.timer = setTimeout(() => this.onTick(), delay);
	}

	private onTick(): void {
		if (!this.running) return;

		const config = this.opts.getCronConfig();
		const now = Date.now();
		const { log, stateStore } = this.opts;
		const stuckTimeoutMs = this.opts.handlerDeps.stuckTimeoutMs;

		for (const job of config.jobs) {
			if (!this.isJobEnabled(job)) continue;

			const state = stateStore.get(job.id);
			if (!state?.nextRunAtMs || state.nextRunAtMs > now) continue;

			// Stuck detection
			if (state.runningAtMs) {
				if (now - state.runningAtMs > stuckTimeoutMs) {
					log.warn(
						{
							job: job.name,
							id: job.id,
							runningForMs: now - state.runningAtMs,
						},
						"clearing stuck cron job",
					);
					stateStore.clearRunning(job.id);
					this.activeJobs.delete(job.id);
				} else {
					log.debug(
						{ job: job.name, id: job.id },
						"cron job still running, skipping tick",
					);
					continue;
				}
			}

			// Concurrency guard
			if (this.activeJobs.has(job.id)) continue;

			this.executeWithGuard(job);
		}

		this.armTimer();
	}

	// -----------------------------------------------------------------------
	// Job execution
	// -----------------------------------------------------------------------

	private executeWithGuard(job: CronJob, opts: CronRunOptions = {}): void {
		if (this.activeJobs.has(job.id)) return;
		this.activeJobs.add(job.id);

		const { stateStore, log } = this.opts;
		stateStore.markRunning(job.id, Date.now());

		executeCronJob(job, this.opts.handlerDeps, opts)
			.then((result) => {
				if (result.status === "error" && this.shouldAutoDisable(job.id)) {
					this.disabledRuntime.add(job.id);
					log.warn({ job: job.name, id: job.id }, "cron job auto-disabled");
				}
			})
			.catch((err) => {
				log.error(
					{ err, job: job.name, id: job.id },
					"unexpected cron execution error",
				);
			})
			.finally(() => {
				stateStore.clearRunning(job.id);
				this.activeJobs.delete(job.id);

				// Compute next run (unless manual trigger)
				if (!opts.manual) {
					this.scheduleNextRun(job);
				}
			});
	}

	private scheduleNextRun(job: CronJob): void {
		const { stateStore } = this.opts;
		const state = stateStore.get(job.id);
		const now = Date.now();

		// Compute natural next run from cron expression
		let nextMs: number;
		try {
			const cron = new Cron(job.schedule, {
				timezone: job.timezone,
			});
			const nextDate = cron.nextRun(new Date(now));
			nextMs = nextDate ? nextDate.getTime() : now + MAX_TIMER_DELAY_MS;
		} catch {
			this.opts.log.error(
				{ job: job.name, id: job.id, schedule: job.schedule },
				"invalid cron expression",
			);
			return;
		}

		// Apply backoff if there are consecutive errors
		const errors = state?.consecutiveErrors ?? 0;
		if (errors > 0) {
			const backoffMs = computeBackoffMs(errors);
			nextMs = Math.max(nextMs, now + backoffMs);
		}

		stateStore.upsert({
			jobId: job.id,
			nextRunAtMs: nextMs,
			lastRunAtMs: state?.lastRunAtMs ?? null,
			lastRunStatus: state?.lastRunStatus ?? null,
			lastError: state?.lastError ?? null,
			lastDurationMs: state?.lastDurationMs ?? null,
			consecutiveErrors: state?.consecutiveErrors ?? 0,
			runningAtMs: null,
			lastFailureAlertAtMs: state?.lastFailureAlertAtMs ?? null,
		});
	}

	// -----------------------------------------------------------------------
	// Initialization + catchup
	// -----------------------------------------------------------------------

	private initializeJobStates(jobs: CronJob[]): void {
		for (const job of jobs) {
			if (!job.enabled) continue;
			const existing = this.opts.stateStore.get(job.id);
			if (!existing) {
				// New job — compute first nextRunAtMs
				const nextMs = this.computeNextRunMs(job);
				if (nextMs) {
					this.opts.stateStore.upsert({
						jobId: job.id,
						nextRunAtMs: nextMs,
						lastRunAtMs: null,
						lastRunStatus: null,
						lastError: null,
						lastDurationMs: null,
						consecutiveErrors: 0,
						runningAtMs: null,
						lastFailureAlertAtMs: null,
					});
				}
			}
		}
	}

	private runStartupCatchup(jobs: CronJob[]): void {
		const now = Date.now();
		const overdue: CronJob[] = [];

		for (const job of jobs) {
			if (!this.isJobEnabled(job)) continue;
			const state = this.opts.stateStore.get(job.id);

			// Clear stale running markers from previous process crash
			if (state?.runningAtMs) {
				this.opts.stateStore.clearRunning(job.id);
			}

			if (state?.nextRunAtMs && state.nextRunAtMs <= now) {
				overdue.push(job);
			}
		}

		if (overdue.length === 0) return;

		this.opts.log.info(
			{ count: overdue.length, jobs: overdue.map((j) => j.name) },
			"startup catchup — running overdue jobs",
		);

		// Run up to STARTUP_MAX_IMMEDIATE immediately, stagger the rest
		for (let i = 0; i < overdue.length; i++) {
			const job = overdue[i];
			if (!job) continue;
			if (i < STARTUP_MAX_IMMEDIATE) {
				this.executeWithGuard(job);
			} else {
				const delay = (i - STARTUP_MAX_IMMEDIATE + 1) * STARTUP_STAGGER_MS;
				setTimeout(() => {
					if (this.running) this.executeWithGuard(job);
				}, delay);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private isJobEnabled(job: CronJob): boolean {
		return job.enabled && !this.disabledRuntime.has(job.id);
	}

	private shouldAutoDisable(jobId: string): boolean {
		const state = this.opts.stateStore.get(jobId);
		return (
			(state?.consecutiveErrors ?? 0) >= this.opts.handlerDeps.autoDisableAfter
		);
	}

	private computeNextRunMs(job: CronJob): number | null {
		try {
			const cron = new Cron(job.schedule, { timezone: job.timezone });
			const next = cron.nextRun(new Date());
			return next ? next.getTime() : null;
		} catch {
			this.opts.log.error(
				{ job: job.name, id: job.id, schedule: job.schedule },
				"invalid cron expression, skipping",
			);
			return null;
		}
	}
}
