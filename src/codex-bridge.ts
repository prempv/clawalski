import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Interface, createInterface } from "node:readline";
import type {
	BackendBridgeOptions,
	BackendCronPool,
	BackendPool,
	BackendStreamEvent,
	ConversationProcess,
} from "./backend.js";
import type { RequestTimer } from "./request-timer.js";
import type { ContentBlock } from "./types.js";

// ---------------------------------------------------------------------------
// Codex CLI NDJSON event shapes
// ---------------------------------------------------------------------------

interface CodexBaseLine {
	type: string;
}

interface CodexThreadStarted extends CodexBaseLine {
	type: "thread.started";
	thread_id: string;
}

interface CodexTurnCompleted extends CodexBaseLine {
	type: "turn.completed";
	usage?: {
		input_tokens?: number;
		cached_input_tokens?: number;
		output_tokens?: number;
		reasoning_output_tokens?: number;
	};
}

interface CodexAgentMessageItem {
	id: string;
	type: "agent_message";
	text?: string;
}

interface CodexCommandExecutionItem {
	id: string;
	type: "command_execution";
	command: string;
	aggregated_output?: string;
	exit_code?: number | null;
	status?: "in_progress" | "completed";
}

interface CodexReasoningItem {
	id: string;
	type: "reasoning";
	text?: string;
}

type CodexItem =
	| CodexAgentMessageItem
	| CodexCommandExecutionItem
	| CodexReasoningItem
	| { id: string; type: string; [k: string]: unknown };

interface CodexItemEvent extends CodexBaseLine {
	type: "item.started" | "item.updated" | "item.completed";
	item: CodexItem;
}

type CodexLine =
	| CodexThreadStarted
	| CodexTurnCompleted
	| CodexItemEvent
	| CodexBaseLine;

// ---------------------------------------------------------------------------
// EventQueue — same shape as claude-bridge's
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
// CodexProcess — virtual long-lived handle backed by per-turn subprocess
// ---------------------------------------------------------------------------

/**
 * One handle per conversation. Unlike `ClaudeProcess`, Codex's CLI is
 * one-shot — each turn spawns a fresh `codex exec [resume <id>]` and
 * exits. The handle just remembers the thread id between turns.
 */
export class CodexProcess implements ConversationProcess {
	private _sessionId: string | null;
	private _alive = true;
	private opts: BackendBridgeOptions;
	private currentProc: ChildProcess | null = null;
	private currentRl: Interface | null = null;
	/** True until the first turn has been sent — used to inject the system prompt once. */
	private firstTurn: boolean;

	constructor(opts: BackendBridgeOptions, resumeSessionId?: string | null) {
		this.opts = opts;
		this._sessionId = resumeSessionId ?? null;
		// If we're resuming, the system prompt is already baked into the
		// thread on the Codex side and must not be re-sent.
		this.firstTurn = !resumeSessionId;
	}

	sendMessage(
		content: ContentBlock[],
		timer?: RequestTimer,
	): AsyncIterableIterator<BackendStreamEvent> {
		const { promptText, imagePaths } = renderContent(content);

		const promptToSend =
			this.firstTurn && this.opts.systemPrompt
				? `${this.opts.systemPrompt}\n\n${promptText}`
				: promptText;
		this.firstTurn = false;

		const queue = new EventQueue();

		const codexArgs: string[] = [
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
			"--skip-git-repo-check",
			"--json",
			"-C",
			this.opts.workingDir,
		];
		if (this.opts.model) {
			codexArgs.push("-m", this.opts.model);
		}
		for (const p of imagePaths) {
			codexArgs.push("-i", p);
		}
		if (this._sessionId) {
			codexArgs.push("resume", this._sessionId, promptToSend);
		} else {
			codexArgs.push(promptToSend);
		}

		const homeDir = process.env.HOME ?? "/home/dev";
		const nodeBinDir = dirname(process.execPath);
		const pathParts = (process.env.PATH ?? "").split(":");
		const sandboxPath = pathParts.includes(nodeBinDir)
			? process.env.PATH
			: `${nodeBinDir}:${process.env.PATH ?? ""}`;
		const envArgs = Object.entries({ ...process.env, PATH: sandboxPath })
			.filter(([, v]) => v !== undefined)
			.flatMap(([k, v]) => ["--env", `${k}=${v}`]);

		if (this.opts.conversationHistoryDir) {
			mkdirSync(this.opts.conversationHistoryDir, { recursive: true });
		}

		const landrunArgs = [
			"--rox",
			"/",
			"--rw",
			this.opts.workingDir,
			"--rw",
			"/tmp",
			// Codex stores auth, session rollouts, and shell snapshots here.
			"--rw",
			`${homeDir}/.codex`,
			"--rw",
			"/dev/null",
			...(this.opts.conversationHistoryDir
				? ["--rox", this.opts.conversationHistoryDir]
				: []),
			...(this.opts.cronFilePath ? ["--rw", this.opts.cronFilePath] : []),
			"--unrestricted-network",
			...envArgs,
			"--",
			"codex",
			...codexArgs,
		];

		timer?.mark("message_sent");
		const proc = spawn("landrun", landrunArgs, {
			cwd: this.opts.workingDir,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.currentProc = proc;

		let stderr = "";
		let firstEventMarked = false;
		let turnCompleted = false;

		proc.on("error", (err: NodeJS.ErrnoException) => {
			stderr += `failed to spawn landrun: ${err.code ?? ""} ${err.message}\n`;
		});

		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		const rl = createInterface({
			input: proc.stdout as NodeJS.ReadableStream,
		});
		this.currentRl = rl;

		rl.on("line", (line) => {
			// Codex prints a banner on stdout before any JSON. Filter it.
			if (line.startsWith("Reading additional input")) return;
			if (!line.startsWith("{")) return;

			let parsed: CodexLine;
			try {
				parsed = JSON.parse(line) as CodexLine;
			} catch {
				return;
			}

			if (!firstEventMarked) {
				firstEventMarked = true;
				timer?.mark("first_event");
			}

			switch (parsed.type) {
				case "thread.started":
					this._sessionId = (parsed as CodexThreadStarted).thread_id;
					break;
				case "item.started":
				case "item.updated":
				case "item.completed":
					translateItem(parsed as CodexItemEvent, queue);
					break;
				case "turn.completed": {
					turnCompleted = true;
					const usage = (parsed as CodexTurnCompleted).usage ?? {};
					queue.push({
						type: "turn_complete",
						sessionId: this._sessionId ?? undefined,
						inputTokens: usage.input_tokens,
						outputTokens: usage.output_tokens,
					});
					break;
				}
			}
		});

		proc.on("close", (code) => {
			this.currentProc = null;
			this.currentRl = null;
			if (!turnCompleted) {
				if (code !== 0 && code !== null) {
					queue.push({
						type: "error",
						message: stderr.trim() || `codex CLI exited with code ${code}`,
						sessionId: this._sessionId ?? undefined,
					});
				} else {
					// Clean exit but no turn.completed — surface as interrupted.
					queue.push({
						type: "error",
						message: "codex CLI exited without completing the turn",
						sessionId: this._sessionId ?? undefined,
					});
				}
			}
			queue.end();
		});

		return queue;
	}

	close(): void {
		if (!this._alive) return;
		this._alive = false;
		if (this.currentProc) {
			try {
				this.currentProc.kill("SIGTERM");
			} catch {
				// already dead
			}
		}
		if (this.currentRl) {
			this.currentRl.close();
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
// Item translation — Codex items → BackendStreamEvents
// ---------------------------------------------------------------------------

function translateItem(parsed: CodexItemEvent, queue: EventQueue): void {
	const item = parsed.item;
	switch (item.type) {
		case "command_execution": {
			const cmd = item as CodexCommandExecutionItem;
			if (parsed.type === "item.started") {
				queue.push({
					type: "tool_use",
					toolUseId: cmd.id,
					toolName: "Bash",
					input: JSON.stringify({
						command: cmd.command,
						description: cmd.command,
					}),
				});
			} else if (parsed.type === "item.completed") {
				const exitCode = cmd.exit_code ?? 0;
				queue.push({
					type: "tool_result",
					toolUseId: cmd.id,
					output: cmd.aggregated_output ?? "",
					isError: exitCode !== 0,
				});
			}
			break;
		}
		case "agent_message": {
			if (parsed.type !== "item.completed") break;
			const msg = item as CodexAgentMessageItem;
			const text = msg.text ?? "";
			if (text) {
				// Codex emits whole messages; the renderer accumulates these as
				// if they were per-token deltas. Trailing newline keeps multi-
				// message turns from running together on one visual line.
				queue.push({ type: "text_delta", content: `${text}\n` });
			}
			break;
		}
		case "reasoning": {
			if (parsed.type !== "item.completed") break;
			const r = item as CodexReasoningItem;
			if (r.text) {
				queue.push({ type: "thinking_delta", content: r.text });
			}
			break;
		}
	}
}

// ---------------------------------------------------------------------------
// Content block rendering — Codex takes prompt+image-paths, not blocks
// ---------------------------------------------------------------------------

const CODEX_IMAGE_DIR = join(tmpdir(), "tg-codex-images");

function renderContent(content: ContentBlock[]): {
	promptText: string;
	imagePaths: string[];
} {
	const textParts: string[] = [];
	const imagePaths: string[] = [];

	for (const block of content) {
		if (block.type === "text") {
			textParts.push(block.text);
		} else if (block.type === "image") {
			mkdirSync(CODEX_IMAGE_DIR, { recursive: true });
			const ext = block.source.media_type.includes("png") ? "png" : "jpg";
			const filename = `${randomUUID()}.${ext}`;
			const filepath = join(CODEX_IMAGE_DIR, filename);
			writeFileSync(filepath, Buffer.from(block.source.data, "base64"));
			imagePaths.push(filepath);
		}
	}

	const promptText = textParts.join("\n\n").trim();
	// Codex requires a non-empty prompt; if only images were sent, give a
	// minimal directive so the model knows what to do.
	return {
		promptText: promptText || "Describe the attached image(s).",
		imagePaths,
	};
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

export class CodexProcessPool implements BackendPool {
	readonly id = "codex" as const;
	private processes = new Map<string, CodexProcess>();
	private opts: BackendBridgeOptions;

	constructor(opts: BackendBridgeOptions) {
		this.opts = opts;
	}

	getOrCreate(
		conversationId: string,
		resumeSessionId: string | null,
		timer?: RequestTimer,
		overrides?: Partial<BackendBridgeOptions>,
	): CodexProcess {
		const existing = this.processes.get(conversationId);
		if (existing?.alive) {
			timer?.mark("process_reused");
			return existing;
		}
		if (existing) this.processes.delete(conversationId);

		timer?.mark("process_spawned");
		const opts = overrides ? mergeOpts(this.opts, overrides) : this.opts;
		const proc = new CodexProcess(opts, resumeSessionId);
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

export class CodexCronProcessPool implements BackendCronPool {
	readonly id = "codex" as const;
	private processes = new Map<string, CodexProcess>();
	private defaultOpts: BackendBridgeOptions;

	constructor(defaultOpts: BackendBridgeOptions) {
		this.defaultOpts = defaultOpts;
	}

	create(
		runKey: string,
		jobOpts?: Partial<BackendBridgeOptions>,
		timer?: RequestTimer,
	): CodexProcess {
		const opts = jobOpts
			? { ...this.defaultOpts, ...stripNulls(jobOpts) }
			: this.defaultOpts;

		timer?.mark("cron_process_spawned");
		const proc = new CodexProcess(opts);
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
