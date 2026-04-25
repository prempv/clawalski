import type { BackendBridgeOptions, BackendCronPool } from "./backend.js";
import { ClaudeProcess } from "./claude-bridge.js";
import type { RequestTimer } from "./request-timer.js";

/**
 * Separate process pool for cron jobs. Each invocation gets a fresh
 * ClaudeProcess (no session resume). Per-job bridge options are supported.
 */
export class CronProcessPool implements BackendCronPool {
	readonly id = "claude" as const;
	private processes = new Map<string, ClaudeProcess>();
	private defaultOpts: BackendBridgeOptions;

	constructor(defaultOpts: BackendBridgeOptions) {
		this.defaultOpts = defaultOpts;
	}

	create(
		runKey: string,
		jobOpts?: Partial<BackendBridgeOptions>,
		timer?: RequestTimer,
	): ClaudeProcess {
		const opts = jobOpts
			? { ...this.defaultOpts, ...stripNulls(jobOpts) }
			: this.defaultOpts;

		timer?.mark("cron_process_spawned");
		const proc = new ClaudeProcess(opts);
		this.processes.set(runKey, proc);
		return proc;
	}

	remove(runKey: string): void {
		const proc = this.processes.get(runKey);
		if (proc) {
			proc.close();
			this.processes.delete(runKey);
		}
	}

	closeAll(): void {
		for (const proc of this.processes.values()) {
			proc.close();
		}
		this.processes.clear();
	}
}

function stripNulls(
	obj: Partial<BackendBridgeOptions>,
): Partial<BackendBridgeOptions> {
	const result: Partial<BackendBridgeOptions> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value != null) {
			(result as Record<string, unknown>)[key] = value;
		}
	}
	return result;
}
