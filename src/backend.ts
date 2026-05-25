import type { RelayEvent } from "claude-code-parser";
import type { Logger } from "./logger.js";
import type { RequestTimer } from "./request-timer.js";
import type { ContentBlock } from "./types.js";

export type BackendId = "claude" | "claude-v2" | "codex";

export const BACKEND_IDS: readonly BackendId[] = [
	"claude",
	"claude-v2",
	"codex",
] as const;

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
	/** Absolute path for backend-specific runtime state. */
	stateDir?: string;
	/** Optional process logger for backend-specific lifecycle diagnostics. */
	log?: Logger;
}

/** Stream event shape exposed to the renderer. */
export type BackendStreamEvent = RelayEvent;

/**
 * Per-conversation handle. For Claude this is a literal long-lived
 * subprocess; for Codex it's a thin wrapper that spawns a fresh
 * `codex exec resume` per turn.
 *
 * Lifetime model:
 * - `stream()` returns one persistent event stream for the entire process
 *   lifetime. Multiple `sendInput` calls (across multiple user turns and any
 *   CLI-driven auto-continuations) all flow into this single stream. Ends
 *   only when the process closes or dies.
 * - `quiescent` is true when no turn is in flight — last meaningful event
 *   was `turn_complete` and no tool call is open. Use it as the "is the
 *   model busy?" gate for queueing follow-up user inputs.
 * - `onQuiescent(cb)` fires the callback each time we transition into a
 *   quiescent state, so callers can flush a queue without polling.
 */
export interface ConversationProcess {
	stream(): AsyncIterable<BackendStreamEvent>;
	sendInput(content: ContentBlock[], timer?: RequestTimer): void;
	readonly quiescent: boolean;
	onQuiescent(cb: () => void): () => void;
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
