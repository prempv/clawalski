import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { BackendId } from "./backend.js";
import { isBackendId } from "./backend.js";

export interface SessionRecord {
	sessionId: string;
	backend: BackendId;
}

export interface SessionStats {
	conversationId: string;
	backend: BackendId | null;
	claudeSessionId: string | null;
	model: string | null;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCostUsd: number | null;
	turns: number;
	contextWindow: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface StatsUpdate {
	backend?: BackendId | null;
	claudeSessionId?: string | null;
	model?: string | null;
	inputTokens?: number | null;
	outputTokens?: number | null;
	costUsd?: number | null;
	contextWindow?: number | null;
}

export interface SessionStore {
	getSession(conversationId: string): SessionRecord | null;
	setSession(
		conversationId: string,
		sessionId: string,
		backend: BackendId,
	): void;
	deleteSession(conversationId: string): void;
	getStats(conversationId: string): SessionStats | null;
	updateStats(conversationId: string, update: StatsUpdate): void;
	close(): void;
}

function migrate(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			conversation_id TEXT PRIMARY KEY,
			claude_session_id TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_stats (
			conversation_id TEXT PRIMARY KEY,
			claude_session_id TEXT,
			model TEXT,
			total_input_tokens INTEGER NOT NULL DEFAULT 0,
			total_output_tokens INTEGER NOT NULL DEFAULT 0,
			total_cost_usd REAL,
			turns INTEGER NOT NULL DEFAULT 0,
			context_window INTEGER,
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		)
	`);

	const sessionsCols = db
		.prepare("PRAGMA table_info(sessions)")
		.all() as Array<{ name: string }>;
	if (!sessionsCols.some((c) => c.name === "backend")) {
		// Existing rows are Claude — that was the only backend before.
		db.exec(
			"ALTER TABLE sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'claude'",
		);
	}

	const statsCols = db
		.prepare("PRAGMA table_info(session_stats)")
		.all() as Array<{ name: string }>;
	if (!statsCols.some((c) => c.name === "backend")) {
		db.exec("ALTER TABLE session_stats ADD COLUMN backend TEXT");
	}
}

export function createSessionStore(dbPath: string): SessionStore {
	mkdirSync(dirname(dbPath), { recursive: true });

	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	migrate(db);

	const getStmt = db.prepare(
		"SELECT claude_session_id, backend FROM sessions WHERE conversation_id = ?",
	);
	const upsertStmt = db.prepare(`
		INSERT INTO sessions (conversation_id, claude_session_id, backend, created_at, updated_at)
		VALUES (?, ?, ?, unixepoch(), unixepoch())
		ON CONFLICT(conversation_id) DO UPDATE SET
			claude_session_id = excluded.claude_session_id,
			backend = excluded.backend,
			updated_at = unixepoch()
	`);
	const deleteStmt = db.prepare(
		"DELETE FROM sessions WHERE conversation_id = ?",
	);

	const getStatsStmt = db.prepare(
		"SELECT * FROM session_stats WHERE conversation_id = ?",
	);
	const upsertStatsStmt = db.prepare(`
		INSERT INTO session_stats (
			conversation_id, claude_session_id, backend, model,
			total_input_tokens, total_output_tokens, total_cost_usd,
			turns, context_window, created_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch())
		ON CONFLICT(conversation_id) DO UPDATE SET
			claude_session_id = COALESCE(excluded.claude_session_id, session_stats.claude_session_id),
			backend = COALESCE(excluded.backend, session_stats.backend),
			model = COALESCE(excluded.model, session_stats.model),
			total_input_tokens = session_stats.total_input_tokens + excluded.total_input_tokens,
			total_output_tokens = session_stats.total_output_tokens + excluded.total_output_tokens,
			total_cost_usd = COALESCE(excluded.total_cost_usd, session_stats.total_cost_usd),
			turns = session_stats.turns + 1,
			context_window = COALESCE(excluded.context_window, session_stats.context_window),
			updated_at = unixepoch()
	`);

	return {
		getSession(conversationId) {
			const row = getStmt.get(conversationId) as
				| { claude_session_id: string; backend: string }
				| undefined;
			if (!row) return null;
			const backend = isBackendId(row.backend) ? row.backend : "claude";
			return { sessionId: row.claude_session_id, backend };
		},
		setSession(conversationId, sessionId, backend) {
			upsertStmt.run(conversationId, sessionId, backend);
		},
		deleteSession(conversationId) {
			deleteStmt.run(conversationId);
		},
		getStats(conversationId) {
			const row = getStatsStmt.get(conversationId) as
				| {
						conversation_id: string;
						claude_session_id: string | null;
						backend: string | null;
						model: string | null;
						total_input_tokens: number;
						total_output_tokens: number;
						total_cost_usd: number | null;
						turns: number;
						context_window: number | null;
						created_at: number;
						updated_at: number;
				  }
				| undefined;
			if (!row) return null;
			return {
				conversationId: row.conversation_id,
				backend: row.backend && isBackendId(row.backend) ? row.backend : null,
				claudeSessionId: row.claude_session_id,
				model: row.model,
				totalInputTokens: row.total_input_tokens,
				totalOutputTokens: row.total_output_tokens,
				totalCostUsd: row.total_cost_usd,
				turns: row.turns,
				contextWindow: row.context_window,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			};
		},
		updateStats(conversationId, update) {
			upsertStatsStmt.run(
				conversationId,
				update.claudeSessionId ?? null,
				update.backend ?? null,
				update.model ?? null,
				update.inputTokens ?? 0,
				update.outputTokens ?? 0,
				update.costUsd ?? null,
				update.contextWindow ?? null,
			);
		},
		close() {
			db.close();
		},
	};
}
