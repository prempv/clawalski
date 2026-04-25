import type { RelayEvent } from "claude-code-parser";
import type { RequestTimer } from "./request-timer.js";
import type { ContentBlock } from "./types.js";

export type BackendId = "claude" | "codex";

export const BACKEND_IDS: readonly BackendId[] = ["claude", "codex"] as const;

export function isBackendId(value: string): value is BackendId {
	return (BACKEND_IDS as readonly string[]).includes(value);
}

/** Options shared by every backend's CLI subprocess. */
export interface BackendBridgeOptions {
	workingDir: string;
	model?: string;
	systemPrompt?: string;
	/** Absolute path to a conversation-specific log directory (added as --rox in sandbox). */
	conversationHistoryDir?: string;
	/** Absolute path to crons.json — granted --rw in the sandbox so the /cron skill can edit it. */
	cronFilePath?: string;
}

/** Stream event shape exposed to the renderer. Same as Claude's RelayEvent. */
export type BackendStreamEvent = RelayEvent;

/**
 * Per-conversation handle. For Claude this is a literal long-lived
 * subprocess; for Codex it's a thin wrapper that spawns a fresh
 * `codex exec resume` per turn.
 */
export interface ConversationProcess {
	sendMessage(
		content: ContentBlock[],
		timer?: RequestTimer,
	): AsyncIterableIterator<BackendStreamEvent>;
	close(): void;
	readonly alive: boolean;
	readonly sessionId: string | null;
}

/** Persistent-conversation pool. One handle per conversation id. */
export interface BackendPool {
	readonly id: BackendId;
	getOrCreate(
		conversationId: string,
		resumeSessionId: string | null,
		timer?: RequestTimer,
		overrides?: Partial<BackendBridgeOptions>,
	): ConversationProcess;
	remove(conversationId: string): void;
	closeAll(): void;
}

/** Cron pool — every run is a fresh handle keyed by run id, no resume. */
export interface BackendCronPool {
	readonly id: BackendId;
	create(
		runKey: string,
		jobOpts?: Partial<BackendBridgeOptions>,
		timer?: RequestTimer,
	): ConversationProcess;
	remove(runKey: string): void;
	closeAll(): void;
}

export interface BackendRegistry {
	readonly defaultId: BackendId;
	pool(id: BackendId): BackendPool;
	cronPool(id: BackendId): BackendCronPool;
	closeAll(): void;
}

/** Extract a human-readable summary of a tool's input for the activity footer. */
export function summarizeToolInput(toolName: string, input: string): string {
	try {
		const parsed = JSON.parse(input);
		switch (toolName) {
			case "Bash":
				return parsed.description || parsed.command || "";
			case "Read":
			case "Edit":
			case "Write":
				return parsed.file_path || "";
			case "Glob":
			case "Grep":
				return parsed.pattern || "";
			case "WebSearch":
				return parsed.query || "";
			case "WebFetch":
				return parsed.url || "";
			default:
				return "";
		}
	} catch {
		return "";
	}
}
