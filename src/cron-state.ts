import type Database from "better-sqlite3";

export interface CronJobState {
	jobId: string;
	nextRunAtMs: number | null;
	lastRunAtMs: number | null;
	lastRunStatus: "ok" | "error" | "skipped" | null;
	lastError: string | null;
	lastDurationMs: number | null;
	consecutiveErrors: number;
	runningAtMs: number | null;
	lastFailureAlertAtMs: number | null;
}

export interface CronStateStore {
	get(jobId: string): CronJobState | null;
	getAll(): CronJobState[];
	upsert(state: CronJobState): void;
	markRunning(jobId: string, nowMs: number): void;
	clearRunning(jobId: string): void;
	delete(jobId: string): void;
}

export function createCronStateStore(db: Database.Database): CronStateStore {
	db.exec(`
		CREATE TABLE IF NOT EXISTS cron_jobs_state (
			job_id TEXT PRIMARY KEY,
			next_run_at_ms INTEGER,
			last_run_at_ms INTEGER,
			last_run_status TEXT,
			last_error TEXT,
			last_duration_ms INTEGER,
			consecutive_errors INTEGER NOT NULL DEFAULT 0,
			running_at_ms INTEGER,
			last_failure_alert_at_ms INTEGER,
			updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
		)
	`);

	const getStmt = db.prepare("SELECT * FROM cron_jobs_state WHERE job_id = ?");

	const getAllStmt = db.prepare("SELECT * FROM cron_jobs_state");

	const upsertStmt = db.prepare(`
		INSERT INTO cron_jobs_state (
			job_id, next_run_at_ms, last_run_at_ms, last_run_status,
			last_error, last_duration_ms, consecutive_errors,
			running_at_ms, last_failure_alert_at_ms, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch() * 1000)
		ON CONFLICT(job_id) DO UPDATE SET
			next_run_at_ms = excluded.next_run_at_ms,
			last_run_at_ms = excluded.last_run_at_ms,
			last_run_status = excluded.last_run_status,
			last_error = excluded.last_error,
			last_duration_ms = excluded.last_duration_ms,
			consecutive_errors = excluded.consecutive_errors,
			running_at_ms = excluded.running_at_ms,
			last_failure_alert_at_ms = excluded.last_failure_alert_at_ms,
			updated_at = unixepoch() * 1000
	`);

	const markRunningStmt = db.prepare(`
		UPDATE cron_jobs_state SET running_at_ms = ?, updated_at = unixepoch() * 1000
		WHERE job_id = ?
	`);

	const clearRunningStmt = db.prepare(`
		UPDATE cron_jobs_state SET running_at_ms = NULL, updated_at = unixepoch() * 1000
		WHERE job_id = ?
	`);

	const deleteStmt = db.prepare("DELETE FROM cron_jobs_state WHERE job_id = ?");

	function rowToState(row: Record<string, unknown>): CronJobState {
		return {
			jobId: row.job_id as string,
			nextRunAtMs: (row.next_run_at_ms as number) ?? null,
			lastRunAtMs: (row.last_run_at_ms as number) ?? null,
			lastRunStatus:
				(row.last_run_status as CronJobState["lastRunStatus"]) ?? null,
			lastError: (row.last_error as string) ?? null,
			lastDurationMs: (row.last_duration_ms as number) ?? null,
			consecutiveErrors: (row.consecutive_errors as number) ?? 0,
			runningAtMs: (row.running_at_ms as number) ?? null,
			lastFailureAlertAtMs: (row.last_failure_alert_at_ms as number) ?? null,
		};
	}

	return {
		get(jobId) {
			const row = getStmt.get(jobId) as Record<string, unknown> | undefined;
			return row ? rowToState(row) : null;
		},

		getAll() {
			const rows = getAllStmt.all() as Record<string, unknown>[];
			return rows.map(rowToState);
		},

		upsert(state) {
			upsertStmt.run(
				state.jobId,
				state.nextRunAtMs,
				state.lastRunAtMs,
				state.lastRunStatus,
				state.lastError,
				state.lastDurationMs,
				state.consecutiveErrors,
				state.runningAtMs,
				state.lastFailureAlertAtMs,
			);
		},

		markRunning(jobId, nowMs) {
			markRunningStmt.run(nowMs, jobId);
		},

		clearRunning(jobId) {
			clearRunningStmt.run(jobId);
		},

		delete(jobId) {
			deleteStmt.run(jobId);
		},
	};
}
