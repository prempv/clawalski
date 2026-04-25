import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Interface, createInterface } from "node:readline";
import { Translator, parseLine } from "claude-code-parser";
import type {
	BackendBridgeOptions,
	BackendCronPool,
	BackendPool,
	BackendStreamEvent,
	ConversationProcess,
} from "./backend.js";
import type { Logger } from "./logger.js";
import type { RequestTimer } from "./request-timer.js";
import type { ContentBlock } from "./types.js";

/** @deprecated use BackendStreamEvent. Kept for back-compat with tests. */
export type ClaudeStreamEvent = BackendStreamEvent;

/** Raw SSE event embedded inside a stream_event NDJSON line. */
interface StreamEventDelta {
	type: string;
	text?: string;
	thinking?: string;
	partial_json?: string;
}

interface StreamEventContentBlock {
	type: string;
	id?: string;
	name?: string;
}

interface StreamEventInner {
	type: string;
	content_block?: StreamEventContentBlock;
	delta?: StreamEventDelta;
	index?: number;
}

/** The NDJSON line shape for `type: "stream_event"` entries. */
interface StreamEventLine {
	type: "stream_event";
	event: StreamEventInner;
	session_id?: string;
}

/** @deprecated use BackendBridgeOptions from ./backend.js. Kept as an alias. */
export type ClaudeBridgeOptions = BackendBridgeOptions;

const DEFAULT_SYSTEM_PROMPT =
	"You are responding via a Telegram bot. Be concise and direct. Do not quote the user's message back to them. Do not use markdown headers. Keep responses short unless the task requires detail.";

// ---------------------------------------------------------------------------
// EventQueue — async iterable that bridges push (line handler) → pull (for-await)
// ---------------------------------------------------------------------------

class EventQueue implements AsyncIterableIterator<BackendStreamEvent> {
	private buffer: BackendStreamEvent[] = [];
	private waiting:
		| ((result: IteratorResult<BackendStreamEvent>) => void)
		| null = null;
	private ended = false;

	push(event: BackendStreamEvent): void {
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({ value: event, done: false });
		} else {
			this.buffer.push(event);
		}
	}

	end(): void {
		this.ended = true;
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({
				value: undefined as unknown as BackendStreamEvent,
				done: true,
			});
		}
	}

	next(): Promise<IteratorResult<BackendStreamEvent>> {
		if (this.buffer.length > 0) {
			return Promise.resolve({
				value: this.buffer.shift() as BackendStreamEvent,
				done: false,
			});
		}
		if (this.ended) {
			return Promise.resolve({
				value: undefined as unknown as BackendStreamEvent,
				done: true,
			});
		}
		return new Promise((resolve) => {
			this.waiting = resolve;
		});
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<BackendStreamEvent> {
		return this;
	}
}

// ---------------------------------------------------------------------------
// ClaudeProcess — persistent CLI subprocess accepting multiple turns via stdin
// ---------------------------------------------------------------------------

export class ClaudeProcess implements ConversationProcess {
	private proc: ChildProcess;
	private rl: Interface;
	private translator = new Translator();
	private streamParser = new StreamEventParser();
	private queue: EventQueue | null = null;
	private _sessionId: string | null = null;
	private _alive = true;
	private stderr = "";
	private turnTimer: RequestTimer | null = null;
	private firstEventMarked = false;

	constructor(opts: BackendBridgeOptions, resumeSessionId?: string | null) {
		const args = [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--dangerously-skip-permissions",
		];

		if (resumeSessionId) {
			args.push("--resume", resumeSessionId);
		}
		if (opts.model) {
			args.push("--model", opts.model);
		}
		const systemPrompt =
			opts.systemPrompt !== undefined
				? opts.systemPrompt
				: DEFAULT_SYSTEM_PROMPT;
		if (systemPrompt) {
			args.push("--append-system-prompt", systemPrompt);
		}

		const settings = JSON.stringify({
			permissions: {
				allow: [
					"Bash",
					"Read",
					"Edit",
					"Write",
					"Glob",
					"Grep",
					"WebSearch",
					"WebFetch",
				],
			},
		});
		args.push("--settings", settings);

		// Use landrun (Landlock) for filesystem-only sandboxing.
		// Claude's built-in sandbox bundles an MITM network proxy that breaks
		// Go-based CLIs (gh, terraform). Landrun gives us kernel-enforced
		// filesystem restrictions without touching network traffic.
		const homeDir = process.env.HOME ?? "/home/dev";

		// Ensure the directory of the running node binary is on PATH so that
		// sibling npm-installed CLIs (e.g. agent-browser) are available inside
		// the sandbox. Systemd services don't source shell profiles, so NVM's
		// bin dir is typically missing from the inherited PATH.
		const nodeBinDir = dirname(process.execPath);
		const pathParts = (process.env.PATH ?? "").split(":");
		const sandboxPath = pathParts.includes(nodeBinDir)
			? process.env.PATH
			: `${nodeBinDir}:${process.env.PATH ?? ""}`;

		const envArgs = Object.entries({ ...process.env, PATH: sandboxPath })
			.filter(([, v]) => v !== undefined)
			.flatMap(([k, v]) => ["--env", `${k}=${v}`]);

		// Ensure conversation history dir exists — landrun requires paths to
		// exist when applying Landlock rules.
		if (opts.conversationHistoryDir) {
			mkdirSync(opts.conversationHistoryDir, { recursive: true });
		}

		const landrunArgs = [
			"--rox",
			"/",
			"--rw",
			opts.workingDir,
			"--rw",
			"/tmp",
			"--rw",
			`${homeDir}/.claude`,
			// /dev/null must be writable — git, gh, and many CLI tools write to
			// it and fail inside the sandbox without this.
			"--rw",
			"/dev/null",
			// Conversation history dir is read-only so Claude can reference
			// past interactions without being able to modify logs.
			...(opts.conversationHistoryDir
				? ["--rox", opts.conversationHistoryDir]
				: []),
			// Grant write access to the cron config file so the /cron skill
			// can add/edit/remove jobs. Narrow grant — not the whole data dir.
			...(opts.cronFilePath ? ["--rw", opts.cronFilePath] : []),
			"--unrestricted-network",
			...envArgs,
			"--",
			"claude",
			...args,
		];

		this.proc = spawn("landrun", landrunArgs, {
			cwd: opts.workingDir,
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Capture spawn failures (e.g. landrun missing from PATH) as stderr so
		// the close handler below surfaces them as a normal queue error rather
		// than crashing the Node process with an unhandled 'error' event.
		this.proc.on("error", (err: NodeJS.ErrnoException) => {
			this.stderr += `failed to spawn landrun: ${err.code ?? ""} ${err.message}\n`;
		});

		this.proc.stderr?.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString();
		});

		this.rl = createInterface({
			input: this.proc.stdout as NodeJS.ReadableStream,
		});
		this.rl.on("line", (line) => this.handleLine(line));

		this.proc.on("close", (code) => {
			this._alive = false;
			if (this.queue) {
				if (code !== 0 && code !== null) {
					this.queue.push({
						type: "error",
						message:
							this.stderr.trim() || `Claude CLI exited with code ${code}`,
					});
				}
				this.queue.end();
				this.queue = null;
			}
		});
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		if (!this.queue) return;

		const parsed = parseLine(line);
		if (!parsed) return;

		if (!this.firstEventMarked) {
			this.firstEventMarked = true;
			this.turnTimer?.mark("first_event");
		}

		// stream_event carries real-time incremental deltas
		if (parsed.type === "stream_event") {
			const events = this.streamParser.process(
				parsed as unknown as StreamEventLine,
			);
			for (const ev of events) {
				this.queue.push(ev);
			}
			return;
		}

		// Skip assistant cumulative snapshots
		if (parsed.type === "assistant") return;

		// Use Translator for system, result, user events
		const events = this.translator.translate(parsed);
		for (const event of events) {
			this.queue.push(event);

			// turn_complete or error signals end of this turn
			if (event.type === "turn_complete") {
				if (event.sessionId) this._sessionId = event.sessionId;
				this.queue.end();
				this.queue = null;
				return;
			}
			if (event.type === "error") {
				if ("sessionId" in event && event.sessionId) {
					this._sessionId = event.sessionId as string;
				}
				this.queue.end();
				this.queue = null;
				return;
			}
		}
	}

	sendMessage(
		content: ContentBlock[],
		timer?: RequestTimer,
	): AsyncIterableIterator<BackendStreamEvent> {
		this.turnTimer = timer ?? null;
		this.firstEventMarked = false;
		// Fresh parsers per turn to avoid state leakage
		this.translator = new Translator();
		this.streamParser = new StreamEventParser();

		const queue = new EventQueue();
		this.queue = queue;

		timer?.mark("message_sent");

		const msg = JSON.stringify({
			type: "user",
			session_id: "",
			message: {
				role: "user",
				content,
			},
			parent_tool_use_id: null,
		});
		this.proc.stdin?.write(`${msg}\n`);

		return queue;
	}

	close(): void {
		if (this._alive) {
			this.proc.stdin?.end();
		}
	}

	get alive(): boolean {
		return this._alive;
	}

	get sessionId(): string | null {
		return this._sessionId;
	}
}

// ---------------------------------------------------------------------------
// ProcessPool — one persistent process per conversation
// ---------------------------------------------------------------------------

export class ProcessPool implements BackendPool {
	readonly id = "claude" as const;
	private processes = new Map<string, ClaudeProcess>();
	private opts: BackendBridgeOptions;

	constructor(opts: BackendBridgeOptions) {
		this.opts = opts;
	}

	getOrCreate(
		conversationId: string,
		resumeSessionId: string | null,
		timer?: RequestTimer,
		overrides?: Partial<BackendBridgeOptions>,
	): ClaudeProcess {
		const existing = this.processes.get(conversationId);
		if (existing?.alive) {
			timer?.mark("process_reused");
			return existing;
		}

		// Clean up dead process reference
		if (existing) this.processes.delete(conversationId);

		timer?.mark("process_spawned");
		const opts = overrides ? mergeOpts(this.opts, overrides) : this.opts;
		const proc = new ClaudeProcess(opts, resumeSessionId);
		this.processes.set(conversationId, proc);
		return proc;
	}

	remove(conversationId: string): void {
		const proc = this.processes.get(conversationId);
		if (proc) {
			proc.close();
			this.processes.delete(conversationId);
		}
	}

	closeAll(): void {
		for (const proc of this.processes.values()) {
			proc.close();
		}
		this.processes.clear();
	}
}

// ---------------------------------------------------------------------------
// Auth-retry wrapper for OAuth token refresh races
// ---------------------------------------------------------------------------

const AUTH_ERROR_PATTERN =
	/API Error: 401|authentication_error|Invalid authentication/i;

export function isAuthError(message: string): boolean {
	return AUTH_ERROR_PATTERN.test(message);
}

/**
 * Turn a Claude CLI subprocess invocation into a stream of events, with a
 * single transparent retry if the first attempt fails with an OAuth 401.
 *
 * Background: the `claude` CLI reads `~/.claude/.credentials.json` on
 * startup. If the cached access token has just expired, the subprocess
 * hits a 401 against the Anthropic API, prints an auth error, and exits.
 * A concurrent CLI instance usually refreshes the token to disk within a
 * few seconds; spawning another subprocess after a brief pause typically
 * picks up the fresh credentials. We try up to twice more with a short
 * then longer delay, since the refresh window can occasionally run past
 * a single 2-second wait.
 *
 * Events are buffered until we either (a) see the first user-visible
 * output — `text_delta`, `tool_use`, `tool_result`, or `turn_complete` —
 * at which point we're committed and stream through untouched, or (b)
 * see an `error` event. An auth error on the first attempt triggers a
 * respawn; anything else is yielded normally.
 */
export interface AuthRetryOptions {
	/** Max total attempts including the first. Default 3 (two retries). */
	maxAttempts?: number;
	/**
	 * Delays before each retry attempt, in milliseconds. Index 0 is the
	 * wait before attempt 2, index 1 before attempt 3, etc. If the list
	 * is shorter than `maxAttempts - 1`, the last value is reused.
	 * Default [2000, 5000] — catches short races fast, then gives a
	 * slower token refresh time to land.
	 */
	retryDelaysMs?: number[];
}

/** Minimal surface we need from ClaudeProcess — keeps this testable. */
export interface ClaudeProcessLike {
	sendMessage(
		content: ContentBlock[],
		timer?: RequestTimer,
	): AsyncIterable<BackendStreamEvent>;
}

export async function* sendMessageWithAuthRetry(
	spawnProcess: () => ClaudeProcessLike,
	removeProcess: () => void,
	content: ContentBlock[],
	timer: RequestTimer | undefined,
	log: Logger,
	options: AuthRetryOptions = {},
): AsyncGenerator<BackendStreamEvent> {
	const maxAttempts = options.maxAttempts ?? 3;
	const retryDelaysMs = options.retryDelaysMs ?? [2_000, 5_000];

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (attempt > 1) {
			removeProcess();
			const delayIdx = Math.min(attempt - 2, retryDelaysMs.length - 1);
			const delay = retryDelaysMs[delayIdx] ?? 0;
			if (delay > 0) {
				await new Promise((r) => setTimeout(r, delay));
			}
		}

		const proc = spawnProcess();
		const iter = proc.sendMessage(content, timer)[Symbol.asyncIterator]();

		const buffered: BackendStreamEvent[] = [];
		let retry = false;
		let committed = false;

		while (true) {
			const res = await iter.next();
			if (res.done) break;
			const ev = res.value;

			if (
				ev.type === "text_delta" ||
				ev.type === "tool_use" ||
				ev.type === "tool_result" ||
				ev.type === "turn_complete"
			) {
				buffered.push(ev);
				committed = true;
				break;
			}

			if (ev.type === "error") {
				if (attempt < maxAttempts && isAuthError(ev.message)) {
					retry = true;
					log.warn(
						{ attempt, error: ev.message.slice(0, 200) },
						"claude CLI auth 401 — respawning and retrying once",
					);
					break;
				}
				buffered.push(ev);
				break;
			}

			buffered.push(ev);
		}

		if (retry) continue;

		for (const ev of buffered) yield ev;
		if (committed) {
			while (true) {
				const res = await iter.next();
				if (res.done) return;
				yield res.value;
			}
		}
		return;
	}
}

// ---------------------------------------------------------------------------
// StreamEventParser (unchanged)
// ---------------------------------------------------------------------------

/**
 * Stateful parser for `stream_event` envelopes from Claude Code.
 *
 * Claude Code wraps the raw Anthropic SSE protocol in `stream_event`
 * NDJSON lines.  The inner `event` object carries real-time deltas:
 *
 * - `content_block_start`  → begins a text, thinking, or tool_use block
 * - `content_block_delta`  → text_delta, thinking_delta, or input_json_delta
 * - `content_block_stop`   → ends the current block; for tool_use we emit
 *                            the complete tool_use event with accumulated input
 *
 * State is needed to accumulate `input_json_delta` fragments into a
 * complete tool input JSON string before emitting the tool_use event.
 */
class StreamEventParser {
	private pendingToolUseId = "";
	private pendingToolName = "";
	private pendingToolInput = "";

	process(raw: StreamEventLine): BackendStreamEvent[] {
		const event = raw.event;
		if (!event) return [];

		switch (event.type) {
			case "content_block_start": {
				const block = event.content_block;
				if (block?.type === "tool_use") {
					this.pendingToolUseId = block.id ?? "";
					this.pendingToolName = block.name ?? "";
					this.pendingToolInput = "";
				}
				return [];
			}

			case "content_block_delta": {
				const delta = event.delta;
				if (!delta) return [];

				if (delta.type === "text_delta") {
					return [{ type: "text_delta", content: delta.text ?? "" }];
				}
				if (delta.type === "thinking_delta") {
					return [{ type: "thinking_delta", content: delta.thinking ?? "" }];
				}
				if (delta.type === "input_json_delta" && this.pendingToolName) {
					this.pendingToolInput += delta.partial_json ?? "";
				}
				return [];
			}

			case "content_block_stop": {
				// If we were accumulating a tool_use block, emit it now with full input
				if (this.pendingToolName) {
					const ev: BackendStreamEvent = {
						type: "tool_use",
						toolUseId: this.pendingToolUseId,
						toolName: this.pendingToolName,
						input: this.pendingToolInput,
					};
					this.pendingToolUseId = "";
					this.pendingToolName = "";
					this.pendingToolInput = "";
					return [ev];
				}
				return [];
			}

			default:
				return [];
		}
	}
}

function mergeOpts(
	base: BackendBridgeOptions,
	overrides: Partial<BackendBridgeOptions>,
): BackendBridgeOptions {
	const result = { ...base };
	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) {
			(result as Record<string, unknown>)[key] = value;
		}
	}
	return result;
}

// summarizeToolInput moved to ./backend.js (it's used by both backends).
export { summarizeToolInput } from "./backend.js";
