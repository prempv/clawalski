import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	type Dirent,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type {
	BackendBridgeOptions,
	BackendPool,
	BackendStreamEvent,
	ConversationProcess,
} from "./backend.js";
import { EventQueue } from "./claude-bridge.js";
import type { Logger } from "./logger.js";
import { redactedPreview } from "./redaction.js";
import type { RequestTimer } from "./request-timer.js";
import type { ContentBlock } from "./types.js";

const DEFAULT_SYSTEM_PROMPT =
	"You are responding via a Telegram bot. Be concise and direct. Do not quote the user's message back to them. Do not use markdown headers. Keep responses short unless the task requires detail.";

const POLL_INTERVAL_MS = 500;
const PROMPT_ACK_TIMEOUT_MS = 20_000;
const LAUNCH_READY_TIMEOUT_MS = 30_000;
const ALIVE_CHECK_INTERVAL_MS = 5_000;
const ENTER_AFTER_PASTE_DELAY_MS = 150;
const CLEAR_INPUT_DELAY_MS = 50;

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface HookRecord {
	event?: string;
	payload?: {
		session_id?: string;
		transcript_path?: string;
		model?: string;
		hook_event_name?: string;
		message?: string;
		notification_type?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

interface TranscriptUsage {
	input_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	output_tokens?: number;
}

interface TranscriptContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	is_error?: boolean;
}

interface TranscriptRecord {
	type?: string;
	uuid?: string;
	sessionId?: string;
	message?: {
		model?: string;
		role?: string;
		content?: string | TranscriptContentBlock[];
		stop_reason?: string | null;
		usage?: TranscriptUsage;
	};
	[key: string]: unknown;
}

interface TurnUsage {
	inputTokens: number;
	outputTokens: number;
}

export function translateTranscriptRecord(
	raw: TranscriptRecord,
): BackendStreamEvent[] {
	const msg = raw.message;
	const events: BackendStreamEvent[] = [];

	if (raw.type === "assistant" && msg?.role === "assistant") {
		const blocks = Array.isArray(msg.content)
			? msg.content
			: typeof msg.content === "string"
				? [{ type: "text", text: msg.content }]
				: [];
		for (const block of blocks) {
			if (block.type === "text" && block.text) {
				events.push({ type: "text_delta", content: block.text });
			} else if (block.type === "thinking" && block.thinking) {
				events.push({ type: "thinking_delta", content: block.thinking });
			} else if (block.type === "tool_use") {
				events.push({
					type: "tool_use",
					toolUseId: block.id ?? "",
					toolName: block.name ?? "unknown",
					input: stringifyToolInput(block.input),
				});
			}
		}
	}

	if (raw.type === "user" && msg?.role === "user") {
		const blocks = Array.isArray(msg.content) ? msg.content : [];
		for (const block of blocks) {
			if (block.type === "tool_result") {
				events.push({
					type: "tool_result",
					toolUseId: block.tool_use_id ?? "",
					output: summarizeToolResult(block.content),
					isError: block.is_error === true,
				});
			}
		}
	}

	return events;
}

export function isIdlePromptNotification(
	payload: HookRecord["payload"] | undefined,
): boolean {
	if (!payload) return false;
	if (payload.notification_type === "idle_prompt") return true;
	return /waiting for your input/i.test(String(payload.message ?? ""));
}

export class ClaudeInteractiveProcess implements ConversationProcess {
	private readonly opts: BackendBridgeOptions;
	private readonly stateDir: string;
	private readonly uploadDir: string;
	private readonly tmuxSession: string;
	private readonly tmuxTarget: string;
	private readonly hookScriptPath: string;
	private readonly hookSettingsPath: string;
	private readonly hookLogPath: string;
	private readonly launcherPath: string;
	private readonly log?: Logger;
	private readonly events = new EventQueue();
	private readonly seenTranscriptUuids = new Set<string>();
	private readonly quiescentListeners = new Set<() => void>();
	private readonly ready: Promise<void>;
	private _sessionId: string | null;
	private _alive = true;
	private active = false;
	private openToolCalls = new Set<string>();
	private transcriptPath: string | null = null;
	private transcriptOffset = 0;
	private hookOffset = 0;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	private lastAliveCheck = 0;
	private turnTimer: RequestTimer | null = null;
	private firstEventMarked = false;
	private promptAckTimer: ReturnType<typeof setTimeout> | null = null;
	private awaitingPromptAck = false;
	private trustPromptAttempts = 0;
	private turnUsage: TurnUsage = { inputTokens: 0, outputTokens: 0 };
	private model: string | null = null;

	constructor(opts: BackendBridgeOptions, resumeSessionId?: string | null) {
		this.opts = opts;
		this._sessionId = resumeSessionId ?? randomUUID();
		const baseStateDir = opts.stateDir ?? join(tmpdir(), "clawalski-claude-v2");
		this.stateDir = join(
			baseStateDir,
			safeName(opts.workingDir, this._sessionId),
		);
		this.uploadDir = join(this.stateDir, "uploads");
		this.tmuxSession = `clawalski-v2-${hashForName(
			`${opts.workingDir}:${this._sessionId}`,
		).slice(0, 18)}`;
		this.tmuxTarget = `${this.tmuxSession}:0.0`;
		this.hookScriptPath = join(this.stateDir, "hook-capture.cjs");
		this.hookSettingsPath = join(this.stateDir, "claude-hooks-settings.json");
		this.hookLogPath = join(this.stateDir, "hooks.jsonl");
		this.launcherPath = join(this.stateDir, "launch-claude.sh");
		this.log = opts.log?.child({
			component: "claude-v2",
			tmuxSession: this.tmuxSession,
		});

		mkdirSync(this.uploadDir, { recursive: true });
		this.writeRuntimeFiles();
		this.hookOffset = fileSize(this.hookLogPath);
		this.startPoller();
		this.log?.info(
			{
				stateDir: this.stateDir,
				hookLogPath: this.hookLogPath,
				resumeSessionId: resumeSessionId ?? null,
			},
			"claude-v2 process initializing",
		);
		this.ready = this.launchOrReuse(resumeSessionId).catch((err) => {
			this.publishTurnFailure(
				`Claude interactive launch failed: ${errMessage(err)}`,
			);
			this._alive = false;
			this.events.end();
			throw err;
		});
		void this.ready.catch(() => {});
	}

	stream(): AsyncIterable<BackendStreamEvent> {
		return this.events;
	}

	sendInput(content: ContentBlock[], timer?: RequestTimer): void {
		if (!this._alive) return;
		this.active = true;
		this.turnTimer = timer ?? null;
		this.firstEventMarked = false;
		this.turnUsage = { inputTokens: 0, outputTokens: 0 };

		void this.inject(content, timer).catch((err) => {
			this.clearPromptAckTimeout();
			this.awaitingPromptAck = false;
			this.publishTurnFailure(
				`Claude interactive input failed: ${errMessage(err)}`,
			);
		});
	}

	get quiescent(): boolean {
		return !this.active && this._alive;
	}

	onQuiescent(cb: () => void): () => void {
		this.quiescentListeners.add(cb);
		return () => {
			this.quiescentListeners.delete(cb);
		};
	}

	close(): void {
		this.detach();
	}

	kill(): void {
		this.detach();
		void runCommand("tmux", ["kill-session", "-t", this.tmuxSession]).catch(
			() => {},
		);
	}

	get alive(): boolean {
		return this._alive;
	}

	get sessionId(): string | null {
		return this._sessionId;
	}

	private async launchOrReuse(resumeSessionId?: string | null): Promise<void> {
		const exists = await tmuxSessionExists(this.tmuxSession);
		if (!exists) {
			const claudeArgs = this.buildClaudeArgs(resumeSessionId);
			this.writeLauncher(claudeArgs);
			this.log?.info(
				{
					resumeSessionId: resumeSessionId ?? null,
					workingDir: this.opts.workingDir,
				},
				"claude-v2 tmux session launching",
			);
			await tmux([
				"new-session",
				"-d",
				"-s",
				this.tmuxSession,
				"-c",
				this.opts.workingDir,
				"-x",
				"120",
				"-y",
				"40",
				shellQuote(this.launcherPath),
			]);
			await tmux([
				"set-option",
				"-t",
				this.tmuxSession,
				"remain-on-exit",
				"on",
			]);
			await tmux([
				"set-option",
				"-t",
				this.tmuxSession,
				"history-limit",
				"50000",
			]);
		} else {
			this.log?.info(
				{ resumeSessionId: resumeSessionId ?? null },
				"claude-v2 tmux session reusing existing pane",
			);
		}

		await this.waitReady();
		this.log?.info(
			{
				sessionId: this._sessionId,
				transcriptPath: this.transcriptPath,
			},
			"claude-v2 process ready",
		);
	}

	private buildClaudeArgs(resumeSessionId?: string | null): string[] {
		const args = ["--dangerously-skip-permissions"];
		if (resumeSessionId) {
			args.push("--resume", resumeSessionId);
		} else if (this._sessionId) {
			args.push("--session-id", this._sessionId);
		}
		if (this.opts.model) {
			args.push("--model", this.opts.model);
		}
		const systemPrompt =
			this.opts.systemPrompt !== undefined
				? this.opts.systemPrompt
				: DEFAULT_SYSTEM_PROMPT;
		if (systemPrompt) {
			args.push("--append-system-prompt", systemPrompt);
		}
		args.push("--settings", this.hookSettingsPath);
		return args;
	}

	private writeRuntimeFiles(): void {
		const hookScript = `#!/usr/bin/env node
const fs = require("node:fs");
const event = process.argv[2] || "unknown";
const logPath = process.argv[3];
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  let payload = null;
  try { payload = stdin.trim() ? JSON.parse(stdin) : null; } catch { payload = { raw: stdin }; }
  try {
    fs.appendFileSync(logPath, JSON.stringify({
      ts: new Date().toISOString(),
      event,
      session: process.env.CLAUDE_SESSION_ID || null,
      cwd: process.cwd(),
      payload,
    }) + "\\n");
  } catch {}
});
process.stdin.resume();
`;
		writeFileSync(this.hookScriptPath, hookScript, { mode: 0o755 });

		const hookEntry = (event: string) => [
			{
				matcher: "",
				hooks: [
					{
						type: "command",
						command: `node ${JSON.stringify(this.hookScriptPath)} ${event} ${JSON.stringify(this.hookLogPath)}`,
						timeout: 5,
					},
				],
			},
		];
		const settings = {
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
			hooks: {
				SessionStart: hookEntry("SessionStart"),
				UserPromptSubmit: hookEntry("UserPromptSubmit"),
				PreToolUse: hookEntry("PreToolUse"),
				PostToolUse: hookEntry("PostToolUse"),
				Notification: hookEntry("Notification"),
				Stop: hookEntry("Stop"),
				StopFailure: hookEntry("StopFailure"),
			},
		};
		writeFileSync(
			this.hookSettingsPath,
			`${JSON.stringify(settings, null, 2)}\n`,
		);
	}

	private writeLauncher(claudeArgs: string[]): void {
		const homeDir = process.env.HOME ?? homedir();
		const nodeBinDir = dirname(process.execPath);
		const pathParts = (process.env.PATH ?? "").split(":");
		const sandboxPath = pathParts.includes(nodeBinDir)
			? process.env.PATH
			: `${nodeBinDir}:${process.env.PATH ?? ""}`;
		const env = { ...process.env, PATH: sandboxPath };
		const envArgs = Object.entries(env)
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
			"--rw",
			this.stateDir,
			"--rw",
			`${homeDir}/.claude`,
			...(existsSync(`${homeDir}/.claude.json`)
				? ["--rw", `${homeDir}/.claude.json`]
				: []),
			"--rw",
			"/dev/null",
			...(this.opts.conversationHistoryDir
				? ["--rox", this.opts.conversationHistoryDir]
				: []),
			...(this.opts.cronFilePath ? ["--rw", this.opts.cronFilePath] : []),
			"--unrestricted-network",
			...envArgs,
			"--",
			"claude",
			...claudeArgs,
		];

		const script = [
			"#!/usr/bin/env bash",
			"set -euo pipefail",
			`cd ${shellQuote(this.opts.workingDir)}`,
			`exec landrun ${landrunArgs.map(shellQuote).join(" ")}`,
			"",
		].join("\n");
		writeFileSync(this.launcherPath, script, { mode: 0o755 });
	}

	private async waitReady(): Promise<void> {
		const deadline = Date.now() + LAUNCH_READY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await this.pollOnce();
			const alive = await this.isTmuxAlive();
			if (!alive) {
				const pane = await this.capturePane().catch(() => "");
				throw new Error(
					`tmux session exited before ready${pane ? `\n${pane}` : ""}`,
				);
			}
			if (await this.maybeAcceptTrustPrompt()) {
				await delay(POLL_INTERVAL_MS);
				continue;
			}
			if (this.transcriptPath) {
				if (await this.startupPromptsCleared()) {
					this.transcriptOffset = fileSize(this.transcriptPath);
					return;
				}
				continue;
			}
			if (this._sessionId) {
				const path = findTranscriptPath(this._sessionId);
				if (path) {
					this.setTranscriptPath(path, true);
					if (await this.startupPromptsCleared()) {
						return;
					}
				}
			}
			await delay(POLL_INTERVAL_MS);
		}
		const pane = await this.capturePane().catch(() => "");
		throw new Error(
			`Claude interactive session was not ready${pane ? `\n${pane}` : ""}`,
		);
	}

	private async startupPromptsCleared(): Promise<boolean> {
		await delay(2_000);
		return !(await this.maybeAcceptTrustPrompt());
	}

	private async maybeAcceptTrustPrompt(): Promise<boolean> {
		const pane = await this.capturePane(40).catch(() => "");
		if (!isTrustPrompt(pane)) return false;
		if (this.trustPromptAttempts < 6) {
			this.trustPromptAttempts += 1;
			await tmux(["send-keys", "-t", this.tmuxTarget, "Enter"]);
			await delay(700);
		}
		return true;
	}

	private startPoller(): void {
		this.pollTimer = setInterval(() => {
			void this.pollOnce().catch((err) => {
				this.log?.warn({ err }, "claude-v2 poll failed");
				this.events.push({
					type: "error",
					message: `Claude interactive watcher failed: ${errMessage(err)}`,
					sessionId: this._sessionId ?? undefined,
				});
			});
		}, POLL_INTERVAL_MS);
	}

	private async pollOnce(): Promise<void> {
		if (!this._alive || this.polling) return;
		this.polling = true;
		try {
			await this.pollHooks();
			await this.flushTranscript();
			if (Date.now() - this.lastAliveCheck > ALIVE_CHECK_INTERVAL_MS) {
				this.lastAliveCheck = Date.now();
				const alive = await this.isTmuxAlive();
				if (!alive && this._alive) {
					const pane = await this.capturePane().catch(() => "");
					this.log?.error(
						{
							sessionId: this._sessionId,
							panePreview: redactedPreview(pane),
						},
						"claude-v2 tmux session ended",
					);
					this._alive = false;
					this.events.push({
						type: "error",
						message: `Claude interactive tmux session ended${pane ? `\n${pane}` : ""}`,
						sessionId: this._sessionId ?? undefined,
					});
					this.events.end();
					this.quiescentListeners.clear();
				}
			}
		} finally {
			this.polling = false;
		}
	}

	private async pollHooks(): Promise<void> {
		if (!existsSync(this.hookLogPath)) return;
		const size = fileSize(this.hookLogPath);
		if (size < this.hookOffset) this.hookOffset = 0;
		if (size === this.hookOffset) return;

		const lines = await readLinesFrom(this.hookLogPath, this.hookOffset, size);
		this.hookOffset = size;
		for (const line of lines) {
			if (!line.trim()) continue;
			let record: HookRecord;
			try {
				record = JSON.parse(line) as HookRecord;
			} catch {
				continue;
			}
			try {
				await this.handleHook(record);
			} catch (err) {
				this.log?.warn({ err }, "claude-v2 hook handling failed");
				this.events.push({
					type: "error",
					message: `Claude interactive hook handling failed: ${errMessage(err)}`,
					sessionId: this._sessionId ?? undefined,
				});
			}
		}
	}

	private async handleHook(record: HookRecord): Promise<void> {
		const payload = record.payload ?? {};
		const eventName = record.event ?? payload.hook_event_name;
		if (payload.session_id) this._sessionId = payload.session_id;
		if (payload.transcript_path) {
			this.setTranscriptPath(payload.transcript_path, !this.active);
		}
		if (payload.model && payload.model !== this.model) {
			this.model = payload.model;
			this.publish({ type: "session_meta", model: payload.model });
		}

		if (eventName === "UserPromptSubmit") {
			this.clearPromptAckTimeout();
			this.awaitingPromptAck = false;
			this.log?.info(
				{
					sessionId: this._sessionId,
					transcriptPath: this.transcriptPath,
				},
				"claude-v2 prompt acknowledged",
			);
			return;
		}

		if (eventName === "Stop") {
			this.log?.info(
				{
					sessionId: this._sessionId,
					transcriptPath: this.transcriptPath,
				},
				"claude-v2 stop hook received",
			);
			await this.completeTurn();
			return;
		}

		if (eventName === "Notification" && isIdlePromptNotification(payload)) {
			this.log?.info(
				{
					sessionId: this._sessionId,
					active: this.active,
					awaitingPromptAck: this.awaitingPromptAck,
					notificationType: payload.notification_type,
				},
				"claude-v2 idle notification received",
			);
			if (this.active || this.awaitingPromptAck) {
				await this.completeTurn();
			}
			return;
		}

		if (eventName === "StopFailure") {
			this.clearPromptAckTimeout();
			this.awaitingPromptAck = false;
			await this.flushTranscript();
			this.log?.warn(
				{
					sessionId: this._sessionId,
					message: payload.message,
				},
				"claude-v2 stop failure hook received",
			);
			this.publishTurnFailure(
				payload.message ? String(payload.message) : "Claude stop hook failed",
			);
		}
	}

	private async completeTurn(): Promise<void> {
		this.clearPromptAckTimeout();
		this.awaitingPromptAck = false;
		await this.flushTranscript();
		await delay(50);
		await this.flushTranscript();
		this.log?.info(
			{
				sessionId: this._sessionId,
				inputTokens: this.turnUsage.inputTokens || null,
				outputTokens: this.turnUsage.outputTokens || null,
				transcriptPath: this.transcriptPath,
			},
			"claude-v2 turn completion publishing",
		);
		this.publish({
			type: "turn_complete",
			sessionId: this._sessionId ?? undefined,
			inputTokens:
				this.turnUsage.inputTokens > 0 ? this.turnUsage.inputTokens : undefined,
			outputTokens:
				this.turnUsage.outputTokens > 0
					? this.turnUsage.outputTokens
					: undefined,
		});
		this.turnUsage = { inputTokens: 0, outputTokens: 0 };
	}

	private setTranscriptPath(path: string, skipExisting: boolean): void {
		if (this.transcriptPath === path) return;
		this.transcriptPath = path;
		this.transcriptOffset = skipExisting ? fileSize(path) : 0;
	}

	private async flushTranscript(): Promise<void> {
		if (!this.transcriptPath || !existsSync(this.transcriptPath)) return;
		const size = fileSize(this.transcriptPath);
		if (size < this.transcriptOffset) {
			this.transcriptOffset = 0;
			this.seenTranscriptUuids.clear();
		}
		if (size === this.transcriptOffset) return;

		const lines = await readLinesFrom(
			this.transcriptPath,
			this.transcriptOffset,
			size,
		);
		this.transcriptOffset = size;
		for (const line of lines) {
			if (!line.trim()) continue;
			let raw: TranscriptRecord;
			try {
				raw = JSON.parse(line) as TranscriptRecord;
			} catch {
				continue;
			}
			if (raw.sessionId) this._sessionId = raw.sessionId;
			if (raw.uuid) {
				if (this.seenTranscriptUuids.has(raw.uuid)) continue;
				this.seenTranscriptUuids.add(raw.uuid);
			}
			this.accumulateUsage(raw);
			const model = raw.message?.model;
			if (model && model !== this.model) {
				this.model = model;
				this.publish({ type: "session_meta", model });
			}
			for (const event of translateTranscriptRecord(raw)) {
				this.publish(event);
			}
		}
	}

	private accumulateUsage(raw: TranscriptRecord): void {
		if (raw.type !== "assistant") return;
		const usage = raw.message?.usage;
		if (!usage) return;
		this.turnUsage.inputTokens +=
			(usage.input_tokens ?? 0) +
			(usage.cache_creation_input_tokens ?? 0) +
			(usage.cache_read_input_tokens ?? 0);
		this.turnUsage.outputTokens += usage.output_tokens ?? 0;
	}

	private async inject(
		content: ContentBlock[],
		timer?: RequestTimer,
	): Promise<void> {
		await this.ready;
		const alive = await this.isTmuxAlive();
		if (!alive) throw new Error(`tmux session missing: ${this.tmuxSession}`);
		const prompt = renderInteractiveContent(content, this.uploadDir);
		const bufferName = `${this.tmuxSession}-input`;
		await tmux(["send-keys", "-t", this.tmuxTarget, "C-u"]);
		await delay(CLEAR_INPUT_DELAY_MS);
		await tmux(["load-buffer", "-b", bufferName, "-"], { input: prompt });
		await tmux(["paste-buffer", "-d", "-b", bufferName, "-t", this.tmuxTarget]);
		await delay(ENTER_AFTER_PASTE_DELAY_MS);
		await tmux(["send-keys", "-t", this.tmuxTarget, "Enter"]);
		this.awaitingPromptAck = true;
		this.armPromptAckTimeout();
		this.log?.info(
			{
				sessionId: this._sessionId,
				promptLen: prompt.length,
				promptPreview: redactedPreview(prompt),
				enterDelayMs: ENTER_AFTER_PASTE_DELAY_MS,
			},
			"claude-v2 prompt injected",
		);
		timer?.mark("message_sent");
	}

	private publish(event: BackendStreamEvent): void {
		if (
			!this.firstEventMarked &&
			(event.type === "session_meta" ||
				event.type === "text_delta" ||
				event.type === "thinking_delta" ||
				event.type === "tool_use" ||
				event.type === "tool_result" ||
				event.type === "turn_complete" ||
				event.type === "error")
		) {
			this.firstEventMarked = true;
			this.turnTimer?.mark("first_event");
		}

		if (
			event.type === "text_delta" ||
			event.type === "thinking_delta" ||
			event.type === "tool_use" ||
			event.type === "tool_result"
		) {
			this.active = true;
		}
		if (event.type === "tool_use") {
			this.openToolCalls.add(event.toolUseId);
		} else if (event.type === "tool_result") {
			this.openToolCalls.delete(event.toolUseId);
		}

		this.events.push(event);

		if (event.type === "turn_complete") {
			if (event.sessionId) this._sessionId = event.sessionId;
			this.openToolCalls.clear();
			this.markQuiescent();
		}
	}

	private publishTurnFailure(message: string): void {
		this.events.push({
			type: "error",
			message,
			sessionId: this._sessionId ?? undefined,
		});
		this.publish({
			type: "turn_complete",
			sessionId: this._sessionId ?? undefined,
		});
	}

	private markQuiescent(): void {
		if (!this.active) return;
		this.active = false;
		this.log?.info(
			{
				sessionId: this._sessionId,
				listeners: this.quiescentListeners.size,
			},
			"claude-v2 session quiescent",
		);
		const snapshot = [...this.quiescentListeners];
		for (const cb of snapshot) {
			try {
				cb();
			} catch {
				// Listener errors must not break the bridge.
			}
		}
	}

	private armPromptAckTimeout(): void {
		this.clearPromptAckTimeout();
		this.promptAckTimer = setTimeout(() => {
			if (!this.awaitingPromptAck) return;
			this.awaitingPromptAck = false;
			void this.capturePane()
				.catch(() => "")
				.then((pane) => {
					this.log?.warn(
						{
							sessionId: this._sessionId,
							panePreview: redactedPreview(pane),
						},
						"claude-v2 prompt acknowledgement timeout",
					);
					this.publishTurnFailure(
						`Claude interactive did not acknowledge the pasted prompt within ${Math.round(PROMPT_ACK_TIMEOUT_MS / 1000)}s${pane ? `\n\n${pane}` : ""}`,
					);
				});
		}, PROMPT_ACK_TIMEOUT_MS);
	}

	private clearPromptAckTimeout(): void {
		if (this.promptAckTimer) {
			clearTimeout(this.promptAckTimer);
			this.promptAckTimer = null;
		}
	}

	private async isTmuxAlive(): Promise<boolean> {
		if (!(await tmuxSessionExists(this.tmuxSession))) return false;
		const result = await runCommand("tmux", [
			"display-message",
			"-p",
			"-t",
			this.tmuxTarget,
			"#{pane_dead}",
		]);
		return result.code === 0 && result.stdout.trim() !== "1";
	}

	private async capturePane(lines = 80): Promise<string> {
		const result = await runCommand("tmux", [
			"capture-pane",
			"-t",
			this.tmuxTarget,
			"-p",
			"-S",
			`-${lines}`,
		]);
		if (result.code !== 0) return "";
		return result.stdout.trim();
	}

	private detach(): void {
		if (!this._alive) return;
		this._alive = false;
		this.log?.info(
			{ sessionId: this._sessionId },
			"claude-v2 process detached",
		);
		this.clearPromptAckTimeout();
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.events.end();
		this.quiescentListeners.clear();
	}
}

export class ClaudeInteractiveProcessPool implements BackendPool {
	readonly id = "claude-v2" as const;
	private readonly processes = new Map<string, ClaudeInteractiveProcess>();

	constructor(private readonly opts: BackendBridgeOptions) {}

	getOrCreate(
		conversationId: string,
		resumeSessionId: string | null,
		timer?: RequestTimer,
		overrides?: Partial<BackendBridgeOptions>,
	): ClaudeInteractiveProcess {
		const existing = this.processes.get(conversationId);
		if (existing?.alive) {
			timer?.mark("process_reused");
			return existing;
		}
		if (existing) this.processes.delete(conversationId);

		timer?.mark("process_spawned");
		const opts = overrides ? mergeOpts(this.opts, overrides) : this.opts;
		const proc = new ClaudeInteractiveProcess(opts, resumeSessionId);
		this.processes.set(conversationId, proc);
		return proc;
	}

	remove(conversationId: string): void {
		const proc = this.processes.get(conversationId);
		if (proc) {
			proc.kill();
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

function renderInteractiveContent(
	content: ContentBlock[],
	uploadDir: string,
): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "image") {
			mkdirSync(uploadDir, { recursive: true });
			const ext = block.source.media_type.includes("png") ? "png" : "jpg";
			const filePath = join(uploadDir, `${randomUUID()}.${ext}`);
			writeFileSync(filePath, Buffer.from(block.source.data, "base64"));
			parts.push(`Attached image file: ${filePath}`);
		}
	}
	return parts.join("\n\n").trim() || "Describe the attached file(s).";
}

function stringifyToolInput(input: unknown): string {
	try {
		return JSON.stringify(input ?? {});
	} catch {
		return "{}";
	}
}

function summarizeToolResult(content: unknown): string {
	if (typeof content === "string") return content.slice(0, 8_000);
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (typeof block === "string") return block;
				if (block && typeof block === "object") {
					const rec = block as Record<string, unknown>;
					if (typeof rec.text === "string") return rec.text;
					if (typeof rec.content === "string") return rec.content;
					if (typeof rec.type === "string") return `[${rec.type}]`;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n")
			.slice(0, 8_000);
	}
	try {
		return JSON.stringify(content ?? "").slice(0, 8_000);
	} catch {
		return String(content).slice(0, 8_000);
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

async function tmux(
	args: string[],
	opts: { input?: string } = {},
): Promise<CommandResult> {
	const result = await runCommand("tmux", args, opts);
	if (result.code !== 0) {
		throw new Error(
			`tmux ${args.join(" ")} failed (${result.code}): ${
				result.stderr || result.stdout
			}`,
		);
	}
	return result;
}

async function tmuxSessionExists(sessionName: string): Promise<boolean> {
	const result = await runCommand("tmux", ["has-session", "-t", sessionName]);
	return result.code === 0;
}

function runCommand(
	cmd: string,
	args: string[],
	opts: { input?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			stdio: opts.input === undefined ? ["ignore", "pipe", "pipe"] : "pipe",
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timeout = opts.timeoutMs
			? setTimeout(() => {
					if (settled) return;
					settled = true;
					child.kill("SIGTERM");
					reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
				}, opts.timeoutMs)
			: null;

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			reject(err);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolve({ code, stdout, stderr });
		});
		if (opts.input !== undefined) {
			child.stdin?.end(opts.input);
		}
	});
}

async function readLinesFrom(
	filePath: string,
	start: number,
	endExclusive: number,
): Promise<string[]> {
	const lines: string[] = [];
	const rl = createInterface({
		input: createReadStream(filePath, {
			start,
			end: Math.max(start, endExclusive - 1),
			encoding: "utf8",
		}),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		lines.push(line);
	}
	return lines;
}

function findTranscriptPath(sessionId: string): string | null {
	const projects = join(homedir(), ".claude", "projects");
	if (!existsSync(projects)) return null;
	const stack = [projects];
	const matches: string[] = [];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(path);
			} else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
				matches.push(path);
			}
		}
	}
	matches.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a));
	return matches[0] ?? null;
}

function safeName(workingDir: string, sessionId: string): string {
	return `${hashForName(workingDir).slice(0, 12)}-${sessionId}`;
}

function hashForName(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function isTrustPrompt(text: string): boolean {
	return (
		/quick safety check|do you trust|trust this folder/i.test(text) &&
		/yes,\s*i trust/i.test(text)
	);
}

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function fileMtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
