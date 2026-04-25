import { appendFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

export interface ConversationLogEntry {
	timestamp: string;
	conversationId: string;
	sessionId: string;
	sender: { id: number | null; name: string; username: string | null };
	input: string;
	output: string;
	tools: string[];
	durationMs: number;
	timings: Record<string, number>;
	error: string | null;
}

export interface ConversationLogger {
	log(entry: ConversationLogEntry): void;
}

/** Convert a conversationId to a filesystem-safe directory name. */
export function conversationIdToDir(conversationId: string): string {
	return conversationId.replace(/:/g, "-");
}

function makeFilename(sessionId: string): string {
	const ts = new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "");
	return `${ts}_${sessionId}.jsonl`;
}

export function createConversationLogger(logDir: string): ConversationLogger {
	mkdirSync(logDir, { recursive: true });

	const sessionFiles = new Map<string, string>();

	function resolveFile(sessionId: string, conversationId: string): string {
		const cached = sessionFiles.get(sessionId);
		if (cached) return cached;

		const convDir = join(logDir, conversationIdToDir(conversationId));
		mkdirSync(convDir, { recursive: true });

		// Check disk for existing file (handles restart recovery)
		try {
			const files = readdirSync(convDir);
			const match = files.find((f) => f.endsWith(`_${sessionId}.jsonl`));
			if (match) {
				const filepath = join(convDir, match);
				sessionFiles.set(sessionId, filepath);
				return filepath;
			}
		} catch {
			// Directory might not exist yet on first call
		}

		// Create new file
		const filename = makeFilename(sessionId);
		const filepath = join(convDir, filename);
		sessionFiles.set(sessionId, filepath);
		return filepath;
	}

	return {
		log(entry: ConversationLogEntry): void {
			const filepath = resolveFile(entry.sessionId, entry.conversationId);
			appendFileSync(filepath, `${JSON.stringify(entry)}\n`);
		},
	};
}

/**
 * Migrate flat log files from the old layout into per-conversationId
 * subdirectories.
 *
 * Old: data/conversations/{timestamp}_{channel}_{sessionId}.jsonl
 * New: data/conversations/{channel}/{timestamp}_{sessionId}.jsonl
 */
export function migrateConversationLogs(logDir: string): number {
	mkdirSync(logDir, { recursive: true });

	let migrated = 0;
	const files = readdirSync(logDir);

	for (const file of files) {
		if (!file.endsWith(".jsonl")) continue;

		// Old format: {timestamp}_{channel}_{sessionId}.jsonl
		// The sessionId is a UUID (8-4-4-4-12), so we split from the right.
		const match = file.match(
			/^(\d{8}T\d{6})_(.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/,
		);
		if (!match) continue;

		const [, timestamp, channel, sessionId] = match;
		const destDir = join(logDir, channel as string);
		mkdirSync(destDir, { recursive: true });

		const newFilename = `${timestamp}_${sessionId}.jsonl`;
		const src = join(logDir, file);
		const dest = join(destDir, newFilename);

		renameSync(src, dest);
		migrated++;
	}

	return migrated;
}
