import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { BackendId } from "./backend.js";
import { isBackendId } from "./backend.js";

export interface SessionRecord {
	sessionId: string;
	backend: BackendId;
}

export interface SessionStore {
	getSession(conversationId: string): SessionRecord | null;
	setSession(
		conversationId: string,
		sessionId: string,
		backend: BackendId,
	): void;
	deleteSession(conversationId: string): void;
	close(): void;
}

function migrate(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			conversation_id TEXT PRIMARY KEY,
			claude_session_id TEXT NOT NULL,
			backend TEXT NOT NULL DEFAULT 'claude',
			created_at INTEGER NOT NULL DEFAULT (unixepoch()),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch())
		)
	`);
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
		close() {
			db.close();
		},
	};
}
