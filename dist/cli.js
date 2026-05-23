#!/usr/bin/env node
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { z } from "zod";
import { createInterface } from "node:readline";
import { Translator, parseLine } from "claude-code-parser";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { Cron } from "croner";
import { performance } from "node:perf_hooks";
import { telegramFormat } from "telegram-markdown-formatter";
import pino from "pino";
import { Hono } from "hono";
//#region src/cli/instance.ts
function resolveInstancePaths(input) {
	const root = resolve(input);
	return {
		root,
		configDir: join(root, "config"),
		dataDir: join(root, "data"),
		workspaceDir: join(root, "workspace"),
		envFile: join(root, "config/.env"),
		accessFile: join(root, "config/access.json"),
		cronFile: join(root, "config/crons.json"),
		promptsDir: join(root, "config/prompts"),
		serviceFile: join(root, "config/service.json"),
		sessionDb: join(root, "data/sessions.db"),
		logDir: join(root, "data/logs"),
		conversationLogDir: join(root, "data/conversations")
	};
}
function readServiceName(paths) {
	if (!existsSync(paths.serviceFile)) return null;
	try {
		const data = JSON.parse(readFileSync(paths.serviceFile, "utf-8"));
		return typeof data?.name === "string" ? data.name : null;
	} catch {
		return null;
	}
}
function writeServiceName(paths, name) {
	writeFileSync(paths.serviceFile, `${JSON.stringify({ name }, null, 2)}\n`);
}
function deleteServiceFile(paths) {
	if (existsSync(paths.serviceFile)) rmSync(paths.serviceFile);
}
function assertNodeVersion(min = 22) {
	const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
	if (Number.isNaN(major) || major < min) {
		console.error(`clawalski requires Node ${min}+. Current: ${process.version}.`);
		process.exit(1);
	}
}
function assertInstanceReady(paths) {
	if (!existsSync(paths.envFile)) {
		console.error(`No clawalski instance found at ${paths.root}.`);
		console.error(`Run: clawalski init ${paths.root}`);
		process.exit(1);
	}
}
//#endregion
//#region src/cli/commands/init.ts
function parseInitArgs(argv) {
	let path;
	let token;
	let adminChatId;
	let noInteractive = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (a === "--token") token = argv[++i];
		else if (a === "--admin-chat-id") adminChatId = argv[++i];
		else if (a === "--no-interactive") noInteractive = true;
		else if (!path && !a.startsWith("-")) path = a;
		else return { error: `Unknown argument: ${a}` };
	}
	if (!path) return { error: "Path is required: clawalski init <path>" };
	return {
		path,
		token,
		adminChatId,
		noInteractive
	};
}
function findExamplesDir() {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i++) {
		const candidate = join(dir, "examples");
		if (existsSync(candidate) && existsSync(join(dir, "package.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}
function seedExamples(paths) {
	const examples = findExamplesDir();
	if (!examples) return;
	const promptsSrc = join(examples, "prompts");
	if (existsSync(promptsSrc)) cpSync(promptsSrc, paths.promptsDir, { recursive: true });
	const cronsExampleSrc = join(examples, "crons.example.json");
	if (existsSync(cronsExampleSrc)) cpSync(cronsExampleSrc, join(paths.configDir, "crons.example.json"));
	const bindingsExampleSrc = join(examples, "bindings.example.json");
	if (existsSync(bindingsExampleSrc)) cpSync(bindingsExampleSrc, join(paths.configDir, "bindings.example.json"));
}
async function promptToken() {
	const rl = readline.createInterface({
		input: stdin,
		output: stdout
	});
	const answer = await rl.question("Telegram bot token (from @BotFather): ");
	rl.close();
	return answer.trim();
}
async function initCommand(argv) {
	const parsed = parseInitArgs(argv);
	if ("error" in parsed) {
		console.error(parsed.error);
		return 2;
	}
	const paths = resolveInstancePaths(parsed.path);
	if (existsSync(paths.envFile)) {
		console.error(`Instance already exists at ${paths.root}`);
		return 1;
	}
	let token = parsed.token;
	if (!token) {
		if (parsed.noInteractive || !stdin.isTTY) {
			console.error("--token is required. Pass --token <T> or run interactively (without --no-interactive).");
			return 2;
		}
		token = await promptToken();
		if (!token) {
			console.error("Empty token; aborting.");
			return 2;
		}
	}
	mkdirSync(paths.configDir, { recursive: true });
	mkdirSync(paths.dataDir, { recursive: true });
	mkdirSync(paths.workspaceDir, { recursive: true });
	mkdirSync(paths.promptsDir, { recursive: true });
	writeFileSync(paths.envFile, `TELEGRAM_BOT_TOKEN=${token}\n`, { mode: 384 });
	const access = {
		dmPolicy: "allowlist",
		groupPolicy: "allowlist",
		allowedUsers: [],
		allowedGroups: [],
		adminChatId: parsed.adminChatId ? Number(parsed.adminChatId) : null
	};
	writeFileSync(paths.accessFile, `${JSON.stringify(access, null, 2)}\n`);
	writeFileSync(paths.cronFile, `${JSON.stringify({ jobs: [] }, null, 2)}\n`);
	seedExamples(paths);
	console.log(`Scaffolded clawalski instance at ${paths.root}`);
	console.log("Next steps:");
	console.log(`  - Edit ${paths.accessFile} (set allowedUsers / allowedGroups)`);
	console.log(`  - Schedule jobs in ${paths.cronFile} (templates in ${paths.configDir}/crons.example.json)`);
	console.log(`  - Bind topics to repos in ${paths.configDir}/bindings.json (template: ${paths.configDir}/bindings.example.json)`);
	console.log(`  - Run: clawalski run ${paths.root}`);
	console.log(`  - Or as a service: clawalski service install ${paths.root} --name <name>`);
	return 0;
}
//#endregion
//#region src/cli/commands/list.ts
async function listCommand(_argv) {
	const r = spawnSync("systemctl", [
		"--user",
		"list-units",
		"--all",
		"--type=service",
		"--no-pager",
		"--no-legend",
		"clawalski-*.service"
	], { encoding: "utf-8" });
	if (r.status !== 0) {
		process.stderr.write(r.stderr ?? "");
		return r.status ?? 1;
	}
	const lines = (r.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) {
		console.log("No clawalski services registered.");
		return 0;
	}
	console.log(`${"NAME".padEnd(40)} ${"LOAD".padEnd(10)} ${"ACTIVE".padEnd(10)} SUB`);
	for (const line of lines) {
		const [unit, load, active, sub] = line.trim().split(/\s+/);
		console.log(`${(unit ?? "").padEnd(40)} ${(load ?? "").padEnd(10)} ${(active ?? "").padEnd(10)} ${sub ?? ""}`);
	}
	return 0;
}
//#endregion
//#region src/access.ts
const backendIdSchema$2 = z.enum(["claude", "codex"]);
const accessFileSchema = z.object({
	dmPolicy: z.enum(["open", "allowlist"]).default("open"),
	groupPolicy: z.enum(["open", "allowlist"]).default("open"),
	allowedUsers: z.array(z.union([z.number(), z.literal("*")])).default([]),
	allowedGroups: z.array(z.union([z.number(), z.literal("*")])).default([]),
	adminChatId: z.number().optional(),
	dmDefaultBackend: backendIdSchema$2.optional(),
	groupDefaultBackend: backendIdSchema$2.optional()
});
function parseAccessConfig(raw) {
	const parsed = accessFileSchema.parse(raw);
	return {
		dmPolicy: parsed.dmPolicy,
		groupPolicy: parsed.groupPolicy,
		allowedUsers: new Set(parsed.allowedUsers.filter((v) => v !== "*")),
		allowedGroups: new Set(parsed.allowedGroups.filter((v) => v !== "*")),
		allowAllUsers: parsed.allowedUsers.includes("*"),
		allowAllGroups: parsed.allowedGroups.includes("*"),
		adminChatId: parsed.adminChatId ?? null,
		dmDefaultBackend: parsed.dmDefaultBackend ?? null,
		groupDefaultBackend: parsed.groupDefaultBackend ?? null
	};
}
const OPEN_ACCESS = {
	dmPolicy: "open",
	groupPolicy: "open",
	allowedUsers: /* @__PURE__ */ new Set(),
	allowedGroups: /* @__PURE__ */ new Set(),
	allowAllUsers: false,
	allowAllGroups: false,
	adminChatId: null,
	dmDefaultBackend: null,
	groupDefaultBackend: null
};
function loadAccessConfig(filePath, log) {
	try {
		const content = readFileSync(filePath, "utf-8");
		const config = parseAccessConfig(JSON.parse(content));
		log?.info({
			dmPolicy: config.dmPolicy,
			groupPolicy: config.groupPolicy,
			users: config.allowAllUsers ? "*" : config.allowedUsers.size,
			groups: config.allowAllGroups ? "*" : config.allowedGroups.size,
			adminChatId: config.adminChatId
		}, "access config loaded");
		return config;
	} catch (err) {
		if (err.code === "ENOENT") {
			log?.warn({ filePath }, "access config not found, defaulting to open access");
			return OPEN_ACCESS;
		}
		throw err;
	}
}
function watchAccessConfig(filePath, onChange, log) {
	let debounce = null;
	try {
		watch(filePath, () => {
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(() => {
				try {
					onChange(loadAccessConfig(filePath, log));
					log.info("access config reloaded");
				} catch (err) {
					log.error({ err }, "failed to reload access config");
				}
			}, 300);
		});
		log.info({ filePath }, "watching access config for changes");
	} catch {
		log.warn({ filePath }, "could not watch access config file");
	}
}
function isAllowed(ctx, access) {
	if (ctx.chatType === "channel") return false;
	if (ctx.chatType === "private") {
		if (access.dmPolicy === "open") return true;
		return isUserAllowed(ctx.senderId, access);
	}
	if (access.groupPolicy === "open") return true;
	return isGroupAllowed(ctx.chatId, access) && isUserAllowed(ctx.senderId, access);
}
function isUserAllowed(senderId, access) {
	if (access.allowAllUsers) return true;
	if (senderId == null) return false;
	return access.allowedUsers.has(senderId);
}
function isGroupAllowed(chatId, access) {
	if (access.allowAllGroups) return true;
	return access.allowedGroups.has(chatId);
}
const NOTIFY_COOLDOWN_MS = 300 * 1e3;
const notifiedRecently = /* @__PURE__ */ new Map();
function formatAdminNotification(ctx) {
	const lines = ["New contact attempt"];
	const from = ctx.senderUsername ? `${ctx.senderName} (@${ctx.senderUsername})` : ctx.senderName;
	lines.push(`From: ${from}`);
	if (ctx.senderId) lines.push(`User ID: ${ctx.senderId}`);
	if (ctx.chatType === "private") lines.push("Context: DM");
	else {
		const chatLabel = ctx.chatTitle ? `${ctx.chatTitle} (${ctx.chatId})` : String(ctx.chatId);
		lines.push(`Context: ${ctx.chatType} ${chatLabel}`);
		if (ctx.isForum && ctx.threadId != null) lines.push(`Topic: ${ctx.threadId}`);
	}
	return lines.join("\n");
}
function shouldNotifyAdmin(ctx) {
	const key = `${ctx.senderId ?? "unknown"}:${ctx.chatId}`;
	const now = Date.now();
	const lastNotified = notifiedRecently.get(key);
	if (lastNotified && now - lastNotified < NOTIFY_COOLDOWN_MS) return false;
	notifiedRecently.set(key, now);
	if (notifiedRecently.size > 500) {
		for (const [k, t] of notifiedRecently) if (now - t > NOTIFY_COOLDOWN_MS) notifiedRecently.delete(k);
	}
	return true;
}
//#endregion
//#region src/backend-registry.ts
var DefaultBackendRegistry = class {
	constructor(defaultId, pools, cronPools) {
		this.defaultId = defaultId;
		this.pools = pools;
		this.cronPools = cronPools;
	}
	pool(id) {
		const p = this.pools.get(id);
		if (!p) throw new Error(`No pool registered for backend: ${id}`);
		return p;
	}
	cronPool(id) {
		const p = this.cronPools.get(id);
		if (!p) throw new Error(`No cron pool registered for backend: ${id}`);
		return p;
	}
	closeAll() {
		for (const p of this.pools.values()) p.closeAll();
		for (const p of this.cronPools.values()) p.closeAll();
	}
};
/**
* Per-conversation map of "pending backends" — set when a user issues
* `/new <backend>` but hasn't yet sent a real message that opens the
* session. Cleared once the first message is dispatched.
*/
var PendingBackendStore = class {
	map = /* @__PURE__ */ new Map();
	get(conversationId) {
		return this.map.get(conversationId) ?? null;
	}
	set(conversationId, backend) {
		this.map.set(conversationId, backend);
	}
	clear(conversationId) {
		this.map.delete(conversationId);
	}
};
//#endregion
//#region src/binding-config.ts
const bindingEntrySchema = z.object({
	chatId: z.number().int(),
	threadId: z.number().int().positive().optional(),
	workingDir: z.string().min(1).optional(),
	prompt: z.string().min(1).optional()
}).refine((b) => b.workingDir != null || b.prompt != null, { message: "binding must set at least one of workingDir or prompt" });
const bindingFileSchema = z.object({ bindings: z.array(bindingEntrySchema).default([]) });
const EMPTY_CONFIG = { bindings: [] };
function validateWorkingDir(dir, log) {
	try {
		if (!statSync(dir).isDirectory()) {
			log?.warn({ workingDir: dir }, "binding workingDir is not a directory");
			return false;
		}
		return true;
	} catch {
		log?.warn({ workingDir: dir }, "binding workingDir does not exist");
		return false;
	}
}
function parseBindingConfig(raw, log) {
	return { bindings: bindingFileSchema.parse(raw).bindings.filter((b) => {
		if (b.workingDir != null && !validateWorkingDir(b.workingDir, log)) return false;
		return true;
	}) };
}
function loadBindingConfig(filePath, log) {
	try {
		const content = readFileSync(filePath, "utf-8");
		const config = parseBindingConfig(JSON.parse(content), log);
		log?.info({
			count: config.bindings.length,
			filePath
		}, "binding config loaded");
		return config;
	} catch (err) {
		if (err.code === "ENOENT") {
			log?.info({ filePath }, "binding config not found, no bindings configured");
			return EMPTY_CONFIG;
		}
		throw err;
	}
}
function resolveBinding(ctx, config) {
	const wantThreadId = ctx.isForum && ctx.threadId != null ? ctx.threadId : null;
	for (const b of config.bindings) {
		if (b.chatId !== ctx.chatId) continue;
		if ((b.threadId ?? null) !== wantThreadId) continue;
		return {
			workingDir: b.workingDir ?? null,
			prompt: b.prompt ?? null
		};
	}
	return null;
}
//#endregion
//#region src/backend.ts
const BACKEND_IDS = ["claude", "codex"];
function isBackendId(value) {
	return BACKEND_IDS.includes(value);
}
/** Extract a human-readable summary of a tool's input for the activity footer. */
function summarizeToolInput(toolName, input) {
	try {
		const parsed = JSON.parse(input);
		switch (toolName) {
			case "Bash": return parsed.description || parsed.command || "";
			case "Read":
			case "Edit":
			case "Write": return parsed.file_path || "";
			case "Glob":
			case "Grep": return parsed.pattern || "";
			case "WebSearch": return parsed.query || "";
			case "WebFetch": return parsed.url || "";
			default: return "";
		}
	} catch {
		return "";
	}
}
//#endregion
//#region src/claude-bridge.ts
const DEFAULT_SYSTEM_PROMPT = "You are responding via a Telegram bot. Be concise and direct. Do not quote the user's message back to them. Do not use markdown headers. Keep responses short unless the task requires detail.";
var EventQueue$1 = class {
	buffer = [];
	waiting = null;
	ended = false;
	push(event) {
		if (this.ended) return;
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({
				value: event,
				done: false
			});
		} else this.buffer.push(event);
	}
	end() {
		if (this.ended) return;
		this.ended = true;
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({
				value: void 0,
				done: true
			});
		}
	}
	next() {
		if (this.buffer.length > 0) return Promise.resolve({
			value: this.buffer.shift(),
			done: false
		});
		if (this.ended) return Promise.resolve({
			value: void 0,
			done: true
		});
		return new Promise((resolve) => {
			this.waiting = resolve;
		});
	}
	[Symbol.asyncIterator]() {
		return this;
	}
};
var ClaudeProcess = class {
	proc;
	rl;
	translator = new Translator();
	streamParser = new StreamEventParser();
	events = new EventQueue$1();
	_sessionId = null;
	_alive = true;
	stderr = "";
	turnTimer = null;
	firstEventMarked = false;
	openToolCalls = /* @__PURE__ */ new Set();
	active = false;
	quiescentListeners = /* @__PURE__ */ new Set();
	constructor(opts, resumeSessionId) {
		const args = [
			"-p",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--dangerously-skip-permissions"
		];
		if (resumeSessionId) args.push("--resume", resumeSessionId);
		if (opts.model) args.push("--model", opts.model);
		const systemPrompt = opts.systemPrompt !== void 0 ? opts.systemPrompt : DEFAULT_SYSTEM_PROMPT;
		if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
		const settings = JSON.stringify({ permissions: { allow: [
			"Bash",
			"Read",
			"Edit",
			"Write",
			"Glob",
			"Grep",
			"WebSearch",
			"WebFetch"
		] } });
		args.push("--settings", settings);
		const homeDir = process.env.HOME ?? "/home/dev";
		const nodeBinDir = dirname(process.execPath);
		const sandboxPath = (process.env.PATH ?? "").split(":").includes(nodeBinDir) ? process.env.PATH : `${nodeBinDir}:${process.env.PATH ?? ""}`;
		const envArgs = Object.entries({
			...process.env,
			PATH: sandboxPath
		}).filter(([, v]) => v !== void 0).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
		if (opts.conversationHistoryDir) mkdirSync(opts.conversationHistoryDir, { recursive: true });
		this.proc = spawn("landrun", [
			"--rox",
			"/",
			"--rw",
			opts.workingDir,
			"--rw",
			"/tmp",
			"--rw",
			`${homeDir}/.claude`,
			"--rw",
			"/dev/null",
			...opts.conversationHistoryDir ? ["--rox", opts.conversationHistoryDir] : [],
			...opts.cronFilePath ? ["--rw", opts.cronFilePath] : [],
			"--unrestricted-network",
			...envArgs,
			"--",
			"claude",
			...args
		], {
			cwd: opts.workingDir,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		this.proc.on("error", (err) => {
			this.stderr += `failed to spawn landrun: ${err.code ?? ""} ${err.message}\n`;
		});
		this.proc.stderr?.on("data", (chunk) => {
			this.stderr += chunk.toString();
		});
		this.rl = createInterface({ input: this.proc.stdout });
		this.rl.on("line", (line) => this.handleLine(line));
		this.proc.on("close", (code) => {
			this._alive = false;
			if (code !== 0 && code !== null) this.events.push({
				type: "error",
				message: this.stderr.trim() || `Claude CLI exited with code ${code}`
			});
			this.events.end();
			this.quiescentListeners.clear();
		});
	}
	handleLine(line) {
		if (!line.trim()) return;
		const parsed = parseLine(line);
		if (!parsed) return;
		if (!this.firstEventMarked) {
			this.firstEventMarked = true;
			this.turnTimer?.mark("first_event");
		}
		if (parsed.type === "stream_event") {
			const events = this.streamParser.process(parsed);
			for (const ev of events) this.publish(ev);
			return;
		}
		if (parsed.type === "assistant") return;
		const events = this.translator.translate(parsed);
		for (const event of events) {
			if (event.type === "turn_complete" && event.sessionId) this._sessionId = event.sessionId;
			if (event.type === "error" && "sessionId" in event && event.sessionId) this._sessionId = event.sessionId;
			this.publish(event);
		}
	}
	/**
	* Push an event into the long-lived stream and update the active/quiescent
	* state machine. We track open tool calls so a multi-second tool run never
	* looks "idle"; we only flip back to quiescent once turn_complete fires
	* with no tool result still pending.
	*/
	publish(event) {
		if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_use" || event.type === "tool_result") this.active = true;
		if (event.type === "tool_use") this.openToolCalls.add(event.toolUseId);
		else if (event.type === "tool_result") this.openToolCalls.delete(event.toolUseId);
		this.events.push(event);
		if (event.type === "turn_complete") {
			if (event.sessionId) this._sessionId = event.sessionId;
			this.openToolCalls.clear();
			this.markQuiescent();
		}
	}
	markQuiescent() {
		if (!this.active) return;
		this.active = false;
		const snapshot = [...this.quiescentListeners];
		for (const cb of snapshot) try {
			cb();
		} catch {}
	}
	stream() {
		return this.events;
	}
	sendInput(content, timer) {
		if (!this._alive) return;
		this.turnTimer = timer ?? null;
		this.firstEventMarked = false;
		this.translator = new Translator();
		this.streamParser = new StreamEventParser();
		this.active = true;
		timer?.mark("message_sent");
		const msg = JSON.stringify({
			type: "user",
			session_id: "",
			message: {
				role: "user",
				content
			},
			parent_tool_use_id: null
		});
		this.proc.stdin?.write(`${msg}\n`);
	}
	get quiescent() {
		return !this.active && this._alive;
	}
	onQuiescent(cb) {
		this.quiescentListeners.add(cb);
		return () => {
			this.quiescentListeners.delete(cb);
		};
	}
	close() {
		if (this._alive) this.proc.stdin?.end();
	}
	get alive() {
		return this._alive;
	}
	get sessionId() {
		return this._sessionId;
	}
};
var ProcessPool = class {
	id = "claude";
	processes = /* @__PURE__ */ new Map();
	opts;
	constructor(opts) {
		this.opts = opts;
	}
	getOrCreate(conversationId, resumeSessionId, timer, overrides) {
		const existing = this.processes.get(conversationId);
		if (existing?.alive) {
			timer?.mark("process_reused");
			return existing;
		}
		if (existing) this.processes.delete(conversationId);
		timer?.mark("process_spawned");
		const proc = new ClaudeProcess(overrides ? mergeOpts$1(this.opts, overrides) : this.opts, resumeSessionId);
		this.processes.set(conversationId, proc);
		return proc;
	}
	remove(conversationId) {
		const proc = this.processes.get(conversationId);
		if (proc) {
			proc.close();
			this.processes.delete(conversationId);
		}
	}
	closeAll() {
		for (const proc of this.processes.values()) proc.close();
		this.processes.clear();
	}
};
const AUTH_ERROR_PATTERN = /API Error: 401|authentication_error|Invalid authentication/i;
function isAuthError(message) {
	return AUTH_ERROR_PATTERN.test(message);
}
async function* sendMessageWithAuthRetry(initialProc, respawnProcess, removeProcess, content, timer, log, options = {}) {
	const maxAttempts = options.maxAttempts ?? 3;
	const retryDelaysMs = options.retryDelaysMs ?? [2e3, 5e3];
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let proc;
		if (attempt === 1) proc = initialProc;
		else {
			removeProcess();
			const delay = retryDelaysMs[Math.min(attempt - 2, retryDelaysMs.length - 1)] ?? 0;
			if (delay > 0) await new Promise((r) => setTimeout(r, delay));
			proc = respawnProcess();
		}
		proc.sendInput(content, timer);
		const iter = proc.stream()[Symbol.asyncIterator]();
		const buffered = [];
		let retry = false;
		let committed = false;
		while (true) {
			const res = await iter.next();
			if (res.done) break;
			const ev = res.value;
			if (ev.type === "text_delta" || ev.type === "tool_use" || ev.type === "tool_result" || ev.type === "turn_complete") {
				buffered.push(ev);
				committed = true;
				break;
			}
			if (ev.type === "error") {
				if (attempt < maxAttempts && isAuthError(ev.message)) {
					retry = true;
					log.warn({
						attempt,
						error: ev.message.slice(0, 200)
					}, "claude CLI auth 401 — respawning and retrying once");
					break;
				}
				buffered.push(ev);
				break;
			}
			buffered.push(ev);
		}
		if (retry) continue;
		for (const ev of buffered) yield ev;
		if (committed) while (true) {
			const res = await iter.next();
			if (res.done) return;
			yield res.value;
		}
		return;
	}
}
const FINAL_STOP_REASONS = new Set([
	"end_turn",
	"stop_sequence",
	"max_tokens",
	"refusal"
]);
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
var StreamEventParser = class {
	pendingToolUseId = "";
	pendingToolName = "";
	pendingToolInput = "";
	pendingStopReason = null;
	process(raw) {
		const event = raw.event;
		if (!event) return [];
		switch (event.type) {
			case "message_start":
				this.pendingStopReason = null;
				return [];
			case "message_delta":
				if (event.delta?.stop_reason != null) this.pendingStopReason = event.delta.stop_reason;
				return [];
			case "message_stop": {
				const stopReason = this.pendingStopReason;
				this.pendingStopReason = null;
				if (stopReason && FINAL_STOP_REASONS.has(stopReason)) return [raw.session_id ? {
					type: "turn_complete",
					sessionId: raw.session_id
				} : { type: "turn_complete" }];
				return [];
			}
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
				if (delta.type === "text_delta") return [{
					type: "text_delta",
					content: delta.text ?? ""
				}];
				if (delta.type === "thinking_delta") return [{
					type: "thinking_delta",
					content: delta.thinking ?? ""
				}];
				if (delta.type === "input_json_delta" && this.pendingToolName) this.pendingToolInput += delta.partial_json ?? "";
				return [];
			}
			case "content_block_stop":
				if (this.pendingToolName) {
					const ev = {
						type: "tool_use",
						toolUseId: this.pendingToolUseId,
						toolName: this.pendingToolName,
						input: this.pendingToolInput
					};
					this.pendingToolUseId = "";
					this.pendingToolName = "";
					this.pendingToolInput = "";
					return [ev];
				}
				return [];
			default: return [];
		}
	}
};
function mergeOpts$1(base, overrides) {
	const result = { ...base };
	for (const [key, value] of Object.entries(overrides)) if (value !== void 0) result[key] = value;
	return result;
}
//#endregion
//#region src/codex-bridge.ts
var EventQueue = class {
	buffer = [];
	waiting = null;
	ended = false;
	push(event) {
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({
				value: event,
				done: false
			});
		} else this.buffer.push(event);
	}
	end() {
		this.ended = true;
		if (this.waiting) {
			const resolve = this.waiting;
			this.waiting = null;
			resolve({
				value: void 0,
				done: true
			});
		}
	}
	next() {
		if (this.buffer.length > 0) return Promise.resolve({
			value: this.buffer.shift(),
			done: false
		});
		if (this.ended) return Promise.resolve({
			value: void 0,
			done: true
		});
		return new Promise((resolve) => {
			this.waiting = resolve;
		});
	}
	[Symbol.asyncIterator]() {
		return this;
	}
};
/**
* One handle per conversation. Unlike `ClaudeProcess`, Codex's CLI is
* one-shot — each turn spawns a fresh `codex exec [resume <id>]` and
* exits. The handle just remembers the thread id between turns and
* exposes a long-lived event stream that subprocess events are pushed
* into across turns.
*/
var CodexProcess = class {
	_sessionId;
	_alive = true;
	opts;
	currentProc = null;
	currentRl = null;
	/** True until the first turn has been sent — used to inject the system prompt once. */
	firstTurn;
	events = new EventQueue();
	active = false;
	quiescentListeners = /* @__PURE__ */ new Set();
	constructor(opts, resumeSessionId) {
		this.opts = opts;
		this._sessionId = resumeSessionId ?? null;
		this.firstTurn = !resumeSessionId;
	}
	stream() {
		return this.events;
	}
	get quiescent() {
		return !this.active && this._alive;
	}
	onQuiescent(cb) {
		this.quiescentListeners.add(cb);
		return () => {
			this.quiescentListeners.delete(cb);
		};
	}
	markQuiescent() {
		if (!this.active) return;
		this.active = false;
		const snapshot = [...this.quiescentListeners];
		for (const cb of snapshot) try {
			cb();
		} catch {}
	}
	sendInput(content, timer) {
		if (!this._alive) return;
		this.active = true;
		const { promptText, imagePaths } = renderContent(content);
		const promptToSend = this.firstTurn && this.opts.systemPrompt ? `${this.opts.systemPrompt}\n\n${promptText}` : promptText;
		this.firstTurn = false;
		const codexArgs = [
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
			"--skip-git-repo-check",
			"--json",
			"-C",
			this.opts.workingDir
		];
		if (this.opts.model) codexArgs.push("-m", this.opts.model);
		for (const p of imagePaths) codexArgs.push("-i", p);
		if (this._sessionId) codexArgs.push("resume", this._sessionId, promptToSend);
		else codexArgs.push(promptToSend);
		const homeDir = process.env.HOME ?? "/home/dev";
		const nodeBinDir = dirname(process.execPath);
		const sandboxPath = (process.env.PATH ?? "").split(":").includes(nodeBinDir) ? process.env.PATH : `${nodeBinDir}:${process.env.PATH ?? ""}`;
		const envArgs = Object.entries({
			...process.env,
			PATH: sandboxPath
		}).filter(([, v]) => v !== void 0).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
		if (this.opts.conversationHistoryDir) mkdirSync(this.opts.conversationHistoryDir, { recursive: true });
		const landrunArgs = [
			"--rox",
			"/",
			"--rw",
			this.opts.workingDir,
			"--rw",
			"/tmp",
			"--rw",
			`${homeDir}/.codex`,
			"--rw",
			"/dev/null",
			...this.opts.conversationHistoryDir ? ["--rox", this.opts.conversationHistoryDir] : [],
			...this.opts.cronFilePath ? ["--rw", this.opts.cronFilePath] : [],
			"--unrestricted-network",
			...envArgs,
			"--",
			"codex",
			...codexArgs
		];
		timer?.mark("message_sent");
		const proc = spawn("landrun", landrunArgs, {
			cwd: this.opts.workingDir,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		this.currentProc = proc;
		let stderr = "";
		let firstEventMarked = false;
		let turnCompleted = false;
		proc.on("error", (err) => {
			stderr += `failed to spawn landrun: ${err.code ?? ""} ${err.message}\n`;
		});
		proc.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const rl = createInterface({ input: proc.stdout });
		this.currentRl = rl;
		rl.on("line", (line) => {
			if (line.startsWith("Reading additional input")) return;
			if (!line.startsWith("{")) return;
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch {
				return;
			}
			if (!firstEventMarked) {
				firstEventMarked = true;
				timer?.mark("first_event");
			}
			switch (parsed.type) {
				case "thread.started":
					this._sessionId = parsed.thread_id;
					break;
				case "item.started":
				case "item.updated":
				case "item.completed":
					translateItem(parsed, this.events);
					break;
				case "turn.completed": {
					turnCompleted = true;
					const usage = parsed.usage ?? {};
					this.events.push({
						type: "turn_complete",
						sessionId: this._sessionId ?? void 0,
						inputTokens: usage.input_tokens,
						outputTokens: usage.output_tokens
					});
					break;
				}
			}
		});
		proc.on("close", (code) => {
			this.currentProc = null;
			this.currentRl = null;
			if (!turnCompleted) if (code !== 0 && code !== null) this.events.push({
				type: "error",
				message: stderr.trim() || `codex CLI exited with code ${code}`,
				sessionId: this._sessionId ?? void 0
			});
			else this.events.push({
				type: "error",
				message: "codex CLI exited without completing the turn",
				sessionId: this._sessionId ?? void 0
			});
			this.markQuiescent();
		});
	}
	close() {
		if (!this._alive) return;
		this._alive = false;
		if (this.currentProc) try {
			this.currentProc.kill("SIGTERM");
		} catch {}
		if (this.currentRl) this.currentRl.close();
		this.events.end();
		this.quiescentListeners.clear();
	}
	get alive() {
		return this._alive;
	}
	get sessionId() {
		return this._sessionId;
	}
};
function translateItem(parsed, queue) {
	const item = parsed.item;
	switch (item.type) {
		case "command_execution": {
			const cmd = item;
			if (parsed.type === "item.started") queue.push({
				type: "tool_use",
				toolUseId: cmd.id,
				toolName: "Bash",
				input: JSON.stringify({
					command: cmd.command,
					description: cmd.command
				})
			});
			else if (parsed.type === "item.completed") {
				const exitCode = cmd.exit_code ?? 0;
				queue.push({
					type: "tool_result",
					toolUseId: cmd.id,
					output: cmd.aggregated_output ?? "",
					isError: exitCode !== 0
				});
			}
			break;
		}
		case "agent_message": {
			if (parsed.type !== "item.completed") break;
			const text = item.text ?? "";
			if (text) queue.push({
				type: "text_delta",
				content: `${text}\n`
			});
			break;
		}
		case "reasoning": {
			if (parsed.type !== "item.completed") break;
			const r = item;
			if (r.text) queue.push({
				type: "thinking_delta",
				content: r.text
			});
			break;
		}
	}
}
const CODEX_IMAGE_DIR = join(tmpdir(), "tg-codex-images");
function renderContent(content) {
	const textParts = [];
	const imagePaths = [];
	for (const block of content) if (block.type === "text") textParts.push(block.text);
	else if (block.type === "image") {
		mkdirSync(CODEX_IMAGE_DIR, { recursive: true });
		const ext = block.source.media_type.includes("png") ? "png" : "jpg";
		const filepath = join(CODEX_IMAGE_DIR, `${randomUUID()}.${ext}`);
		writeFileSync(filepath, Buffer.from(block.source.data, "base64"));
		imagePaths.push(filepath);
	}
	return {
		promptText: textParts.join("\n\n").trim() || "Describe the attached image(s).",
		imagePaths
	};
}
var CodexProcessPool = class {
	id = "codex";
	processes = /* @__PURE__ */ new Map();
	opts;
	constructor(opts) {
		this.opts = opts;
	}
	getOrCreate(conversationId, resumeSessionId, timer, overrides) {
		const existing = this.processes.get(conversationId);
		if (existing?.alive) {
			timer?.mark("process_reused");
			return existing;
		}
		if (existing) this.processes.delete(conversationId);
		timer?.mark("process_spawned");
		const proc = new CodexProcess(overrides ? mergeOpts(this.opts, overrides) : this.opts, resumeSessionId);
		this.processes.set(conversationId, proc);
		return proc;
	}
	remove(conversationId) {
		const proc = this.processes.get(conversationId);
		if (proc) {
			proc.close();
			this.processes.delete(conversationId);
		}
	}
	closeAll() {
		for (const proc of this.processes.values()) proc.close();
		this.processes.clear();
	}
};
var CodexCronProcessPool = class {
	id = "codex";
	processes = /* @__PURE__ */ new Map();
	defaultOpts;
	constructor(defaultOpts) {
		this.defaultOpts = defaultOpts;
	}
	create(runKey, jobOpts, timer) {
		const opts = jobOpts ? {
			...this.defaultOpts,
			...stripNulls$1(jobOpts)
		} : this.defaultOpts;
		timer?.mark("cron_process_spawned");
		const proc = new CodexProcess(opts);
		this.processes.set(runKey, proc);
		return proc;
	}
	remove(runKey) {
		const proc = this.processes.get(runKey);
		if (proc) {
			proc.close();
			this.processes.delete(runKey);
		}
	}
	closeAll() {
		for (const proc of this.processes.values()) proc.close();
		this.processes.clear();
	}
};
function mergeOpts(base, overrides) {
	const result = { ...base };
	for (const [key, value] of Object.entries(overrides)) if (value !== void 0) result[key] = value;
	return result;
}
function stripNulls$1(obj) {
	const result = {};
	for (const [key, value] of Object.entries(obj)) if (value != null) result[key] = value;
	return result;
}
//#endregion
//#region src/config.ts
const backendIdSchema$1 = z.enum(["claude", "codex"]);
const configSchema = z.object({
	telegramBotToken: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
	mode: z.enum(["polling", "webhook"]).default("polling"),
	logLevel: z.enum([
		"debug",
		"info",
		"warn",
		"error"
	]).default("info"),
	respondMode: z.enum(["all", "mention"]).default("all"),
	instancePath: z.string().min(1),
	accessFile: z.string().min(1),
	cronFile: z.string().min(1),
	bindingsFile: z.string().min(1),
	sessionDbPath: z.string().min(1),
	logDir: z.string().min(1),
	conversationLogDir: z.string().min(1),
	claudeWorkingDir: z.string().min(1),
	promptsDir: z.string().min(1),
	defaultBackend: backendIdSchema$1.default("claude"),
	claudeModel: z.string().optional(),
	codexModel: z.string().optional(),
	cronRetryMaxAttempts: z.coerce.number().int().positive().default(3),
	cronStuckTimeoutMs: z.coerce.number().int().positive().default(27e5),
	cronFailureAlertAfter: z.coerce.number().int().positive().default(2),
	cronFailureAlertCooldownMs: z.coerce.number().int().positive().default(36e5),
	cronAutoDisableAfter: z.coerce.number().int().positive().default(5),
	webhookUrl: z.string().optional(),
	webhookSecret: z.string().optional(),
	webhookPort: z.coerce.number().int().positive().default(8787),
	webhookPath: z.string().default("/telegram-webhook")
});
var ConfigError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ConfigError";
	}
};
function loadConfig({ instancePath }) {
	const result = configSchema.safeParse({
		telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
		mode: process.env.MODE || void 0,
		logLevel: process.env.LOG_LEVEL || void 0,
		respondMode: process.env.RESPOND_MODE || void 0,
		instancePath,
		accessFile: process.env.ACCESS_FILE || join(instancePath, "config/access.json"),
		cronFile: process.env.CRON_FILE || join(instancePath, "config/crons.json"),
		bindingsFile: process.env.BINDINGS_FILE || join(instancePath, "config/bindings.json"),
		sessionDbPath: process.env.SESSION_DB_PATH || join(instancePath, "data/sessions.db"),
		logDir: process.env.LOG_DIR || join(instancePath, "data/logs"),
		conversationLogDir: process.env.CONVERSATION_LOG_DIR || join(instancePath, "data/conversations"),
		claudeWorkingDir: process.env.CLAUDE_WORKING_DIR || join(instancePath, "workspace"),
		promptsDir: process.env.PROMPTS_DIR || join(instancePath, "config/prompts"),
		defaultBackend: process.env.DEFAULT_BACKEND || void 0,
		claudeModel: process.env.CLAUDE_MODEL || void 0,
		codexModel: process.env.CODEX_MODEL || void 0,
		cronRetryMaxAttempts: process.env.CRON_RETRY_MAX_ATTEMPTS,
		cronStuckTimeoutMs: process.env.CRON_STUCK_TIMEOUT_MS,
		cronFailureAlertAfter: process.env.CRON_FAILURE_ALERT_AFTER,
		cronFailureAlertCooldownMs: process.env.CRON_FAILURE_ALERT_COOLDOWN_MS,
		cronAutoDisableAfter: process.env.CRON_AUTO_DISABLE_AFTER,
		webhookUrl: process.env.WEBHOOK_URL,
		webhookSecret: process.env.WEBHOOK_SECRET,
		webhookPort: process.env.WEBHOOK_PORT,
		webhookPath: process.env.WEBHOOK_PATH
	});
	if (!result.success) throw new ConfigError(`Configuration error:\n${result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
	const config = result.data;
	if (config.mode === "webhook" && !config.webhookUrl) throw new ConfigError("Configuration error:\n  WEBHOOK_URL is required when MODE=webhook");
	return config;
}
//#endregion
//#region src/conversation-logger.ts
/** Convert a conversationId to a filesystem-safe directory name. */
function conversationIdToDir(conversationId) {
	return conversationId.replace(/:/g, "-");
}
function makeFilename(sessionId) {
	return `${(/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}_${sessionId}.jsonl`;
}
function createConversationLogger(logDir) {
	mkdirSync(logDir, { recursive: true });
	const sessionFiles = /* @__PURE__ */ new Map();
	function resolveFile(sessionId, conversationId) {
		const cached = sessionFiles.get(sessionId);
		if (cached) return cached;
		const convDir = join(logDir, conversationIdToDir(conversationId));
		mkdirSync(convDir, { recursive: true });
		try {
			const match = readdirSync(convDir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
			if (match) {
				const filepath = join(convDir, match);
				sessionFiles.set(sessionId, filepath);
				return filepath;
			}
		} catch {}
		const filepath = join(convDir, makeFilename(sessionId));
		sessionFiles.set(sessionId, filepath);
		return filepath;
	}
	return { log(entry) {
		appendFileSync(resolveFile(entry.sessionId, entry.conversationId), `${JSON.stringify(entry)}\n`);
	} };
}
/**
* Migrate flat log files from the old layout into per-conversationId
* subdirectories.
*
* Old: data/conversations/{timestamp}_{channel}_{sessionId}.jsonl
* New: data/conversations/{channel}/{timestamp}_{sessionId}.jsonl
*/
function migrateConversationLogs(logDir) {
	mkdirSync(logDir, { recursive: true });
	let migrated = 0;
	const files = readdirSync(logDir);
	for (const file of files) {
		if (!file.endsWith(".jsonl")) continue;
		const match = file.match(/^(\d{8}T\d{6})_(.+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
		if (!match) continue;
		const [, timestamp, channel, sessionId] = match;
		const destDir = join(logDir, channel);
		mkdirSync(destDir, { recursive: true });
		const newFilename = `${timestamp}_${sessionId}.jsonl`;
		renameSync(join(logDir, file), join(destDir, newFilename));
		migrated++;
	}
	return migrated;
}
//#endregion
//#region src/cron-config.ts
const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{0,27}$/;
const backendIdSchema = z.enum(["claude", "codex"]);
const cronJobSchema = z.object({
	id: z.string().regex(JOB_ID_RE, "must be lowercase alphanumeric + hyphens, 1-28 chars"),
	name: z.string().regex(JOB_ID_RE, "must be lowercase alphanumeric + hyphens, 1-28 chars"),
	enabled: z.boolean().default(true),
	schedule: z.string().min(1, "cron expression required"),
	timezone: z.string().optional(),
	prompt: z.string().optional(),
	promptFile: z.string().optional(),
	chatId: z.number().optional(),
	threadId: z.number().optional(),
	failureAlertChatId: z.number().optional(),
	backend: backendIdSchema.optional(),
	systemPrompt: z.string().nullable().optional(),
	workingDir: z.string().nullable().optional(),
	model: z.string().nullable().optional()
}).refine((j) => j.prompt || j.promptFile, { message: "either prompt or promptFile is required" }).refine((j) => !(j.prompt && j.promptFile), { message: "prompt and promptFile are mutually exclusive" });
const cronFileSchema = z.object({ jobs: z.array(cronJobSchema).default([]) });
/** Dedup jobs by id — last occurrence wins. */
function dedupJobs(jobs) {
	const map = /* @__PURE__ */ new Map();
	for (const job of jobs) map.set(job.id, job);
	return [...map.values()];
}
function parseCronConfig(raw) {
	return { jobs: dedupJobs(cronFileSchema.parse(raw).jobs) };
}
function loadCronConfig(filePath, log) {
	try {
		const content = readFileSync(filePath, "utf-8");
		const config = parseCronConfig(JSON.parse(content));
		log?.info({
			jobs: config.jobs.length,
			enabled: config.jobs.filter((j) => j.enabled).length
		}, "cron config loaded");
		return config;
	} catch (err) {
		if (err.code === "ENOENT") {
			log?.info({ filePath }, "cron config not found, no cron jobs configured");
			return { jobs: [] };
		}
		throw err;
	}
}
function watchCronConfig(filePath, onChange, log) {
	let debounce = null;
	try {
		watch(filePath, () => {
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(() => {
				try {
					onChange(loadCronConfig(filePath, log));
					log.info("cron config reloaded");
				} catch (err) {
					log.error({ err }, "failed to reload cron config, keeping previous");
				}
			}, 300);
		});
		log.info({ filePath }, "watching cron config for changes");
	} catch {
		log.warn({ filePath }, "could not watch cron config file");
	}
}
/** Convert job name to Telegram command name: hyphens → underscores, prefixed with run_ */
function jobNameToCommand(name) {
	return `run_${name.replace(/-/g, "_")}`;
}
/** Convert Telegram command back to job name: strip run_ prefix, underscores → hyphens */
function commandToJobName(command) {
	return command.replace(/^run_/, "").replace(/_/g, "-");
}
//#endregion
//#region src/cron-process-pool.ts
/**
* Separate process pool for cron jobs. Each invocation gets a fresh
* ClaudeProcess (no session resume). Per-job bridge options are supported.
*/
var CronProcessPool = class {
	id = "claude";
	processes = /* @__PURE__ */ new Map();
	defaultOpts;
	constructor(defaultOpts) {
		this.defaultOpts = defaultOpts;
	}
	create(runKey, jobOpts, timer) {
		const opts = jobOpts ? {
			...this.defaultOpts,
			...stripNulls(jobOpts)
		} : this.defaultOpts;
		timer?.mark("cron_process_spawned");
		const proc = new ClaudeProcess(opts);
		this.processes.set(runKey, proc);
		return proc;
	}
	remove(runKey) {
		const proc = this.processes.get(runKey);
		if (proc) {
			proc.close();
			this.processes.delete(runKey);
		}
	}
	closeAll() {
		for (const proc of this.processes.values()) proc.close();
		this.processes.clear();
	}
};
function stripNulls(obj) {
	const result = {};
	for (const [key, value] of Object.entries(obj)) if (value != null) result[key] = value;
	return result;
}
//#endregion
//#region src/cli-token-warmup.ts
/** Refresh if the token will expire within this window. */
const EXPIRY_BUFFER_MS = 300 * 1e3;
const DEFAULT_TIMEOUT_MS = 2e4;
const DEFAULT_POLL_INTERVAL_MS = 100;
function credentialsPath() {
	return join(process.env.HOME ?? "/home/dev", ".claude", ".credentials.json");
}
function readExpiry(path) {
	try {
		return JSON.parse(readFileSync(path, "utf-8")).claudeAiOauth?.expiresAt ?? null;
	} catch {
		return null;
	}
}
function isExpired(expiresAt) {
	const expiresMs = expiresAt > 0xe8d4a51000 ? expiresAt : expiresAt * 1e3;
	return Date.now() + EXPIRY_BUFFER_MS >= expiresMs;
}
function statMtimeMs(path) {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}
function sleep$2(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
/**
* Default warmup spawner. Runs `claude ping` in interactive mode (no
* `-p`) — interactive startup is the code path that actually performs
* the OAuth refresh; pipe mode does not.
*
* We set `CLAUDE_CODE_SANDBOXED=1` to bypass the workspace trust dialog
* (which only appears in non-`-p` mode). The subprocess is not placed
* under landrun, since it needs to write `~/.claude/.credentials.json`
* and we want zero filesystem constraints on the refresh path.
*/
function defaultSpawner() {
	const child = spawn("claude", ["ping"], {
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		env: {
			...process.env,
			CLAUDE_CODE_SANDBOXED: "1"
		}
	});
	child.on("error", () => {});
	child.stdout?.resume();
	child.stderr?.resume();
	return {
		pid: child.pid,
		kill: (signal) => {
			try {
				child.kill(signal);
			} catch {}
		},
		onClose: (cb) => {
			child.once("close", cb);
		}
	};
}
let inflight = null;
/**
* Ensure the OAuth credentials on disk are fresh enough for the next
* Claude CLI subprocess spawn. If the cached access token has already
* expired (or will expire within {@link EXPIRY_BUFFER_MS}), this spawns
* a throwaway `claude ping` in interactive mode — long enough for the
* CLI's own startup lifecycle to hit the OAuth refresh endpoint and
* write the new credentials to disk — then terminates it.
*
* We intentionally go through the real CLI rather than POSTing to
* `/v1/oauth/token` ourselves: Anthropic appears to rate-limit or
* otherwise block direct client calls to that endpoint.
*
* Concurrent callers are coalesced into a single warmup via
* `inflight`, so a burst of Telegram messages does not spawn multiple
* warmups. Resolves as a soft success on timeout or unexpected errors
* — the existing `sendMessageWithAuthRetry` safety net will still try
* to handle any surviving 401s.
*/
async function ensureFreshCliToken(log, options = {}) {
	const path = credentialsPath();
	const expiresAt = readExpiry(path);
	if (expiresAt === null) {
		log.warn({ path }, "could not read credentials — skipping CLI warmup");
		return;
	}
	if (!isExpired(expiresAt)) return;
	if (inflight) return inflight;
	inflight = runWarmup(log, path, options).finally(() => {
		inflight = null;
	});
	return inflight;
}
async function runWarmup(log, path, options) {
	const spawner = options.spawn ?? defaultSpawner;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const beforeMtime = statMtimeMs(path);
	const start = Date.now();
	log.info("OAuth token expired — spawning claude CLI warmup to refresh");
	let child;
	try {
		child = spawner();
	} catch (err) {
		log.error({ err }, "failed to spawn claude CLI warmup — proceeding anyway");
		return;
	}
	let exited = false;
	let exitCode = null;
	const exitPromise = new Promise((resolve) => {
		child.onClose((code) => {
			exited = true;
			exitCode = code;
			resolve();
		});
	});
	const killAndWait = async (signal) => {
		child.kill(signal);
		await exitPromise;
	};
	try {
		while (true) {
			if (exited) {
				const afterMtime = statMtimeMs(path);
				const refreshed = afterMtime !== null && beforeMtime !== null && afterMtime > beforeMtime;
				log.info({
					exitCode,
					elapsedMs: Date.now() - start,
					refreshed
				}, "CLI warmup exited naturally");
				return;
			}
			if (Date.now() - start >= timeoutMs) {
				log.warn({ elapsedMs: Date.now() - start }, "CLI warmup timed out — SIGKILL and proceeding");
				await killAndWait("SIGKILL");
				return;
			}
			const currentMtime = statMtimeMs(path);
			if (currentMtime !== null && beforeMtime !== null && currentMtime > beforeMtime) {
				log.info({ elapsedMs: Date.now() - start }, "credentials refreshed by CLI warmup — terminating");
				await killAndWait("SIGTERM");
				return;
			}
			await sleep$2(pollIntervalMs);
		}
	} catch (err) {
		log.error({ err }, "CLI warmup unexpected error — killing child");
		try {
			await killAndWait("SIGKILL");
		} catch {}
	}
}
//#endregion
//#region src/prompt-builder.ts
function readPromptFile(dir, filename) {
	try {
		return readFileSync(join(dir, filename), "utf-8").trim();
	} catch {
		return "";
	}
}
/**
* Build a system prompt by concatenating markdown files from the prompts directory.
*
* Composition: base.md + {tier}.md + jobSystemPrompt (cron only)
*
* Returns undefined if all sections are empty/missing, letting the caller
* fall back to its default system prompt.
*/
function buildSystemPrompt(promptsDir, tier, jobSystemPrompt) {
	const base = readPromptFile(promptsDir, "base.md");
	const tierContent = readPromptFile(promptsDir, `${tier}.md`);
	const parts = [];
	if (base) parts.push(base);
	if (tierContent) parts.push(tierContent);
	if (jobSystemPrompt) parts.push(jobSystemPrompt);
	if (parts.length === 0) return void 0;
	return parts.join("\n\n");
}
//#endregion
//#region src/request-timer.ts
var RequestTimer = class {
	start = performance.now();
	marks = [];
	mark(name) {
		this.marks.push([name, performance.now() - this.start]);
	}
	summary() {
		const result = {};
		for (const [name, elapsed] of this.marks) result[name] = Math.round(elapsed);
		result.total = Math.round(performance.now() - this.start);
		return result;
	}
};
//#endregion
//#region src/markdown-telegram.ts
const MAX_LENGTH = 4096;
const TRACKED_TAGS = new Set([
	"b",
	"i",
	"u",
	"s",
	"code",
	"pre",
	"a",
	"span",
	"blockquote"
]);
/**
* Convert markdown (as produced by Claude) to Telegram-compatible HTML.
* Returns the raw text unchanged if conversion produces an empty result.
*/
function markdownToTelegramHtml(markdown) {
	return telegramFormat(normalizeInlineCode(markdown)) || markdown;
}
function normalizeInlineCode(markdown) {
	return markdown.replace(/``([^`\n]+)``/g, "`$1`");
}
/**
* Split an HTML string into chunks that fit within Telegram's 4096-char limit.
* Each chunk is independently balanced: tags that would span a boundary are
* closed at the end of one chunk and re-opened at the start of the next,
* preserving attributes verbatim (e.g. `<blockquote expandable>`).
*/
function splitHtml(html) {
	const chunks = [];
	const parts = html.split(/(<pre><code[^>]*>[\s\S]*?<\/code><\/pre>|<pre>[\s\S]*?<\/pre>)/g);
	for (const part of parts) {
		if (!part) continue;
		if (part.startsWith("<pre>") || part.startsWith("<pre><code")) chunks.push(...splitPreBlock(part));
		else chunks.push(...splitFlowingHtml(part));
	}
	return mergeChunks(chunks);
}
var TagTracker = class TagTracker {
	openTags = [];
	feed(html) {
		for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
			const isClosing = m[1] === "/";
			const name = m[2];
			if (!TRACKED_TAGS.has(name)) continue;
			if (isClosing) {
				for (let i = this.openTags.length - 1; i >= 0; i--) if (this.openTags[i]?.name === name) {
					this.openTags.splice(i, 1);
					break;
				}
			} else this.openTags.push({
				name,
				raw: m[3] ?? ""
			});
		}
	}
	openHtml() {
		return this.openTags.map((t) => `<${t.name}${t.raw}>`).join("");
	}
	closeHtml() {
		return [...this.openTags].reverse().map((t) => `</${t.name}>`).join("");
	}
	clone() {
		const t = new TagTracker();
		t.openTags = this.openTags.map((o) => ({
			name: o.name,
			raw: o.raw
		}));
		return t;
	}
};
function splitFlowingHtml(text) {
	const chunks = [];
	const tracker = new TagTracker();
	const blocks = text.split(/(\n\s*\n|<br\s*\/?>(?:\n)?|\n)/);
	let openPrefix = "";
	let current = "";
	const flush = () => {
		if (!current) return;
		const close = tracker.closeHtml();
		chunks.push(openPrefix + current + close);
		openPrefix = tracker.openHtml();
		current = "";
	};
	for (const block of blocks) {
		if (block === void 0 || block === "") continue;
		const peek = tracker.clone();
		peek.feed(block);
		if (openPrefix.length + current.length + block.length + peek.closeHtml().length > MAX_LENGTH && current) flush();
		current += block;
		tracker.feed(block);
	}
	flush();
	return chunks;
}
function splitPreBlock(preBlock) {
	const langAware = preBlock.match(/^<pre><code([^>]*)>([\s\S]*)<\/code><\/pre>$/);
	if (langAware) {
		const [, attr = "", content = ""] = langAware;
		return splitPreLines(content, `<pre><code${attr}>`, "</code></pre>");
	}
	return splitPreLines(preBlock.slice(5, -6), "<pre>", "</pre>");
}
function splitPreLines(content, openTag, closeTag) {
	const overhead = openTag.length + closeTag.length;
	const chunks = [];
	const pieces = content.split(/(\r?\n)/);
	let buf = "";
	for (const piece of pieces) {
		if (buf.length + piece.length + overhead > MAX_LENGTH && buf) {
			chunks.push(openTag + buf + closeTag);
			buf = "";
		}
		buf += piece;
	}
	if (buf) chunks.push(openTag + buf + closeTag);
	return chunks;
}
function mergeChunks(chunks) {
	const merged = [];
	let buf = "";
	for (const c of chunks) if (!buf) buf = c;
	else if (buf.length + c.length <= MAX_LENGTH) buf += c;
	else {
		merged.push(buf);
		buf = c;
	}
	if (buf) merged.push(buf);
	return merged;
}
//#endregion
//#region src/streaming.ts
const EDIT_INTERVAL_MS = 1500;
const TYPING_INTERVAL_MS = 4e3;
const MAX_MESSAGE_LENGTH = 4096;
const STREAM_INTERRUPTED_MARKER = "[Stream interrupted — the Claude CLI run ended before completion]";
async function streamToTelegram(client, ctx, events, log, timer, onEvent) {
	log.info({
		chatId: ctx.chatId,
		threadId: ctx.messageThreadId,
		replyToMessageId: ctx.replyToMessageId
	}, "stream started");
	const TYPING_STALE_MS = TYPING_INTERVAL_MS * 2;
	let lastEventAt = 0;
	const sendTyping = () => client.sendChatAction({
		chat_id: ctx.chatId,
		action: "typing",
		...ctx.messageThreadId && { message_thread_id: ctx.messageThreadId }
	}).catch(() => {});
	await sendTyping();
	lastEventAt = Date.now();
	const typingInterval = setInterval(() => {
		if (Date.now() - lastEventAt < TYPING_STALE_MS) sendTyping();
	}, TYPING_INTERVAL_MS);
	let messageId = null;
	let turnText = "";
	let textSegments = [];
	let currentSegment = "";
	let lastEditText = "";
	let lastEditTime = 0;
	let currentTool = "";
	let turnTools = [];
	let afterToolResult = false;
	let aggregateText = "";
	const aggregateTools = [];
	let sessionId = null;
	let errorText = null;
	let firstTokenMarked = false;
	let costUsd = null;
	let inputTokens = null;
	let outputTokens = null;
	let contextWindow = null;
	let model = null;
	let completed = false;
	let interrupted = false;
	const finalizeTurn = async () => {
		if (currentSegment) {
			textSegments.push(currentSegment);
			currentSegment = "";
		}
		if (textSegments.length === 0 && !errorText && !interrupted) return;
		let finalText;
		let finalSegments;
		if (errorText) {
			finalText = turnText ? `${truncate(turnText)}\n\n[Error: ${errorText}]` : `Error: ${errorText}`;
			finalSegments = [finalText];
		} else if (interrupted && textSegments.length === 0) {
			finalText = STREAM_INTERRUPTED_MARKER;
			finalSegments = [finalText];
		} else {
			finalText = turnText || "No response from Claude.";
			finalSegments = textSegments;
		}
		await sendFinalResponse(client, ctx, messageId, finalText, finalSegments, lastEditText, log);
		messageId = null;
		turnText = "";
		textSegments = [];
		currentSegment = "";
		lastEditText = "";
		lastEditTime = 0;
		currentTool = "";
		turnTools = [];
		afterToolResult = false;
	};
	try {
		try {
			for await (const event of events) {
				onEvent?.(event);
				let shouldUpdate = false;
				lastEventAt = Date.now();
				switch (event.type) {
					case "text_delta":
						if (!firstTokenMarked) {
							firstTokenMarked = true;
							timer?.mark("first_token");
						}
						if (afterToolResult && turnText.length > 0) {
							textSegments.push(currentSegment);
							currentSegment = "";
							afterToolResult = false;
						}
						currentSegment += event.content;
						turnText += event.content;
						aggregateText += event.content;
						shouldUpdate = true;
						break;
					case "tool_use": {
						const detail = summarizeToolInput(event.toolName, event.input);
						const label = detail ? `${event.toolName}: ${detail}` : event.toolName;
						currentTool = label;
						turnTools.push(label);
						aggregateTools.push(label);
						shouldUpdate = true;
						break;
					}
					case "tool_result":
						currentTool = "";
						afterToolResult = true;
						shouldUpdate = true;
						break;
					case "turn_complete":
						completed = true;
						if (event.sessionId) sessionId = event.sessionId;
						if (event.costUsd != null) costUsd = event.costUsd;
						if (event.inputTokens != null) inputTokens = event.inputTokens;
						if (event.outputTokens != null) outputTokens = event.outputTokens;
						if (event.contextWindow != null) contextWindow = event.contextWindow;
						await finalizeTurn();
						break;
					case "error":
						errorText = event.message;
						if (event.sessionId) sessionId = event.sessionId;
						break;
					case "session_meta":
						if (event.model) model = event.model;
						break;
					case "thinking_delta": break;
				}
				const now = Date.now();
				if (shouldUpdate && now - lastEditTime >= EDIT_INTERVAL_MS) {
					const displayText = buildDisplayText(turnText, currentTool, turnTools);
					if (displayText && displayText !== lastEditText) {
						messageId = await sendOrEdit(client, ctx, messageId, displayText, log);
						lastEditText = displayText;
						lastEditTime = now;
					}
				}
			}
		} catch (err) {
			log.warn({ err }, "stream iterator threw — marking stream as interrupted");
			interrupted = true;
		}
		if (!completed && !errorText && !interrupted) interrupted = true;
		timer?.mark("stream_complete");
		await finalizeTurn();
		timer?.mark("response_sent");
	} finally {
		clearInterval(typingInterval);
	}
	log.info({
		chatId: ctx.chatId,
		threadId: ctx.messageThreadId,
		sessionId,
		responseLen: aggregateText.length,
		responsePreview: aggregateText.slice(0, 200),
		toolCount: aggregateTools.length,
		interrupted,
		error: errorText,
		inputTokens,
		outputTokens
	}, "stream complete");
	return {
		sessionId,
		responseText: aggregateText,
		toolHistory: aggregateTools,
		error: errorText,
		interrupted,
		costUsd,
		inputTokens,
		outputTokens,
		contextWindow,
		model
	};
}
async function sendOrEdit(client, ctx, messageId, text, log) {
	const truncated = truncate(text);
	if (messageId === null) return (await client.sendMessage({
		chat_id: ctx.chatId,
		text: truncated,
		...ctx.messageThreadId && { message_thread_id: ctx.messageThreadId }
	})).message_id;
	await tryEdit(client, ctx.chatId, messageId, truncated, log);
	return messageId;
}
function buildDisplayText(text, currentTool, toolHistory) {
	if (!text && !currentTool && toolHistory.length === 0) return "";
	if (!text) {
		const lines = toolHistory.map((t) => `> ${t}`);
		if (currentTool) lines[lines.length - 1] = `> ${currentTool} ...`;
		return truncate(lines.join("\n"));
	}
	let display = truncate(text);
	if (currentTool) {
		const footer = `\n\n> ${currentTool} ...`;
		display = truncate(text, MAX_MESSAGE_LENGTH - footer.length) + footer;
	}
	return display;
}
function truncate(text, limit = MAX_MESSAGE_LENGTH) {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 4)}...`;
}
async function trySendHtml(client, ctx, html, log) {
	try {
		await client.sendMessage({
			chat_id: ctx.chatId,
			text: html,
			parse_mode: "HTML",
			...ctx.messageThreadId && { message_thread_id: ctx.messageThreadId }
		});
		return true;
	} catch (err) {
		log.warn({ err }, "HTML send failed, falling back to plain text");
		return false;
	}
}
async function tryEditHtml(client, chatId, messageId, html, log) {
	try {
		await client.editMessageText({
			chat_id: chatId,
			message_id: messageId,
			text: html,
			parse_mode: "HTML"
		});
		return true;
	} catch (err) {
		if (String(err).includes("message is not modified")) return true;
		log.warn({ err }, "HTML edit failed, falling back to plain text");
		return false;
	}
}
async function tryEdit(client, chatId, messageId, text, log) {
	try {
		await client.editMessageText({
			chat_id: chatId,
			message_id: messageId,
			text: truncate(text)
		});
	} catch (err) {
		if (!String(err).includes("message is not modified")) log.debug({ err }, "edit message failed");
	}
}
async function sendFinalResponse(client, ctx, messageId, plainText, segments, lastEditText, log) {
	const chunks = splitHtml(buildFinalHtml(segments));
	const firstChunk = chunks[0];
	if (firstChunk) {
		if (messageId !== null) {
			if (!await tryEditHtml(client, ctx.chatId, messageId, firstChunk, log)) await tryEdit(client, ctx.chatId, messageId, truncate(plainText), log);
		} else if (!await trySendHtml(client, ctx, firstChunk, log)) await trySendPlain(client, ctx, truncate(plainText), log);
	}
	for (let i = 1; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) continue;
		if (!await trySendHtml(client, ctx, chunk, log)) {
			const plainChunk = splitText(plainText, MAX_MESSAGE_LENGTH)[i];
			if (plainChunk) await trySendPlain(client, ctx, plainChunk, log);
		}
	}
}
async function trySendPlain(client, ctx, text, log) {
	try {
		await client.sendMessage({
			chat_id: ctx.chatId,
			text,
			...ctx.messageThreadId && { message_thread_id: ctx.messageThreadId }
		});
	} catch (err) {
		log.warn({ err }, "plain text send failed");
	}
}
/**
* Build final HTML from text segments.
* If there are multiple segments, all intermediate ones are joined and
* wrapped in a single expandable blockquote (collapsible in Telegram).
* The last segment is the primary response shown prominently.
*/
function buildFinalHtml(segments) {
	if (segments.length === 0) return markdownToTelegramHtml("No response from Claude.");
	if (segments.length === 1) return markdownToTelegramHtml(segments[0]);
	return `<blockquote expandable>${markdownToTelegramHtml(segments.slice(0, -1).map((s) => s.trim()).filter(Boolean).join(" ; "))}</blockquote>\n\n${markdownToTelegramHtml(segments[segments.length - 1])}`;
}
/**
* Drain a Claude event stream without sending to Telegram.
* Collects the full response for logging.
*/
async function consumeEvents(events, timer, onEvent) {
	let accumulatedText = "";
	const toolHistory = [];
	let sessionId = null;
	let errorText = null;
	let firstTokenMarked = false;
	let costUsd = null;
	let inputTokens = null;
	let outputTokens = null;
	let contextWindow = null;
	let model = null;
	let completed = false;
	let interrupted = false;
	try {
		for await (const event of events) {
			onEvent?.(event);
			switch (event.type) {
				case "text_delta":
					if (!firstTokenMarked) {
						firstTokenMarked = true;
						timer?.mark("first_token");
					}
					accumulatedText += event.content;
					break;
				case "tool_use": {
					const detail = summarizeToolInput(event.toolName, event.input);
					const label = detail ? `${event.toolName}: ${detail}` : event.toolName;
					toolHistory.push(label);
					break;
				}
				case "turn_complete":
					completed = true;
					if (event.sessionId) sessionId = event.sessionId;
					if (event.costUsd != null) costUsd = event.costUsd;
					if (event.inputTokens != null) inputTokens = event.inputTokens;
					if (event.outputTokens != null) outputTokens = event.outputTokens;
					if (event.contextWindow != null) contextWindow = event.contextWindow;
					break;
				case "session_meta":
					if (event.model) model = event.model;
					break;
				case "error":
					errorText = event.message;
					if (event.sessionId) sessionId = event.sessionId;
					break;
			}
		}
	} catch {
		interrupted = true;
	}
	if (!completed && !errorText && !interrupted) interrupted = true;
	timer?.mark("stream_complete");
	return {
		sessionId,
		responseText: accumulatedText,
		toolHistory,
		error: errorText,
		interrupted,
		costUsd,
		inputTokens,
		outputTokens,
		contextWindow,
		model
	};
}
function splitText(text, maxLen) {
	const chunks = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxLen) {
			chunks.push(remaining);
			break;
		}
		let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
		if (splitIdx < maxLen / 2) splitIdx = remaining.lastIndexOf("\n", maxLen);
		if (splitIdx < maxLen / 2) splitIdx = maxLen;
		chunks.push(remaining.slice(0, splitIdx));
		remaining = remaining.slice(splitIdx).replace(/^\n+/, "");
	}
	return chunks;
}
//#endregion
//#region src/cron-handler.ts
const CRON_IDLE_CLOSE_MS = 3e4;
async function* withCronIdleClose(source, closeProc, idleMs) {
	let timer = null;
	const cancel = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};
	try {
		for await (const ev of source) {
			cancel();
			yield ev;
			if (ev.type === "turn_complete") timer = setTimeout(closeProc, idleMs);
		}
	} finally {
		cancel();
	}
}
const TRANSIENT_PATTERNS = [
	"rate_limit",
	"overloaded",
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"timeout",
	"spawn",
	"529",
	"503",
	"interrupted"
];
function isTransientError(err) {
	const msg = String(err);
	return TRANSIENT_PATTERNS.some((p) => msg.includes(p));
}
const BACKOFF_MS = [
	3e4,
	6e4,
	3e5,
	9e5
];
function computeBackoffMs(consecutiveErrors) {
	return BACKOFF_MS[Math.min(consecutiveErrors - 1, BACKOFF_MS.length - 1)] ?? 9e5;
}
function resolvePrompt(job, defaultWorkingDir) {
	if (job.prompt) return job.prompt;
	if (job.promptFile) return readFileSync(resolve(job.workingDir != null ? String(job.workingDir) : defaultWorkingDir, job.promptFile), "utf-8");
	throw new Error(`Job "${job.name}" (${job.id}) has neither prompt nor promptFile`);
}
async function executeCronJob(job, deps, opts = {}) {
	const timer = new RequestTimer();
	const runKey = `cron:${job.id}:${Date.now()}`;
	const { log, backends, stateStore, client, conversationLogger } = deps;
	const backendId = job.backend ?? backends.defaultId;
	const cronPool = backends.cronPool(backendId);
	log.info({
		job: job.name,
		id: job.id,
		backend: backendId,
		manual: opts.manual ?? false,
		runKey
	}, "cron job starting");
	let prompt;
	try {
		prompt = resolvePrompt(job, deps.defaultWorkingDir);
	} catch (err) {
		const errorMsg = String(err);
		log.error({
			job: job.name,
			id: job.id,
			err
		}, "prompt resolution failed");
		recordFailure(job, deps, errorMsg, false);
		return {
			status: "error",
			error: errorMsg,
			durationMs: 0
		};
	}
	timer.mark("prompt_resolved");
	const jobOpts = {};
	if (job.workingDir != null) jobOpts.workingDir = job.workingDir;
	if (job.model != null) jobOpts.model = job.model;
	const cronSystemPrompt = buildSystemPrompt(deps.promptsDir, "cron", job.systemPrompt);
	if (cronSystemPrompt !== void 0) jobOpts.systemPrompt = cronSystemPrompt;
	const jobOptsArg = Object.keys(jobOpts).length > 0 ? jobOpts : void 0;
	try {
		if (backendId === "claude") try {
			await ensureFreshCliToken(log);
		} catch (err) {
			log.error({ err }, "CLI token warmup failed — proceeding anyway");
		}
		const content = [{
			type: "text",
			text: prompt
		}];
		const cronConvId = `cron:${job.id}`;
		deps.sessionRecorder.start({
			conversationId: cronConvId,
			backend: backendId
		});
		deps.sessionRecorder.recordUserInput(cronConvId, prompt);
		const recordEvent = (ev) => deps.sessionRecorder.recordEvent(cronConvId, ev);
		let currentProc = cronPool.create(runKey, jobOptsArg, timer);
		const wrapped = withCronIdleClose(sendMessageWithAuthRetry(currentProc, () => {
			currentProc = cronPool.create(runKey, jobOptsArg, timer);
			return currentProc;
		}, () => cronPool.remove(runKey), content, timer, log), () => currentProc.close(), CRON_IDLE_CLOSE_MS);
		const chatId = opts.overrideChatId ?? job.chatId;
		const threadId = opts.overrideThreadId ?? job.threadId;
		let result;
		if (chatId) result = await streamToTelegram(client, {
			chatId,
			messageThreadId: threadId
		}, wrapped, log, timer, recordEvent);
		else result = await consumeEvents(wrapped, timer, recordEvent);
		deps.sessionRecorder.end(cronConvId);
		timer.mark("done");
		const timings = timer.summary();
		const failureReason = result.error ?? (result.interrupted ? "stream interrupted" : null);
		conversationLogger.log({
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			conversationId: cronConvId,
			sessionId: result.sessionId ?? runKey,
			sender: {
				id: null,
				name: `cron:${job.name}`,
				username: null
			},
			input: `[cron:${job.name}] ${prompt.slice(0, 200)}`,
			output: result.responseText,
			tools: result.toolHistory,
			durationMs: timings.total ?? 0,
			timings,
			error: failureReason
		});
		if (failureReason) {
			recordFailure(job, deps, failureReason, isTransientError(failureReason));
			return {
				status: "error",
				error: failureReason,
				durationMs: timings.total ?? 0
			};
		}
		const state = stateStore.get(job.id);
		stateStore.upsert({
			jobId: job.id,
			nextRunAtMs: state?.nextRunAtMs ?? null,
			lastRunAtMs: Date.now(),
			lastRunStatus: "ok",
			lastError: null,
			lastDurationMs: timings.total ?? 0,
			consecutiveErrors: 0,
			runningAtMs: null,
			lastFailureAlertAtMs: state?.lastFailureAlertAtMs ?? null
		});
		log.info({
			job: job.name,
			id: job.id,
			durationMs: timings.total,
			tools: result.toolHistory.length
		}, "cron job completed");
		return {
			status: "ok",
			durationMs: timings.total ?? 0
		};
	} catch (err) {
		const errorMsg = String(err);
		const isTransient = isTransientError(err);
		log.error({
			job: job.name,
			id: job.id,
			err,
			transient: isTransient
		}, "cron job failed");
		recordFailure(job, deps, errorMsg, isTransient);
		return {
			status: "error",
			error: errorMsg,
			durationMs: timer.summary().total ?? 0
		};
	} finally {
		cronPool.remove(runKey);
	}
}
function recordFailure(job, deps, errorMsg, isTransient) {
	const { stateStore, log } = deps;
	const existing = stateStore.get(job.id);
	const consecutive = (existing?.consecutiveErrors ?? 0) + 1;
	stateStore.upsert({
		jobId: job.id,
		nextRunAtMs: existing?.nextRunAtMs ?? null,
		lastRunAtMs: Date.now(),
		lastRunStatus: "error",
		lastError: errorMsg.slice(0, 1e3),
		lastDurationMs: null,
		consecutiveErrors: consecutive,
		runningAtMs: null,
		lastFailureAlertAtMs: existing?.lastFailureAlertAtMs ?? null
	});
	if (consecutive >= deps.failureAlertAfter) {
		const lastAlertAt = existing?.lastFailureAlertAtMs ?? 0;
		const now = Date.now();
		if (now - lastAlertAt >= deps.failureAlertCooldownMs) {
			sendFailureAlert(job, deps, consecutive, errorMsg, isTransient);
			stateStore.upsert({
				jobId: job.id,
				nextRunAtMs: existing?.nextRunAtMs ?? null,
				lastRunAtMs: Date.now(),
				lastRunStatus: "error",
				lastError: errorMsg.slice(0, 1e3),
				lastDurationMs: null,
				consecutiveErrors: consecutive,
				runningAtMs: null,
				lastFailureAlertAtMs: now
			});
		}
	}
	if (consecutive >= deps.autoDisableAfter) log.warn({
		job: job.name,
		id: job.id,
		consecutiveErrors: consecutive
	}, "auto-disabling cron job after persistent failures");
}
function sendFailureAlert(job, deps, consecutive, errorMsg, isTransient) {
	const chatId = job.failureAlertChatId ?? deps.getAdminChatId();
	if (!chatId) {
		deps.log.warn({ job: job.name }, "failure alert skipped — no alert chat configured");
		return;
	}
	const lines = [
		`Cron job "${job.name}" failed (${consecutive} consecutive)`,
		`Transient: ${isTransient ? "yes" : "no"}`,
		`Error: ${errorMsg.slice(0, 500)}`
	];
	if (consecutive >= deps.autoDisableAfter) lines.push("Job has been auto-disabled.");
	deps.client.sendMessage({
		chat_id: chatId,
		text: lines.join("\n")
	}).catch((err) => {
		deps.log.error({
			err,
			job: job.name
		}, "failed to send failure alert");
	});
}
//#endregion
//#region src/cron-scheduler.ts
const MAX_TIMER_DELAY_MS = 6e4;
const STARTUP_MAX_IMMEDIATE = 3;
const STARTUP_STAGGER_MS = 1e4;
var CronScheduler = class {
	timer = null;
	running = false;
	activeJobs = /* @__PURE__ */ new Set();
	disabledRuntime = /* @__PURE__ */ new Set();
	opts;
	constructor(opts) {
		this.opts = opts;
	}
	start() {
		if (this.running) return;
		this.running = true;
		const config = this.opts.getCronConfig();
		if (config.jobs.length === 0) {
			this.opts.log.info("no cron jobs configured, scheduler idle");
			this.armTimer();
			return;
		}
		this.initializeJobStates(config.jobs);
		setImmediate(() => {
			if (!this.running) return;
			try {
				this.runStartupCatchup(config.jobs);
			} catch (err) {
				this.opts.log.error({ err }, "startup catchup threw — continuing");
			}
		});
		this.armTimer();
	}
	stop() {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}
	onConfigReload(config) {
		for (const job of config.jobs) if (job.enabled) this.disabledRuntime.delete(job.id);
		this.initializeJobStates(config.jobs);
		if (this.running) {
			if (this.timer) clearTimeout(this.timer);
			this.armTimer();
		}
	}
	/** Manual trigger from /run_* command. Looks up job by name. */
	async runJob(jobName, opts) {
		const job = this.opts.getCronConfig().jobs.find((j) => j.name === jobName);
		if (!job) return { found: false };
		if (this.activeJobs.has(job.id)) return {
			found: true,
			busy: true
		};
		this.executeWithGuard(job, {
			...opts,
			manual: true
		});
		return { found: true };
	}
	armTimer() {
		if (!this.running) return;
		const config = this.opts.getCronConfig();
		const now = Date.now();
		let soonest = now + MAX_TIMER_DELAY_MS;
		for (const job of config.jobs) {
			if (!this.isJobEnabled(job)) continue;
			const state = this.opts.stateStore.get(job.id);
			if (state?.nextRunAtMs && state.nextRunAtMs < soonest) soonest = state.nextRunAtMs;
		}
		const delay = Math.max(0, Math.min(soonest - now, MAX_TIMER_DELAY_MS));
		this.timer = setTimeout(() => this.onTick(), delay);
	}
	onTick() {
		if (!this.running) return;
		const config = this.opts.getCronConfig();
		const now = Date.now();
		const { log, stateStore } = this.opts;
		const stuckTimeoutMs = this.opts.handlerDeps.stuckTimeoutMs;
		for (const job of config.jobs) {
			if (!this.isJobEnabled(job)) continue;
			const state = stateStore.get(job.id);
			if (!state?.nextRunAtMs || state.nextRunAtMs > now) continue;
			if (state.runningAtMs) if (now - state.runningAtMs > stuckTimeoutMs) {
				log.warn({
					job: job.name,
					id: job.id,
					runningForMs: now - state.runningAtMs
				}, "clearing stuck cron job");
				stateStore.clearRunning(job.id);
				this.activeJobs.delete(job.id);
			} else {
				log.debug({
					job: job.name,
					id: job.id
				}, "cron job still running, skipping tick");
				continue;
			}
			if (this.activeJobs.has(job.id)) continue;
			this.executeWithGuard(job);
		}
		this.armTimer();
	}
	executeWithGuard(job, opts = {}) {
		if (this.activeJobs.has(job.id)) return;
		this.activeJobs.add(job.id);
		const { stateStore, log } = this.opts;
		stateStore.markRunning(job.id, Date.now());
		executeCronJob(job, this.opts.handlerDeps, opts).then((result) => {
			if (result.status === "error" && this.shouldAutoDisable(job.id)) {
				this.disabledRuntime.add(job.id);
				log.warn({
					job: job.name,
					id: job.id
				}, "cron job auto-disabled");
			}
		}).catch((err) => {
			log.error({
				err,
				job: job.name,
				id: job.id
			}, "unexpected cron execution error");
		}).finally(() => {
			stateStore.clearRunning(job.id);
			this.activeJobs.delete(job.id);
			if (!opts.manual) this.scheduleNextRun(job);
		});
	}
	scheduleNextRun(job) {
		const { stateStore } = this.opts;
		const state = stateStore.get(job.id);
		const now = Date.now();
		let nextMs;
		try {
			const nextDate = new Cron(job.schedule, { timezone: job.timezone }).nextRun(new Date(now));
			nextMs = nextDate ? nextDate.getTime() : now + MAX_TIMER_DELAY_MS;
		} catch {
			this.opts.log.error({
				job: job.name,
				id: job.id,
				schedule: job.schedule
			}, "invalid cron expression");
			return;
		}
		const errors = state?.consecutiveErrors ?? 0;
		if (errors > 0) {
			const backoffMs = computeBackoffMs(errors);
			nextMs = Math.max(nextMs, now + backoffMs);
		}
		stateStore.upsert({
			jobId: job.id,
			nextRunAtMs: nextMs,
			lastRunAtMs: state?.lastRunAtMs ?? null,
			lastRunStatus: state?.lastRunStatus ?? null,
			lastError: state?.lastError ?? null,
			lastDurationMs: state?.lastDurationMs ?? null,
			consecutiveErrors: state?.consecutiveErrors ?? 0,
			runningAtMs: null,
			lastFailureAlertAtMs: state?.lastFailureAlertAtMs ?? null
		});
	}
	initializeJobStates(jobs) {
		for (const job of jobs) {
			if (!job.enabled) continue;
			if (!this.opts.stateStore.get(job.id)) {
				const nextMs = this.computeNextRunMs(job);
				if (nextMs) this.opts.stateStore.upsert({
					jobId: job.id,
					nextRunAtMs: nextMs,
					lastRunAtMs: null,
					lastRunStatus: null,
					lastError: null,
					lastDurationMs: null,
					consecutiveErrors: 0,
					runningAtMs: null,
					lastFailureAlertAtMs: null
				});
			}
		}
	}
	runStartupCatchup(jobs) {
		const now = Date.now();
		const overdue = [];
		for (const job of jobs) {
			if (!this.isJobEnabled(job)) continue;
			const state = this.opts.stateStore.get(job.id);
			if (state?.runningAtMs) this.opts.stateStore.clearRunning(job.id);
			if (state?.nextRunAtMs && state.nextRunAtMs <= now) overdue.push(job);
		}
		if (overdue.length === 0) return;
		this.opts.log.info({
			count: overdue.length,
			jobs: overdue.map((j) => j.name)
		}, "startup catchup — running overdue jobs");
		for (let i = 0; i < overdue.length; i++) {
			const job = overdue[i];
			if (!job) continue;
			if (i < STARTUP_MAX_IMMEDIATE) this.executeWithGuard(job);
			else {
				const delay = (i - STARTUP_MAX_IMMEDIATE + 1) * STARTUP_STAGGER_MS;
				setTimeout(() => {
					if (this.running) this.executeWithGuard(job);
				}, delay);
			}
		}
	}
	isJobEnabled(job) {
		return job.enabled && !this.disabledRuntime.has(job.id);
	}
	shouldAutoDisable(jobId) {
		return (this.opts.stateStore.get(jobId)?.consecutiveErrors ?? 0) >= this.opts.handlerDeps.autoDisableAfter;
	}
	computeNextRunMs(job) {
		try {
			const next = new Cron(job.schedule, { timezone: job.timezone }).nextRun(/* @__PURE__ */ new Date());
			return next ? next.getTime() : null;
		} catch {
			this.opts.log.error({
				job: job.name,
				id: job.id,
				schedule: job.schedule
			}, "invalid cron expression, skipping");
			return null;
		}
	}
};
//#endregion
//#region src/cron-state.ts
function createCronStateStore(db) {
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
	function rowToState(row) {
		return {
			jobId: row.job_id,
			nextRunAtMs: row.next_run_at_ms ?? null,
			lastRunAtMs: row.last_run_at_ms ?? null,
			lastRunStatus: row.last_run_status ?? null,
			lastError: row.last_error ?? null,
			lastDurationMs: row.last_duration_ms ?? null,
			consecutiveErrors: row.consecutive_errors ?? 0,
			runningAtMs: row.running_at_ms ?? null,
			lastFailureAlertAtMs: row.last_failure_alert_at_ms ?? null
		};
	}
	return {
		get(jobId) {
			const row = getStmt.get(jobId);
			return row ? rowToState(row) : null;
		},
		getAll() {
			return getAllStmt.all().map(rowToState);
		},
		upsert(state) {
			upsertStmt.run(state.jobId, state.nextRunAtMs, state.lastRunAtMs, state.lastRunStatus, state.lastError, state.lastDurationMs, state.consecutiveErrors, state.runningAtMs, state.lastFailureAlertAtMs);
		},
		markRunning(jobId, nowMs) {
			markRunningStmt.run(nowMs, jobId);
		},
		clearRunning(jobId) {
			clearRunningStmt.run(jobId);
		},
		delete(jobId) {
			deleteStmt.run(jobId);
		}
	};
}
//#endregion
//#region src/logger.ts
function todayStr() {
	return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
}
var DailyFileStream = class {
	currentDate;
	dest;
	logDir;
	constructor(logDir) {
		mkdirSync(logDir, { recursive: true });
		this.logDir = logDir;
		this.currentDate = todayStr();
		this.dest = pino.destination(join(logDir, `${this.currentDate}.log`));
	}
	write(data) {
		const today = todayStr();
		if (today !== this.currentDate) {
			this.dest.flushSync?.();
			this.dest.end?.();
			this.currentDate = today;
			this.dest = pino.destination(join(this.logDir, `${today}.log`));
		}
		this.dest.write(data);
		return true;
	}
	flushSync() {
		this.dest.flushSync?.();
	}
	end() {
		this.dest.flushSync?.();
		this.dest.end?.();
	}
};
function createLogger(config) {
	const daily = new DailyFileStream(config.logDir);
	const stream = pino.multistream([{ stream: process.stdout }, { stream: daily }]);
	return {
		logger: pino({ level: config.logLevel }, stream),
		close: () => daily.end()
	};
}
//#endregion
//#region src/message-context.ts
function buildConversationId(params) {
	if (params.chatType === "private") return `tg:dm:${params.senderId ?? params.chatId}`;
	const base = `tg:group:${params.chatId}`;
	if (params.isForum && params.threadId != null) return `${base}:topic:${params.threadId}`;
	return base;
}
function extractMessageContext(message) {
	const chat = message.chat;
	const from = message.from;
	const isGroup = chat.type === "group" || chat.type === "supergroup";
	const isForum = chat.type === "supergroup" && chat.is_forum === true && message.message_thread_id != null;
	const threadId = isForum ? message.message_thread_id ?? null : null;
	const senderId = from?.id ?? null;
	const senderUsername = from?.username ?? null;
	const senderName = from?.username ?? from?.first_name ?? "unknown";
	const chatTitle = isGroup ? chat.title ?? null : null;
	return {
		conversationId: buildConversationId({
			chatType: chat.type,
			chatId: chat.id,
			senderId,
			threadId,
			isForum
		}),
		chatType: chat.type,
		chatId: chat.id,
		chatTitle,
		senderId,
		senderName,
		senderUsername,
		threadId,
		isForum
	};
}
//#endregion
//#region src/stats-format.ts
const fmt = (n) => n.toLocaleString("en-US");
const TERMINATION_LABELS = {
	awaiting_user: "awaiting user",
	tool_call_pending: "tool call in progress",
	clean: "ended cleanly",
	truncated: "truncated",
	unknown: "unknown"
};
const OUTCOME_LABELS = {
	completed: "completed",
	abandoned: "abandoned",
	errored: "errored",
	unknown: "unknown"
};
function formatStatsMessage(signals) {
	const lines = ["Session Stats", ""];
	lines.push(`Session: ${signals.sessionId ?? "unknown"}`);
	if (signals.model) lines.push(`Model: ${signals.model}`);
	if (signals.hasPeakContextTokens && signals.contextWindow) {
		const pct = (signals.peakContextTokens / signals.contextWindow * 100).toFixed(1);
		lines.push(`Context peak: ${fmt(signals.peakContextTokens)} / ${fmt(signals.contextWindow)} (${pct}%)`);
	} else if (signals.hasPeakContextTokens) lines.push(`Context peak: ${fmt(signals.peakContextTokens)}`);
	lines.push("");
	if (signals.hasTotalOutputTokens) lines.push(`Output tokens: ${fmt(signals.totalOutputTokens)}`);
	if (signals.totalCostUsd != null) lines.push(`Session cost: $${signals.totalCostUsd.toFixed(4)}`);
	lines.push(`Turns: ${signals.turns}`);
	lines.push(`Messages: ${signals.messageCount}`);
	if (signals.toolCallCount > 0) lines.push(`Tool calls: ${signals.toolCallCount}`);
	const healthLine = formatHealthLine(signals);
	if (healthLine) {
		lines.push("");
		lines.push(healthLine);
	}
	const flags = formatFlagsLine(signals);
	if (flags.length > 0) lines.push(...flags);
	const status = formatStatusLine(signals);
	if (status) {
		lines.push("");
		lines.push(status);
	}
	const ago = Date.now() - signals.startedAt;
	lines.push(`Active since: ${formatDuration(ago)} ago`);
	return lines.join("\n");
}
function formatHealthLine(signals) {
	if (signals.healthScore === null || signals.healthGrade === null) return null;
	return `Health: ${signals.healthGrade} (${signals.healthScore}/100)`;
}
function formatFlagsLine(signals) {
	const flags = [];
	if (signals.toolFailureSignalCount > 0) flags.push(`Tool failures: ${signals.toolFailureSignalCount}`);
	if (signals.toolRetryCount > 0) flags.push(`Tool retries: ${signals.toolRetryCount}`);
	if (signals.editChurnCount > 0) flags.push(`Edit churn: ${signals.editChurnCount}`);
	if (signals.compactionCount > 0) {
		const mid = signals.midTaskCompactionCount > 0 ? ` (${signals.midTaskCompactionCount} mid-task)` : "";
		flags.push(`Compactions: ${signals.compactionCount}${mid}`);
	}
	return flags;
}
function formatStatusLine(signals) {
	const parts = [];
	parts.push(`Status: ${TERMINATION_LABELS[signals.terminationStatus]}`);
	if (signals.outcome !== "unknown" || signals.outcomeConfidence !== "low") parts.push(`outcome: ${OUTCOME_LABELS[signals.outcome]} (${signals.outcomeConfidence})`);
	return parts.join(" · ");
}
function formatDuration(ms) {
	const totalSec = Math.max(0, Math.floor(ms / 1e3));
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) return `${totalMin}m`;
	return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}
//#endregion
//#region src/claude-handler.ts
function pickBackend(ctx, opts, existing) {
	const pending = opts.pendingBackends.get(ctx.conversationId);
	if (pending) return pending;
	if (existing) return existing.backend;
	const access = opts.getAccess();
	const channelDefault = ctx.chatType === "private" ? access.dmDefaultBackend : access.groupDefaultBackend;
	if (channelDefault) return channelDefault;
	return opts.backends.defaultId;
}
const sessions = /* @__PURE__ */ new Map();
const MAX_QUEUE_SIZE = 10;
const QUEUE_ACK_EMOJI = "👀";
const MEDIA_GROUP_DELAY_MS = 500;
const mediaGroupBuffers = /* @__PURE__ */ new Map();
function enqueueMessage(session, item) {
	if (session.pending.length >= MAX_QUEUE_SIZE) return false;
	session.pending.push(item);
	return true;
}
function pendingItemLogFields(item) {
	const firstMsg = item.kind === "single" ? item.message : item.messages[0];
	const text = extractText(firstMsg);
	return {
		kind: item.kind,
		messageId: firstMsg.message_id,
		textLen: text?.length ?? 0,
		textPreview: text?.slice(0, 200) ?? "[media]",
		...item.kind === "group" && { groupSize: item.messages.length }
	};
}
/**
* Acknowledge a queued message with an emoji reaction. Falls back to a tiny
* text reply if reactions aren't available (older bot or restricted chat).
*/
async function ackQueued(client, message, queueDepth, log) {
	try {
		await client.setMessageReaction({
			chat_id: message.chat.id,
			message_id: message.message_id,
			emojis: [QUEUE_ACK_EMOJI]
		});
	} catch (err) {
		log.debug({ err }, "reaction ack failed, sending text ack");
		await client.sendMessage({
			chat_id: message.chat.id,
			text: `Queued (${queueDepth} ahead). Will run after the current turn.`,
			...message.message_thread_id && { message_thread_id: message.message_thread_id },
			reply_parameters: { message_id: message.message_id }
		}).catch(() => {});
	}
}
async function handleUpdate(client, update, log, opts, timer) {
	const message = update.message ?? update.edited_message;
	if (!message) return;
	if (message.media_group_id) {
		const groupId = message.media_group_id;
		const existing = mediaGroupBuffers.get(groupId);
		if (existing) {
			existing.messages.push(message);
			clearTimeout(existing.timeout);
			existing.timeout = setTimeout(() => {
				mediaGroupBuffers.delete(groupId);
				processMediaGroup(client, existing.messages, log, opts).catch((err) => log.error({
					err,
					groupId
				}, "media group handler error"));
			}, MEDIA_GROUP_DELAY_MS);
			return;
		}
		const buf = {
			messages: [message],
			timeout: setTimeout(() => {
				mediaGroupBuffers.delete(groupId);
				processMediaGroup(client, buf.messages, log, opts).catch((err) => log.error({
					err,
					groupId
				}, "media group handler error"));
			}, MEDIA_GROUP_DELAY_MS)
		};
		mediaGroupBuffers.set(groupId, buf);
		return;
	}
	await processSingleMessage(client, message, log, opts, timer);
}
async function processSingleMessage(client, message, log, opts, timer) {
	const ctx = extractMessageContext(message);
	const access = opts.getAccess();
	if (!isAllowed(ctx, access)) {
		log.debug({
			conversationId: ctx.conversationId,
			sender: ctx.senderName
		}, "access denied");
		if (access.adminChatId && shouldNotifyAdmin(ctx)) {
			const notification = formatAdminNotification(ctx);
			client.sendMessage({
				chat_id: access.adminChatId,
				text: notification
			}).catch((err) => {
				log.error({ err }, "failed to send admin notification");
			});
		}
		return;
	}
	if (opts.respondMode === "mention" && ctx.chatType !== "private" && !isBotAddressed(message, opts.botUsername)) return;
	const text = extractText(message);
	const hasPhoto = !!message.photo?.length;
	const hasDocument = !!message.document;
	if (!text && !hasPhoto && !hasDocument) return;
	const newBackend = matchNewBackendCommand(text);
	if (newBackend) {
		await handleNewBackendCommand(client, ctx.conversationId, message, newBackend, opts, log);
		return;
	}
	if (text?.startsWith("/stats")) {
		await handleStatsCommand(client, ctx.conversationId, message, opts);
		return;
	}
	if (text?.startsWith("/run_") && opts.cronScheduler) {
		await handleRunCronCommand(client, message, commandToJobName(text.split(/\s/)[0]?.slice(1) ?? ""), opts.cronScheduler, log);
		return;
	}
	const existing = sessions.get(ctx.conversationId);
	if (existing?.proc.alive) {
		await submitToExistingSession(client, existing, {
			kind: "single",
			message
		}, log, opts);
		return;
	}
	await startSession(client, message, log, opts, timer);
}
/**
* Submit a message to an already-running session. If Claude is busy
* (mid-turn), enqueue and ack with 👀; the session's onQuiescent listener
* will drain when the turn really ends. If quiescent, dispatch immediately.
*/
async function submitToExistingSession(client, session, item, log, opts) {
	if (!session.proc.quiescent || session.submitInFlight) {
		const ok = enqueueMessage(session, item);
		const firstMsg = item.kind === "single" ? item.message : item.messages[0];
		if (!ok) {
			await client.sendMessage({
				chat_id: firstMsg.chat.id,
				text: `Queue is full (${MAX_QUEUE_SIZE} messages). Wait for the current turn to finish.`,
				...firstMsg.message_thread_id && { message_thread_id: firstMsg.message_thread_id },
				reply_parameters: { message_id: firstMsg.message_id }
			}).catch(() => {});
			return;
		}
		log.info({
			conversationId: session.conversationId,
			backend: session.backendId,
			sessionId: session.proc.sessionId,
			queueDepth: session.pending.length,
			quiescent: session.proc.quiescent,
			submitInFlight: session.submitInFlight,
			...pendingItemLogFields(item)
		}, "message queued behind active session");
		await ackQueued(client, firstMsg, session.pending.length, log);
		return;
	}
	await dispatchPendingItem(client, session, item, log, opts);
}
/**
* Build content blocks for a queued item and call proc.sendInput. Marks
* `submitInFlight` so onQuiescent doesn't fire two drains concurrently
* while we're awaiting photo/doc downloads.
*/
async function dispatchPendingItem(client, session, item, log, opts) {
	session.submitInFlight = true;
	try {
		if (item.kind === "single") {
			const content = await buildSingleContent(client, item.message, log, opts);
			if (content && content.length > 0) {
				const text = describeContentBlocks(content);
				opts.sessionRecorder.recordUserInput(session.conversationId, text);
				log.info({
					conversationId: session.conversationId,
					backend: session.backendId,
					sessionId: session.proc.sessionId,
					blocks: content.length,
					textLen: text.length,
					textPreview: text.slice(0, 200),
					kind: "single"
				}, "dispatching to backend CLI");
				session.proc.sendInput(content);
			}
		} else {
			const content = await buildGroupContent(client, item.messages, log, opts);
			if (content && content.length > 0) {
				const text = describeContentBlocks(content);
				opts.sessionRecorder.recordUserInput(session.conversationId, text);
				log.info({
					conversationId: session.conversationId,
					backend: session.backendId,
					sessionId: session.proc.sessionId,
					blocks: content.length,
					textLen: text.length,
					textPreview: text.slice(0, 200),
					kind: "group"
				}, "dispatching to backend CLI");
				session.proc.sendInput(content);
			}
		}
	} finally {
		session.submitInFlight = false;
	}
}
function describeContentBlocks(blocks) {
	const parts = [];
	for (const block of blocks) if (block.type === "text") parts.push(block.text);
	else if (block.type === "image") parts.push("[image]");
	return parts.join("\n").trim() || "[media]";
}
/**
* Spawn a new ClaudeProcess for this conversation, attach a long-running
* streamToTelegram forwarder, register the queue-drain listener, and submit
* the first user message. Auth retry is handled by sendMessageWithAuthRetry
* during the first message; subsequent messages reuse the committed proc
* directly via proc.sendInput.
*/
async function startSession(client, message, log, opts, timer) {
	const ctx = extractMessageContext(message);
	const t = timer ?? new RequestTimer();
	t.mark("handler_start");
	const text = extractText(message);
	const cleanText = text != null ? /^\/cron(\s|@|$)/.test(text) ? buildCronSkillMessage(text.replace(/^\/cron(@\S+)?\s*/, ""), ctx, opts.promptsDir, opts.cronFilePath) : stripBotMention(text, opts.botUsername) : null;
	const content = await buildContent(client, message, cleanText, log);
	if (content.length === 0) return;
	const inputDescription = describeInput(!!message.photo?.length, !!message.document, cleanText);
	t.mark("session_lookup");
	const existingSession = opts.sessionStore.getSession(ctx.conversationId);
	const backendId = pickBackend(ctx, opts, existingSession);
	const pool = opts.backends.pool(backendId);
	log.info({
		conversationId: ctx.conversationId,
		backend: backendId,
		hasSession: !!existingSession,
		sender: ctx.senderName,
		hasPhoto: !!message.photo?.length,
		hasDocument: !!message.document
	}, "routing first message — starting session");
	t.mark("claude_invoke");
	if (backendId === "claude") try {
		await ensureFreshCliToken(log);
	} catch (err) {
		log.error({ err }, "CLI token warmup failed — proceeding anyway");
	}
	const overrides = buildProcessOverrides(opts, ctx);
	const proc = pool.getOrCreate(ctx.conversationId, existingSession?.sessionId ?? null, t, overrides);
	opts.sessionRecorder.start({
		conversationId: ctx.conversationId,
		backend: backendId
	});
	const dispatchText = describeContentBlocks(content);
	opts.sessionRecorder.recordUserInput(ctx.conversationId, dispatchText);
	log.info({
		conversationId: ctx.conversationId,
		backend: backendId,
		sessionId: existingSession?.sessionId ?? null,
		blocks: content.length,
		textLen: dispatchText.length,
		textPreview: dispatchText.slice(0, 200),
		kind: "single",
		firstTurn: true
	}, "dispatching to backend CLI");
	const events = sendMessageWithAuthRetry(proc, () => pool.getOrCreate(ctx.conversationId, existingSession?.sessionId ?? null, t, overrides), () => pool.remove(ctx.conversationId), content, t, log);
	const streamingContext = {
		chatId: ctx.chatId,
		messageThreadId: message.message_thread_id,
		replyToMessageId: message.message_id
	};
	const session = {
		conversationId: ctx.conversationId,
		backendId,
		proc,
		forwarder: Promise.resolve(),
		streamingContext,
		pending: [],
		submitInFlight: false,
		unsubscribeQuiescent: () => {}
	};
	sessions.set(ctx.conversationId, session);
	session.forwarder = streamToTelegram(client, streamingContext, events, log, t, (event) => opts.sessionRecorder.recordEvent(ctx.conversationId, event)).then((result) => {
		t.mark("done");
		if (sessions.get(ctx.conversationId) !== session) return result;
		handleSessionResult(ctx, message, inputDescription, result, backendId, t, opts, log);
		return result;
	}).catch((err) => {
		log.error({
			err,
			conversationId: ctx.conversationId
		}, "long-running forwarder threw");
		return null;
	}).finally(() => {
		const s = sessions.get(ctx.conversationId);
		if (s === session) {
			s.unsubscribeQuiescent();
			sessions.delete(ctx.conversationId);
		}
		opts.sessionRecorder.end(ctx.conversationId);
	});
	session.unsubscribeQuiescent = proc.onQuiescent(() => {
		drainPending(client, session, log, opts).catch((err) => log.error({
			err,
			conversationId: ctx.conversationId
		}, "drain error"));
	});
}
async function drainPending(client, session, log, opts) {
	if (session.submitInFlight) {
		log.debug({
			conversationId: session.conversationId,
			backend: session.backendId,
			queueDepth: session.pending.length
		}, "queue drain skipped during submit");
		return;
	}
	if (!session.proc.quiescent) {
		log.debug({
			conversationId: session.conversationId,
			backend: session.backendId,
			queueDepth: session.pending.length,
			sessionId: session.proc.sessionId
		}, "queue drain skipped while session busy");
		return;
	}
	const next = session.pending.shift();
	if (!next) return;
	log.info({
		conversationId: session.conversationId,
		backend: session.backendId,
		sessionId: session.proc.sessionId,
		queueDepthRemaining: session.pending.length,
		...pendingItemLogFields(next)
	}, "draining queued message");
	await dispatchPendingItem(client, session, next, log, opts);
}
/**
* Persist session metadata + log to disk after a turn finishes. Wired
* onto the long-running forwarder's resolution; runs once when the
* stream actually ends (i.e. process death). For routine multi-turn
* conversations this is effectively a session-shutdown hook.
*
* Callers must verify the session they registered still owns the
* conversation slot before invoking this — otherwise we'd risk writing
* a stale or wrong-backend row to sessionStore.
*/
function handleSessionResult(ctx, firstMessage, inputDescription, result, backendId, t, opts, log) {
	const sessionId = result.sessionId;
	if (!sessionId) return;
	opts.sessionStore.setSession(ctx.conversationId, sessionId, backendId);
	opts.pendingBackends.clear(ctx.conversationId);
	opts.conversationLogger.log({
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		conversationId: ctx.conversationId,
		sessionId,
		sender: {
			id: ctx.senderId,
			name: ctx.senderName,
			username: ctx.senderUsername
		},
		input: inputDescription,
		output: result.responseText,
		tools: result.toolHistory,
		durationMs: t.summary().total ?? 0,
		error: result.error ?? (result.interrupted ? "stream interrupted" : null),
		timings: t.summary()
	});
	log.info({
		conversationId: ctx.conversationId,
		timings: t.summary(),
		tools: result.toolHistory.length,
		triggeredBy: extractText(firstMessage)?.slice(0, 60) ?? "[media]"
	}, "claude session ended");
}
async function buildContent(client, message, cleanText, log) {
	const content = [];
	const hasPhoto = !!message.photo?.length;
	const hasDocument = !!message.document;
	if (hasPhoto) try {
		const imageBlock = await downloadPhoto(client, message.photo ?? []);
		content.push(imageBlock);
	} catch (err) {
		log.error({ err }, "failed to download photo");
		content.push({
			type: "text",
			text: "[photo — download failed]"
		});
	}
	if (hasDocument && message.document) try {
		const ref = `[File saved to: ${await downloadDocument(client, message.document)}]\nRead and process this file.`;
		content.push({
			type: "text",
			text: ref
		});
	} catch (err) {
		log.error({ err }, "failed to download document");
		content.push({
			type: "text",
			text: `[document: ${message.document.file_name ?? "unknown"} — download failed]`
		});
	}
	if (cleanText) content.push({
		type: "text",
		text: cleanText
	});
	return content;
}
async function buildSingleContent(client, message, log, opts) {
	const text = extractText(message);
	return buildContent(client, message, text != null ? /^\/cron(\s|@|$)/.test(text) ? buildCronSkillMessage(text.replace(/^\/cron(@\S+)?\s*/, ""), extractMessageContext(message), opts.promptsDir, opts.cronFilePath) : stripBotMention(text, opts.botUsername) : null, log);
}
async function buildGroupContent(client, messages, log, opts) {
	const content = [];
	let caption = null;
	for (const msg of messages) {
		if (msg.photo?.length) try {
			const imageBlock = await downloadPhoto(client, msg.photo);
			content.push(imageBlock);
		} catch (err) {
			log.error({ err }, "failed to download photo in media group");
		}
		if (msg.document) try {
			const filePath = await downloadDocument(client, msg.document);
			content.push({
				type: "text",
				text: `[File saved to: ${filePath}]\nRead and process this file.`
			});
		} catch (err) {
			log.error({ err }, "failed to download document in media group");
		}
		if (!caption && msg.caption) caption = stripBotMention(msg.caption, opts.botUsername);
	}
	if (caption) content.push({
		type: "text",
		text: caption
	});
	return content;
}
async function handleStatsCommand(client, conversationId, message, opts) {
	const replyOpts = {
		chat_id: message.chat.id,
		...message.message_thread_id && { message_thread_id: message.message_thread_id },
		reply_parameters: { message_id: message.message_id }
	};
	const signals = opts.sessionRecorder.compute(conversationId);
	if (!signals) {
		await client.sendMessage({
			...replyOpts,
			text: "No active session."
		});
		return;
	}
	await client.sendMessage({
		...replyOpts,
		text: formatStatsMessage(signals)
	});
}
/**
* Match `/new-claude`, `/new_claude`, `/new-codex`, or `/new_codex` (with
* optional `@botname` suffix and trailing whitespace). Telegram's BotFather
* menu only allows `[a-z0-9_]` so the registered commands use underscores;
* we accept hyphens too because it's natural to type. No bare `/new` —
* explicit commands only, since argument parsing was a regular source of
* confusion ("did the bot read codex or did it default?").
*/
function matchNewBackendCommand(text) {
	if (!text) return null;
	const m = text.match(/^\/new[-_](claude|codex)(@\S+)?(\s|$)/i);
	if (!m) return null;
	const backend = m[1]?.toLowerCase();
	return isBackendId(backend ?? "") ? backend : null;
}
async function handleNewBackendCommand(client, conversationId, message, backend, opts, log) {
	const replyOpts = {
		chat_id: message.chat.id,
		...message.message_thread_id && { message_thread_id: message.message_thread_id },
		reply_parameters: { message_id: message.message_id }
	};
	for (const id of ["claude", "codex"]) opts.backends.pool(id).remove(conversationId);
	opts.sessionStore.deleteSession(conversationId);
	opts.sessionRecorder.delete(conversationId);
	const session = sessions.get(conversationId);
	const droppedQueueDepth = session?.pending.length ?? 0;
	if (session) {
		session.unsubscribeQuiescent();
		sessions.delete(conversationId);
	}
	const droppedSuffix = droppedQueueDepth > 0 ? ` Dropped ${droppedQueueDepth} queued message${droppedQueueDepth === 1 ? "" : "s"}.` : "";
	opts.pendingBackends.set(conversationId, backend);
	await client.sendMessage({
		...replyOpts,
		text: `Session cleared. Next message will use ${backend}.${droppedSuffix}`
	});
	log.info({
		conversationId,
		backend,
		droppedQueueDepth
	}, "session cleared via /new-<backend>");
}
async function handleRunCronCommand(client, message, jobName, cronScheduler, log) {
	const result = await cronScheduler.runJob(jobName, {
		manual: true,
		overrideChatId: message.chat.id,
		overrideThreadId: message.message_thread_id
	});
	if (!result.found) {
		await client.sendMessage({
			chat_id: message.chat.id,
			text: `Unknown cron job: "${jobName}"`,
			...message.message_thread_id && { message_thread_id: message.message_thread_id },
			reply_parameters: { message_id: message.message_id }
		});
		return;
	}
	if (result.busy) {
		await client.sendMessage({
			chat_id: message.chat.id,
			text: `Job "${jobName}" is already running. Please wait.`,
			...message.message_thread_id && { message_thread_id: message.message_thread_id },
			reply_parameters: { message_id: message.message_id }
		});
		return;
	}
	log.info({
		job: jobName,
		chatId: message.chat.id
	}, "manual cron trigger");
}
/**
* Process a batch of messages that share a media_group_id. Mirrors
* processSingleMessage but with grouped content.
*/
async function processMediaGroup(client, messages, log, opts) {
	if (messages.length === 0) return;
	const first = messages[0];
	const ctx = extractMessageContext(first);
	if (!isAllowed(ctx, opts.getAccess())) return;
	if (opts.respondMode === "mention" && ctx.chatType !== "private" && !messages.some((m) => isBotAddressed(m, opts.botUsername))) return;
	const existing = sessions.get(ctx.conversationId);
	if (existing?.proc.alive) {
		await submitToExistingSession(client, existing, {
			kind: "group",
			messages
		}, log, opts);
		return;
	}
	await startSessionFromGroup(client, messages, log, opts);
}
async function startSessionFromGroup(client, messages, log, opts) {
	const t = new RequestTimer();
	t.mark("handler_start");
	const first = messages[0];
	const ctx = extractMessageContext(first);
	const content = await buildGroupContent(client, messages, log, opts);
	if (content.length === 0) return;
	const photoCount = messages.filter((m) => m.photo?.length).length;
	const docCount = messages.filter((m) => m.document).length;
	let caption = null;
	for (const msg of messages) if (!caption && msg.caption) {
		caption = stripBotMention(msg.caption, opts.botUsername);
		break;
	}
	const inputDescription = describeInput(photoCount > 0, docCount > 0, caption);
	t.mark("session_lookup");
	const existingSession = opts.sessionStore.getSession(ctx.conversationId);
	const backendId = pickBackend(ctx, opts, existingSession);
	const pool = opts.backends.pool(backendId);
	log.info({
		conversationId: ctx.conversationId,
		backend: backendId,
		hasSession: !!existingSession,
		sender: ctx.senderName,
		mediaGroupSize: messages.length,
		photoCount,
		docCount
	}, "routing media group — starting session");
	t.mark("claude_invoke");
	if (backendId === "claude") try {
		await ensureFreshCliToken(log);
	} catch (err) {
		log.error({ err }, "CLI token warmup failed — proceeding anyway");
	}
	const overrides = buildProcessOverrides(opts, ctx);
	const proc = pool.getOrCreate(ctx.conversationId, existingSession?.sessionId ?? null, t, overrides);
	opts.sessionRecorder.start({
		conversationId: ctx.conversationId,
		backend: backendId
	});
	const dispatchText = describeContentBlocks(content);
	opts.sessionRecorder.recordUserInput(ctx.conversationId, dispatchText);
	log.info({
		conversationId: ctx.conversationId,
		backend: backendId,
		sessionId: existingSession?.sessionId ?? null,
		blocks: content.length,
		textLen: dispatchText.length,
		textPreview: dispatchText.slice(0, 200),
		kind: "group",
		firstTurn: true
	}, "dispatching to backend CLI");
	const events = sendMessageWithAuthRetry(proc, () => pool.getOrCreate(ctx.conversationId, existingSession?.sessionId ?? null, t, overrides), () => pool.remove(ctx.conversationId), content, t, log);
	const streamingContext = {
		chatId: ctx.chatId,
		messageThreadId: first.message_thread_id,
		replyToMessageId: first.message_id
	};
	const session = {
		conversationId: ctx.conversationId,
		backendId,
		proc,
		forwarder: Promise.resolve(),
		streamingContext,
		pending: [],
		submitInFlight: false,
		unsubscribeQuiescent: () => {}
	};
	sessions.set(ctx.conversationId, session);
	session.forwarder = streamToTelegram(client, streamingContext, events, log, t, (event) => opts.sessionRecorder.recordEvent(ctx.conversationId, event)).then((result) => {
		t.mark("done");
		if (sessions.get(ctx.conversationId) !== session) return result;
		handleSessionResult(ctx, first, inputDescription, result, backendId, t, opts, log);
		return result;
	}).catch((err) => {
		log.error({
			err,
			conversationId: ctx.conversationId
		}, "long-running forwarder threw (group)");
		return null;
	}).finally(() => {
		const s = sessions.get(ctx.conversationId);
		if (s === session) {
			s.unsubscribeQuiescent();
			sessions.delete(ctx.conversationId);
		}
		opts.sessionRecorder.end(ctx.conversationId);
	});
	session.unsubscribeQuiescent = proc.onQuiescent(() => {
		drainPending(client, session, log, opts).catch((err) => log.error({
			err,
			conversationId: ctx.conversationId
		}, "drain error (group)"));
	});
}
function isBotAddressed(message, botUsername) {
	const lower = botUsername.toLowerCase();
	if ((message.text ?? message.caption)?.toLowerCase().includes(`@${lower}`)) return true;
	if (message.reply_to_message?.from?.username?.toLowerCase() === lower) return true;
	return false;
}
/**
* Extract the text portion of a message.
* Returns null for photos/documents without captions — those are handled
* via content blocks (image base64 / file path) in the handler.
*/
function extractText(message) {
	if (message.text) return message.text;
	if (message.caption) return message.caption;
	if (message.sticker?.emoji) return message.sticker.emoji;
	if (message.photo?.length) return null;
	if (message.document) return null;
	if (message.video) return "[video received]";
	if (message.audio) return "[audio received]";
	if (message.voice) return "[voice received]";
	return null;
}
function stripBotMention(text, botUsername) {
	const mention = new RegExp(`@${botUsername}\\b`, "gi");
	return text.replace(mention, "").trim();
}
async function downloadPhoto(client, photos) {
	const photo = photos[photos.length - 1];
	const file = await client.getFile(photo.file_id);
	if (!file.file_path) throw new Error("No file_path in getFile response");
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: "image/jpeg",
			data: (await client.downloadFileBuffer(file.file_path)).toString("base64")
		}
	};
}
const TG_FILES_DIR = "/tmp/tg-files";
async function downloadDocument(client, doc) {
	const file = await client.getFile(doc.file_id);
	if (!file.file_path) throw new Error("No file_path in getFile response");
	const buffer = await client.downloadFileBuffer(file.file_path);
	mkdirSync(TG_FILES_DIR, { recursive: true });
	const filename = doc.file_name ?? `${doc.file_unique_id}`;
	const destPath = join(TG_FILES_DIR, `${doc.file_unique_id}_${filename}`);
	writeFileSync(destPath, buffer);
	return destPath;
}
function describeInput(hasPhoto, hasDocument, text) {
	const parts = [];
	if (hasPhoto) parts.push("[photo]");
	if (hasDocument) parts.push("[document]");
	if (text) parts.push(text);
	return parts.join(" ") || "[media]";
}
function buildProcessOverrides(opts, ctx) {
	const tier = ctx.chatType === "private" ? "dm" : "group";
	let systemPrompt = buildSystemPrompt(opts.promptsDir, tier);
	const binding = resolveBinding(ctx, opts.bindings);
	if (binding?.prompt) systemPrompt = systemPrompt !== void 0 ? `${systemPrompt}\n\n${binding.prompt}` : binding.prompt;
	const convDirName = conversationIdToDir(ctx.conversationId);
	const conversationHistoryDir = join(opts.conversationLogDir, convDirName);
	const historyNote = `Past conversation history for this channel is stored in: ${conversationHistoryDir}/\nEach file is a JSONL log of a previous session containing input/output pairs. Read them if prior context would help answer the current question.`;
	systemPrompt = systemPrompt !== void 0 ? `${systemPrompt}\n\n${historyNote}` : historyNote;
	const overrides = {
		systemPrompt,
		conversationHistoryDir
	};
	if (binding?.workingDir) overrides.workingDir = binding.workingDir;
	return overrides;
}
function buildCronSkillMessage(userText, ctx, promptsDir, cronFilePath) {
	const skillPath = join(promptsDir, "skills", "cron-manager.md");
	let triggerDesc;
	if (ctx.chatType === "private") triggerDesc = `DM (chatId: ${ctx.chatId})`;
	else if (ctx.isForum && ctx.threadId != null) triggerDesc = `forum topic${ctx.chatTitle ? ` in "${ctx.chatTitle}"` : ""} (chatId: ${ctx.chatId}, threadId: ${ctx.threadId})`;
	else triggerDesc = `group${ctx.chatTitle ? ` "${ctx.chatTitle}"` : ""} (chatId: ${ctx.chatId})`;
	const request = userText || "I want to manage cron jobs.";
	return [
		"<cron-management>",
		`Read the cron management skill at: ${skillPath}`,
		`Cron config file: ${cronFilePath}`,
		"</cron-management>",
		"",
		"<context>",
		`Triggered from: ${triggerDesc}`,
		"</context>",
		"",
		request
	].join("\n");
}
//#endregion
//#region src/poller.ts
const TEXT_PREVIEW_MAX = 200;
function summarizeUpdate(update) {
	const kind = update.message ? "message" : update.edited_message ? "edited_message" : update.callback_query ? "callback_query" : "other";
	const msg = update.message ?? update.edited_message;
	if (!msg) return {
		updateId: update.update_id,
		kind
	};
	const text = msg.text ?? msg.caption ?? null;
	return {
		updateId: update.update_id,
		kind,
		chatId: msg.chat.id,
		chatType: msg.chat.type,
		threadId: msg.message_thread_id,
		messageId: msg.message_id,
		senderId: msg.from?.id,
		senderUsername: msg.from?.username,
		hasPhoto: !!msg.photo?.length,
		hasDocument: !!msg.document,
		hasMediaGroup: !!msg.media_group_id,
		textLen: text?.length ?? 0,
		textPreview: text ? text.slice(0, TEXT_PREVIEW_MAX) : null,
		replyToMessageId: msg.reply_to_message?.message_id
	};
}
async function startPolling(client, log, signal, opts) {
	let offset;
	const pollLog = log.child({ component: "poller" });
	pollLog.info("starting long-poll loop");
	while (!signal.aborted) try {
		const updates = await client.getUpdates(offset, 30);
		for (const update of updates) {
			offset = update.update_id + 1;
			pollLog.info(summarizeUpdate(update), "telegram update received");
			const timer = new RequestTimer();
			timer.mark("message_received");
			handleUpdate(client, update, log, opts, timer).catch((err) => {
				pollLog.error({
					err,
					updateId: update.update_id
				}, "error handling update");
			});
		}
	} catch (err) {
		if (signal.aborted) break;
		pollLog.error({ err }, "getUpdates failed, retrying in 3s");
		await sleep$1(3e3);
	}
	pollLog.info("stopped");
}
function sleep$1(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
//#region src/server.ts
function createApp(opts) {
	const { client, log, webhookSecret, webhookPath, startedAt, handlerOpts } = opts;
	const app = new Hono();
	app.get("/healthz", (c) => c.json({
		status: "ok",
		uptime: Math.floor((Date.now() - startedAt) / 1e3)
	}));
	app.get("/readyz", async (c) => {
		try {
			await client.getMe();
			return c.json({ status: "ready" });
		} catch {
			return c.json({ status: "not ready" }, 503);
		}
	});
	app.post(webhookPath, async (c) => {
		if (webhookSecret) {
			if (c.req.header("x-telegram-bot-api-secret-token") !== webhookSecret) return c.json({ error: "unauthorized" }, 401);
		}
		const timer = new RequestTimer();
		timer.mark("message_received");
		handleUpdate(client, await c.req.json(), log, handlerOpts, timer).catch((err) => {
			log.error({ err }, "webhook handler error");
		});
		return c.json({ ok: true });
	});
	return app;
}
//#endregion
//#region src/session-stats/compaction.ts
const COMPACTION_DROP_RATIO = .7;
const BEFORE_WINDOW = 10;
const AFTER_WINDOW = 5;
function findCompactionBoundaries(messages) {
	const explicit = [];
	for (const m of messages) if (m.isCompactBoundary) explicit.push(m.ordinal);
	if (explicit.length > 0) return explicit;
	const heuristic = [];
	let prev = null;
	for (const m of messages) {
		if (m.role !== "assistant" || m.contextTokens === null) continue;
		if (prev !== null && m.contextTokens < prev * COMPACTION_DROP_RATIO) heuristic.push(m.ordinal);
		prev = m.contextTokens;
	}
	return heuristic;
}
function countCompactions(messages) {
	return findCompactionBoundaries(messages).length;
}
function countMidTaskCompactions(messages) {
	const boundaries = findCompactionBoundaries(messages);
	if (boundaries.length === 0) return 0;
	const calls = [];
	for (const m of messages) for (const c of m.toolCalls) calls.push({
		name: c.toolName,
		ordinal: m.ordinal
	});
	if (calls.length === 0) return 0;
	let mid = 0;
	for (const b of boundaries) {
		const before = calls.filter((c) => c.ordinal < b).slice(-BEFORE_WINDOW);
		const after = calls.filter((c) => c.ordinal > b).slice(0, AFTER_WINDOW);
		const beforeNames = new Set(before.map((c) => c.name));
		let overlap = 0;
		const seen = /* @__PURE__ */ new Set();
		for (const c of after) {
			if (seen.has(c.name)) continue;
			seen.add(c.name);
			if (beforeNames.has(c.name)) overlap++;
		}
		if (overlap >= 2) mid++;
	}
	return mid;
}
//#endregion
//#region src/session-stats/outcome.ts
const RECENCY_WINDOW_MS = 600 * 1e3;
const GIVE_UP_PATTERNS = [
	/i'm unable to/i,
	/i can't proceed/i,
	/i don't have access/i,
	/i cannot proceed/i,
	/i am unable to/i
];
function classifyOutcome(input) {
	if (input.isAutomated) return {
		outcome: "unknown",
		confidence: "low",
		isRecent: false
	};
	if (input.messageCount === 2 && input.endedWithRole === "assistant") return {
		outcome: "completed",
		confidence: "medium",
		isRecent: false
	};
	if (input.messageCount < 3) return {
		outcome: "unknown",
		confidence: "low",
		isRecent: false
	};
	if (input.now - input.lastActivity < RECENCY_WINDOW_MS) return {
		outcome: "unknown",
		confidence: "low",
		isRecent: true
	};
	if (input.endedWithRole === "user") return {
		outcome: "abandoned",
		confidence: input.messageCount >= 10 ? "high" : "medium",
		isRecent: false
	};
	if (input.finalFailureStreak >= 3) return {
		outcome: "errored",
		confidence: "medium",
		isRecent: false
	};
	if (input.endedWithRole === "assistant") return {
		outcome: "completed",
		confidence: GIVE_UP_PATTERNS.some((re) => re.test(input.lastAssistantText)) ? "low" : "medium",
		isRecent: false
	};
	return {
		outcome: "unknown",
		confidence: "low",
		isRecent: false
	};
}
//#endregion
//#region src/session-stats/score.ts
function computeHealthScore(input) {
	const basis = ["outcome"];
	if (input.hasToolCalls) basis.push("tool_health");
	if (input.hasContextData) basis.push("context_pressure");
	if (input.outcome === "unknown" && input.outcomeConfidence === "low" && basis.length === 1) return {
		score: null,
		grade: null,
		basis,
		penalties: {}
	};
	let score = 100;
	const penalties = {};
	if (input.outcome === "errored") {
		penalties.outcome_errored = 30;
		score -= 30;
	} else if (input.outcome === "abandoned") {
		penalties.outcome_abandoned = 15;
		score -= 15;
	}
	const failurePenalty = Math.min(input.toolFailureSignalCount * 3, 30);
	if (failurePenalty > 0) {
		penalties.tool_failures = failurePenalty;
		score -= failurePenalty;
	}
	const retryPenalty = Math.min(input.toolRetryCount * 5, 25);
	if (retryPenalty > 0) {
		penalties.tool_retries = retryPenalty;
		score -= retryPenalty;
	}
	const churnPenalty = Math.min(input.editChurnCount * 4, 20);
	if (churnPenalty > 0) {
		penalties.edit_churn = churnPenalty;
		score -= churnPenalty;
	}
	if (input.consecutiveFailureMax >= 3) {
		penalties.consecutive_failures = 10;
		score -= 10;
	}
	if (input.compactionCount >= 2) {
		const p = Math.min((input.compactionCount - 1) * 5, 15);
		penalties.compactions = p;
		score -= p;
	}
	if (input.midTaskCompactionCount > 0) {
		const p = Math.min(input.midTaskCompactionCount * 8, 18);
		penalties.mid_task_compactions = p;
		score -= p;
	}
	if (input.contextWindow !== null && input.contextWindow > 0 && input.peakContextTokens / input.contextWindow > .9) {
		penalties.context_pressure_high = 10;
		score -= 10;
	}
	if (score < 0) score = 0;
	return {
		score,
		grade: score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F",
		basis,
		penalties
	};
}
//#endregion
//#region src/session-stats/termination.ts
function classifyTermination(messages, isAlive) {
	if (messages.length === 0) return isAlive ? "unknown" : "clean";
	for (const m of messages) for (const c of m.toolCalls) if (c.status === "in_progress") return "tool_call_pending";
	const last = messages[messages.length - 1];
	if (!last) return "unknown";
	if (!isAlive) return "clean";
	if (last.role === "assistant") return "awaiting_user";
	return "unknown";
}
//#endregion
//#region src/session-stats/tokens.ts
function accumulateTokens(messages) {
	let totalOutput = 0;
	let hasOutput = false;
	let peakContext = 0;
	let hasContext = false;
	let totalCost = null;
	for (const m of messages) {
		if (m.outputTokens !== null) {
			totalOutput += m.outputTokens;
			hasOutput = true;
		}
		if (m.contextTokens !== null) {
			if (m.contextTokens > peakContext) peakContext = m.contextTokens;
			hasContext = true;
		}
		if (m.costUsd !== null) totalCost = m.costUsd;
	}
	return {
		totalOutputTokens: totalOutput,
		hasTotalOutputTokens: hasOutput,
		peakContextTokens: peakContext,
		hasPeakContextTokens: hasContext,
		totalCostUsd: totalCost
	};
}
//#endregion
//#region src/session-stats/tool-health.ts
const FAILURE_PATTERNS = [
	/command not found/i,
	/Permission denied/,
	/Traceback \(most recent call last\):/,
	/^panic: /m,
	/goroutine \d+ \[/
];
const JS_STACK_TRACE = /(?:^|\n)\s+at .+(?:\n\s+at .+){2,}/;
const EXIT_STATUS_NONZERO = /exit status [1-9]\d*/;
function isToolCallFailure(call) {
	if (call.isError) return true;
	const out = call.output;
	if (!out) return false;
	for (const re of FAILURE_PATTERNS) if (re.test(out)) return true;
	if (JS_STACK_TRACE.test(out)) return true;
	if ((call.toolName === "Edit" || call.toolName === "Write") && out.includes("FAILED")) return true;
	if (call.toolName === "Bash" && EXIT_STATUS_NONZERO.test(out)) return true;
	return false;
}
function computeToolHealth(calls) {
	let failureCount = 0;
	let currentStreak = 0;
	let consecutiveMax = 0;
	for (const c of calls) if (isToolCallFailure(c)) {
		failureCount++;
		currentStreak++;
		if (currentStreak > consecutiveMax) consecutiveMax = currentStreak;
	} else currentStreak = 0;
	return {
		failureCount,
		consecutiveMax,
		retryCount: countRetries(calls),
		finalFailureStreak: countFinalFailureStreak(calls)
	};
}
function countRetries(calls) {
	let total = 0;
	let i = 0;
	while (i < calls.length) {
		let j = i + 1;
		const head = calls[i];
		if (!head) break;
		while (j < calls.length) {
			const next = calls[j];
			if (!next || next.toolName !== head.toolName || next.inputJson !== head.inputJson) break;
			j++;
		}
		const runLen = j - i;
		if (runLen >= 3) total += runLen - 1;
		i = j > i ? j : i + 1;
	}
	return total;
}
function countFinalFailureStreak(calls) {
	let n = 0;
	for (let i = calls.length - 1; i >= 0; i--) {
		const c = calls[i];
		if (!c) break;
		if (isToolCallFailure(c)) n++;
		else break;
	}
	return n;
}
const FILE_PATH_RE = /"file_path":"([^"\\]*(?:\\.[^"\\]*)*)"/;
function countEditChurn(calls) {
	const byFile = /* @__PURE__ */ new Map();
	for (const c of calls) {
		if (c.toolName !== "Edit" && c.toolName !== "Write") continue;
		const m = FILE_PATH_RE.exec(c.inputJson);
		if (!m?.[1]) continue;
		const file = m[1];
		const list = byFile.get(file) ?? [];
		list.push(c.messageOrdinal);
		byFile.set(file, list);
	}
	let churn = 0;
	for (const ordinals of byFile.values()) {
		ordinals.sort((a, b) => a - b);
		for (let i = 0; i + 2 < ordinals.length; i++) {
			const lo = ordinals[i];
			const hi = ordinals[i + 2];
			if (lo === void 0 || hi === void 0) continue;
			if (hi - lo < 10) {
				churn++;
				break;
			}
		}
	}
	return churn;
}
//#endregion
//#region src/session-stats/compute.ts
function computeAllSignals(snap) {
	const messages = snap.currentMessage ? [...snap.messages, snap.currentMessage] : snap.messages;
	const isAlive = snap.endedAt === null;
	const tokens = accumulateTokens(messages);
	const allCalls = flattenToolCalls(messages);
	const tools = computeToolHealth(allCalls);
	const editChurn = countEditChurn(allCalls);
	const compactionCount = countCompactions(messages);
	const midTaskCompactionCount = countMidTaskCompactions(messages);
	const termination = classifyTermination(messages, isAlive);
	const userMessageCount = messages.filter((m) => m.role === "user").length;
	const isAutomated = detectAutomated(snap.conversationId, userMessageCount);
	const turns = messages.filter((m) => m.role === "assistant" && m.outputTokens !== null).length;
	const endedWithRole = messages[messages.length - 1]?.role ?? null;
	const lastAssistantText = findLastAssistantText(messages);
	const outcome = classifyOutcome({
		isAutomated,
		messageCount: messages.length,
		endedWithRole,
		finalFailureStreak: tools.finalFailureStreak,
		lastAssistantText,
		lastActivity: snap.lastActivityAt,
		now: Date.now()
	});
	const health = computeHealthScore({
		outcome: outcome.outcome,
		outcomeConfidence: outcome.confidence,
		hasToolCalls: allCalls.length > 0,
		hasContextData: tokens.hasPeakContextTokens,
		toolFailureSignalCount: tools.failureCount,
		toolRetryCount: tools.retryCount,
		editChurnCount: editChurn,
		consecutiveFailureMax: tools.consecutiveMax,
		compactionCount,
		midTaskCompactionCount,
		peakContextTokens: tokens.peakContextTokens,
		contextWindow: snap.contextWindow
	});
	return {
		conversationId: snap.conversationId,
		backend: snap.backend,
		sessionId: snap.sessionId,
		model: snap.model,
		startedAt: snap.startedAt,
		lastActivityAt: snap.lastActivityAt,
		endedAt: snap.endedAt,
		messageCount: messages.length,
		userMessageCount,
		turns,
		totalOutputTokens: tokens.totalOutputTokens,
		hasTotalOutputTokens: tokens.hasTotalOutputTokens,
		peakContextTokens: tokens.peakContextTokens,
		hasPeakContextTokens: tokens.hasPeakContextTokens,
		totalCostUsd: tokens.totalCostUsd,
		contextWindow: snap.contextWindow,
		toolCallCount: allCalls.length,
		toolFailureSignalCount: tools.failureCount,
		toolRetryCount: tools.retryCount,
		consecutiveFailureMax: tools.consecutiveMax,
		finalFailureStreak: tools.finalFailureStreak,
		editChurnCount: editChurn,
		compactionCount,
		midTaskCompactionCount,
		terminationStatus: termination,
		outcome: outcome.outcome,
		outcomeConfidence: outcome.confidence,
		endedWithRole,
		healthScore: health.score,
		healthGrade: health.grade,
		healthScoreBasis: health.basis,
		healthPenalties: health.penalties,
		isAutomated
	};
}
function flattenToolCalls(messages) {
	const out = [];
	for (const m of messages) for (const c of m.toolCalls) out.push(c);
	return out;
}
function findLastAssistantText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m) continue;
		if (m.role === "assistant" && m.textContent) return m.textContent;
	}
	return "";
}
function detectAutomated(conversationId, userMessageCount) {
	if (conversationId.startsWith("cron:")) return true;
	if (userMessageCount > 1) return false;
	return false;
}
//#endregion
//#region src/session-stats/recorder.ts
var SessionRecorder = class {
	records = /* @__PURE__ */ new Map();
	start(args) {
		const now = Date.now();
		const existing = this.records.get(args.conversationId);
		if (existing) {
			existing.backend = args.backend;
			if (args.model !== void 0) existing.model = args.model;
			if (args.contextWindow !== void 0) existing.contextWindow = args.contextWindow;
			existing.lastActivityAt = now;
			existing.endedAt = null;
			existing.currentMessage = null;
			return;
		}
		this.records.set(args.conversationId, {
			conversationId: args.conversationId,
			backend: args.backend,
			sessionId: null,
			model: args.model ?? null,
			contextWindow: args.contextWindow ?? null,
			startedAt: now,
			lastActivityAt: now,
			endedAt: null,
			messages: [],
			currentMessage: null
		});
	}
	recordUserInput(conversationId, text) {
		const r = this.records.get(conversationId);
		if (!r) return;
		this.flushCurrent(r);
		const now = Date.now();
		r.lastActivityAt = now;
		r.messages.push({
			ordinal: r.messages.length,
			role: "user",
			timestamp: now,
			textContent: text,
			outputTokens: null,
			contextTokens: null,
			costUsd: null,
			toolCalls: [],
			isCompactBoundary: false,
			stopReason: null
		});
	}
	recordEvent(conversationId, event) {
		const r = this.records.get(conversationId);
		if (!r) return;
		r.lastActivityAt = Date.now();
		switch (event.type) {
			case "session_meta":
				r.model = event.model;
				return;
			case "text_delta":
				this.ensureCurrent(r).textContent += event.content;
				return;
			case "tool_use": {
				const cur = this.ensureCurrent(r);
				cur.toolCalls.push({
					toolUseId: event.toolUseId,
					toolName: event.toolName,
					inputJson: event.input,
					output: "",
					isError: false,
					status: "in_progress",
					messageOrdinal: cur.ordinal
				});
				return;
			}
			case "tool_result":
				if (this.attachToolResult(r.currentMessage, event)) return;
				for (let i = r.messages.length - 1; i >= 0; i--) {
					const msg = r.messages[i];
					if (!msg) continue;
					if (this.attachToolResult(msg, event)) return;
				}
				return;
			case "turn_complete": {
				if (event.sessionId) r.sessionId = event.sessionId;
				if (event.contextWindow != null) r.contextWindow = event.contextWindow;
				const cur = r.currentMessage;
				if (cur) {
					cur.outputTokens = event.outputTokens ?? null;
					cur.contextTokens = event.inputTokens ?? null;
					cur.costUsd = event.costUsd ?? null;
					r.messages.push(cur);
					r.currentMessage = null;
				}
				return;
			}
			case "error":
				if (event.sessionId) r.sessionId = event.sessionId;
				this.flushCurrent(r);
				return;
			case "thinking_delta": return;
		}
	}
	end(conversationId) {
		const r = this.records.get(conversationId);
		if (!r) return;
		this.flushCurrent(r);
		r.endedAt = Date.now();
	}
	delete(conversationId) {
		this.records.delete(conversationId);
	}
	has(conversationId) {
		return this.records.has(conversationId);
	}
	compute(conversationId) {
		const r = this.records.get(conversationId);
		if (!r) return null;
		return computeAllSignals({
			conversationId: r.conversationId,
			backend: r.backend,
			sessionId: r.sessionId,
			model: r.model,
			contextWindow: r.contextWindow,
			startedAt: r.startedAt,
			lastActivityAt: r.lastActivityAt,
			endedAt: r.endedAt,
			messages: r.messages,
			currentMessage: r.currentMessage
		});
	}
	ensureCurrent(r) {
		if (r.currentMessage) return r.currentMessage;
		const cur = {
			ordinal: r.messages.length,
			role: "assistant",
			timestamp: Date.now(),
			textContent: "",
			outputTokens: null,
			contextTokens: null,
			costUsd: null,
			toolCalls: [],
			isCompactBoundary: false,
			stopReason: null
		};
		r.currentMessage = cur;
		return cur;
	}
	flushCurrent(r) {
		if (!r.currentMessage) return;
		r.messages.push(r.currentMessage);
		r.currentMessage = null;
	}
	attachToolResult(msg, event) {
		if (!msg) return false;
		const idx = msg.toolCalls.findIndex((c) => c.toolUseId === event.toolUseId);
		if (idx === -1) return false;
		const call = msg.toolCalls[idx];
		if (!call) return false;
		call.output = event.output;
		call.isError = event.isError;
		call.status = "completed";
		return true;
	}
};
//#endregion
//#region src/session-store.ts
function migrate(db) {
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
function createSessionStore(dbPath) {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.pragma("journal_mode = WAL");
	migrate(db);
	const getStmt = db.prepare("SELECT claude_session_id, backend FROM sessions WHERE conversation_id = ?");
	const upsertStmt = db.prepare(`
		INSERT INTO sessions (conversation_id, claude_session_id, backend, created_at, updated_at)
		VALUES (?, ?, ?, unixepoch(), unixepoch())
		ON CONFLICT(conversation_id) DO UPDATE SET
			claude_session_id = excluded.claude_session_id,
			backend = excluded.backend,
			updated_at = unixepoch()
	`);
	const deleteStmt = db.prepare("DELETE FROM sessions WHERE conversation_id = ?");
	return {
		getSession(conversationId) {
			const row = getStmt.get(conversationId);
			if (!row) return null;
			const backend = isBackendId(row.backend) ? row.backend : "claude";
			return {
				sessionId: row.claude_session_id,
				backend
			};
		},
		setSession(conversationId, sessionId, backend) {
			upsertStmt.run(conversationId, sessionId, backend);
		},
		deleteSession(conversationId) {
			deleteStmt.run(conversationId);
		},
		close() {
			db.close();
		}
	};
}
//#endregion
//#region src/systemd-notify.ts
function send(state) {
	if (!process.env.NOTIFY_SOCKET) return;
	spawn("systemd-notify", [state], {
		stdio: "ignore",
		detached: false
	}).on("error", () => {});
}
function notifyReady() {
	send("READY=1");
}
function notifyStopping() {
	send("STOPPING=1");
}
function startWatchdog(log) {
	const usec = process.env.WATCHDOG_USEC;
	if (!process.env.NOTIFY_SOCKET || !usec) return () => {};
	const timeoutMs = Number(usec) / 1e3;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return () => {};
	const intervalMs = Math.max(5e3, Math.floor(timeoutMs / 2));
	log.info({
		timeoutMs,
		intervalMs
	}, "systemd watchdog enabled — sending periodic WATCHDOG=1");
	send("WATCHDOG=1");
	const id = setInterval(() => send("WATCHDOG=1"), intervalMs);
	id.unref?.();
	return () => clearInterval(id);
}
//#endregion
//#region src/telegram-client.ts
const TELEGRAM_API = "https://api.telegram.org";
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_SECONDS = 60;
const NETWORK_RETRY_COUNT = 2;
const NETWORK_RETRY_DELAY_MS = 1e3;
var TelegramRateLimitError = class extends Error {
	method;
	retryAfter;
	constructor(method, retryAfter, description) {
		super(`Telegram API rate limit [${method}]: retry after ${retryAfter}s${description ? ` — ${description}` : ""}`);
		this.name = "TelegramRateLimitError";
		this.method = method;
		this.retryAfter = retryAfter;
	}
};
var TelegramClient = class {
	baseUrl;
	log;
	constructor(token, opts = {}) {
		this.token = token;
		this.baseUrl = `${TELEGRAM_API}/bot${token}`;
		this.log = opts.logger;
	}
	async getMe() {
		return this.call("getMe");
	}
	async getUpdates(offset, timeout = 30) {
		const params = { timeout: String(timeout) };
		if (offset !== void 0) params.offset = String(offset);
		return this.call("getUpdates", params);
	}
	async sendMessage(params) {
		return this.call("sendMessage", { ...params });
	}
	async editMessageText(params) {
		return this.call("editMessageText", { ...params });
	}
	async sendChatAction(params) {
		await this.call("sendChatAction", { ...params });
	}
	async deleteMessage(params) {
		await this.call("deleteMessage", { ...params });
	}
	/**
	* Set or clear emoji reactions on a message. Used to acknowledge queued
	* messages without spamming the chat with text replies. Pass an empty
	* `emojis` array to clear reactions. Bot API 7.0+.
	*/
	async setMessageReaction(params) {
		await this.call("setMessageReaction", {
			chat_id: params.chat_id,
			message_id: params.message_id,
			reaction: params.emojis.map((emoji) => ({
				type: "emoji",
				emoji
			}))
		});
	}
	async setWebhook(url, secret) {
		const params = { url };
		if (secret) params.secret_token = secret;
		await this.call("setWebhook", params);
	}
	async deleteWebhook() {
		await this.call("deleteWebhook");
	}
	async setMyCommands(commands) {
		await this.call("setMyCommands", { commands });
	}
	async getFile(fileId) {
		return this.call("getFile", { file_id: fileId });
	}
	async downloadFileBuffer(filePath) {
		const url = `${TELEGRAM_API}/file/bot${this.token}/${filePath}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`Telegram file download failed: ${res.status} ${res.statusText}`);
		return Buffer.from(await res.arrayBuffer());
	}
	async call(method, body) {
		let rateLimitAttempt = 0;
		let networkAttempt = 0;
		while (true) {
			let res;
			try {
				res = await fetch(`${this.baseUrl}/${method}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: body ? JSON.stringify(body) : void 0
				});
			} catch (err) {
				if (networkAttempt >= NETWORK_RETRY_COUNT) throw err;
				const delay = NETWORK_RETRY_DELAY_MS * 2 ** networkAttempt;
				networkAttempt += 1;
				this.log?.warn({
					method,
					err,
					attempt: networkAttempt,
					delay
				}, "telegram network error, retrying");
				await sleep(delay);
				continue;
			}
			const json = await res.json();
			if (json.ok) return json.result;
			if (json.error_code === 429 && rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
				const requested = json.parameters?.retry_after ?? 1;
				const waitSec = Math.min(Math.max(requested, 1), MAX_RETRY_AFTER_SECONDS);
				rateLimitAttempt += 1;
				this.log?.warn({
					method,
					retryAfter: waitSec,
					attempt: rateLimitAttempt,
					description: json.description
				}, "telegram rate limited, sleeping before retry");
				await sleep(waitSec * 1e3 + 50);
				continue;
			}
			if (json.error_code === 429) throw new TelegramRateLimitError(method, json.parameters?.retry_after ?? 0, json.description);
			throw new Error(`Telegram API error [${method}]: ${json.error_code} — ${json.description}`);
		}
	}
};
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
//#endregion
//#region src/index.ts
async function runInstance({ instancePath }) {
	const startedAt = Date.now();
	const config = loadConfig({ instancePath });
	const { logger: log, close: closeLogger } = createLogger(config);
	log.info({ instancePath }, "starting instance");
	const client = new TelegramClient(config.telegramBotToken, { logger: log });
	const me = await client.getMe();
	log.info({
		bot: me.username,
		name: me.first_name
	}, "authenticated");
	let access = loadAccessConfig(config.accessFile, log);
	watchAccessConfig(config.accessFile, (updated) => {
		access = updated;
	}, log);
	const bindings = loadBindingConfig(config.bindingsFile, log);
	const sessionStore = createSessionStore(config.sessionDbPath);
	log.info({ dbPath: config.sessionDbPath }, "session store ready");
	const sessionRecorder = new SessionRecorder();
	mkdirSync(config.claudeWorkingDir, { recursive: true });
	const conversationLogDir = config.conversationLogDir;
	const migrated = migrateConversationLogs(conversationLogDir);
	if (migrated > 0) log.info({ migrated }, "migrated conversation logs to subdirectories");
	const conversationLogger = createConversationLogger(conversationLogDir);
	mkdirSync(dirname(config.cronFile), { recursive: true });
	if (!existsSync(config.cronFile)) writeFileSync(config.cronFile, "{\n  \"jobs\": []\n}\n");
	const claudeOpts = {
		workingDir: config.claudeWorkingDir,
		model: config.claudeModel,
		cronFilePath: config.cronFile
	};
	const codexOpts = {
		workingDir: config.claudeWorkingDir,
		model: config.codexModel,
		cronFilePath: config.cronFile
	};
	const claudePool = new ProcessPool(claudeOpts);
	const codexPool = new CodexProcessPool(codexOpts);
	const claudeCronPool = new CronProcessPool(claudeOpts);
	const codexCronPool = new CodexCronProcessPool(codexOpts);
	const backendPools = new Map([["claude", claudePool], ["codex", codexPool]]);
	const backendCronPools = new Map([["claude", claudeCronPool], ["codex", codexCronPool]]);
	const backends = new DefaultBackendRegistry(config.defaultBackend, backendPools, backendCronPools);
	const pendingBackends = new PendingBackendStore();
	log.info({ defaultBackend: config.defaultBackend }, "backends ready");
	const db = new Database(config.sessionDbPath);
	db.pragma("journal_mode = WAL");
	const cronStateStore = createCronStateStore(db);
	let cronConfig = loadCronConfig(config.cronFile, log);
	const cronScheduler = new CronScheduler({
		getCronConfig: () => cronConfig,
		stateStore: cronStateStore,
		handlerDeps: {
			client,
			backends,
			stateStore: cronStateStore,
			sessionStore,
			sessionRecorder,
			conversationLogger,
			log,
			defaultWorkingDir: config.claudeWorkingDir,
			defaultOpts: claudeOpts,
			promptsDir: config.promptsDir,
			retryMaxAttempts: config.cronRetryMaxAttempts,
			stuckTimeoutMs: config.cronStuckTimeoutMs,
			failureAlertAfter: config.cronFailureAlertAfter,
			failureAlertCooldownMs: config.cronFailureAlertCooldownMs,
			autoDisableAfter: config.cronAutoDisableAfter,
			getAdminChatId: () => access.adminChatId
		},
		log
	});
	watchCronConfig(config.cronFile, (updated) => {
		cronConfig = updated;
		cronScheduler.onConfigReload(updated);
		registerCronCommands(client, updated, log);
	}, log);
	await registerCronCommands(client, cronConfig, log);
	cronScheduler.start();
	const handlerOpts = {
		respondMode: config.respondMode,
		botUsername: me.username ?? "",
		getAccess: () => access,
		sessionStore,
		sessionRecorder,
		backends,
		pendingBackends,
		conversationLogger,
		cronScheduler,
		promptsDir: config.promptsDir,
		cronFilePath: config.cronFile,
		conversationLogDir,
		bindings
	};
	const ac = new AbortController();
	const stopWatchdog = startWatchdog(log);
	for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
		log.info({ signal: sig }, "shutting down");
		notifyStopping();
		stopWatchdog();
		ac.abort();
		cronScheduler.stop();
		backends.closeAll();
		sessionStore.close();
		db.close();
		closeLogger();
	});
	notifyReady();
	if (config.mode === "webhook") await runWebhook(client, log, config, ac, handlerOpts, startedAt);
	else {
		await client.deleteWebhook();
		await startPolling(client, log, ac.signal, handlerOpts);
	}
}
async function runWebhook(client, log, config, ac, handlerOpts, startedAt) {
	const app = createApp({
		client,
		log,
		webhookSecret: config.webhookSecret,
		webhookPath: config.webhookPath,
		startedAt,
		handlerOpts
	});
	const fullUrl = `${(config.webhookUrl ?? "").replace(/\/$/, "")}${config.webhookPath}`;
	await client.setWebhook(fullUrl, config.webhookSecret);
	log.info({ url: fullUrl }, "webhook registered");
	const server = serve({
		fetch: app.fetch,
		port: config.webhookPort
	}, () => {
		log.info({ port: config.webhookPort }, "webhook server listening");
	});
	await new Promise((resolve) => {
		ac.signal.addEventListener("abort", () => {
			server.close();
			resolve();
		});
	});
	await client.deleteWebhook().catch(() => {});
	log.info("webhook server stopped");
}
async function registerCronCommands(client, config, log) {
	const commands = [
		{
			command: "new_claude",
			description: "Start fresh — use Claude"
		},
		{
			command: "new_codex",
			description: "Start fresh — use Codex"
		},
		{
			command: "stats",
			description: "Show session statistics"
		},
		{
			command: "cron",
			description: "Manage cron jobs"
		},
		...config.jobs.filter((j) => j.enabled).map((j) => ({
			command: jobNameToCommand(j.name),
			description: `Run: ${j.name}`
		}))
	];
	try {
		await client.setMyCommands(commands);
		log.info({
			count: commands.length,
			cron: commands.length - 4
		}, "registered bot commands");
	} catch (err) {
		log.error({ err }, "setMyCommands failed — continuing without refresh");
	}
}
//#endregion
//#region src/cli/commands/run.ts
async function runCommand(argv) {
	assertNodeVersion();
	const path = argv.find((a) => !a.startsWith("-"));
	if (!path) {
		console.error("Path is required: clawalski run <path>");
		return 2;
	}
	const paths = resolveInstancePaths(path);
	assertInstanceReady(paths);
	process.loadEnvFile(paths.envFile);
	if (!process.env.TELEGRAM_BOT_TOKEN) {
		console.error(`TELEGRAM_BOT_TOKEN is empty in ${paths.envFile}`);
		console.error("Set the token in that file and try again.");
		return 1;
	}
	await runInstance({ instancePath: paths.root });
	return 0;
}
//#endregion
//#region src/cli/commands/service.ts
const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
function unitDir() {
	return join(homedir(), ".config/systemd/user");
}
function unitFilePath(name) {
	return join(unitDir(), `clawalski-${name}.service`);
}
function unitName(name) {
	return `clawalski-${name}.service`;
}
function which(cmd) {
	const r = spawnSync("which", [cmd], { encoding: "utf-8" });
	if (r.status === 0) return r.stdout.trim();
	return null;
}
function systemctl(args) {
	const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf-8" });
	return {
		code: r.status ?? 0,
		output: (r.stdout ?? "") + (r.stderr ?? "")
	};
}
function unitPath(bin) {
	const dirs = /* @__PURE__ */ new Set();
	dirs.add(dirname(bin));
	const home = homedir();
	dirs.add(join(home, ".local/bin"));
	for (const d of (process.env.PATH ?? "").split(":")) if (d) dirs.add(d);
	for (const d of [
		"/usr/local/bin",
		"/usr/bin",
		"/bin"
	]) dirs.add(d);
	return Array.from(dirs).join(":");
}
function unitContent(name, root, bin) {
	return `[Unit]
Description=Clawalski (${name}) — ${root}
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
Environment="PATH=${unitPath(bin)}"
ExecStart=${bin} run ${root}
WorkingDirectory=${root}
EnvironmentFile=${root}/config/.env
Restart=always
RestartSec=5
WatchdogSec=120
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}
function pathArg(argv) {
	const p = argv.find((a) => !a.startsWith("-"));
	if (!p) return { error: "Path is required" };
	return p;
}
function requireServiceName(paths) {
	const name = readServiceName(paths);
	if (!name) return { error: `No service registered at ${paths.root}.\nRun: clawalski service install ${paths.root} --name <name>` };
	return name;
}
function parseInstallArgs(argv) {
	let path;
	let name;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (a === "--name") name = argv[++i];
		else if (!path && !a.startsWith("-")) path = a;
		else return { error: `Unknown argument: ${a}` };
	}
	if (!path) return { error: "Path is required: clawalski service install <path> --name <name>" };
	if (!name) return { error: "--name <name> is required" };
	if (!SERVICE_NAME_RE.test(name)) return { error: `Invalid name "${name}". Must match ${SERVICE_NAME_RE.source}.` };
	return {
		path,
		name
	};
}
async function install(argv) {
	const parsed = parseInstallArgs(argv);
	if ("error" in parsed) {
		console.error(parsed.error);
		return 2;
	}
	const paths = resolveInstancePaths(parsed.path);
	assertInstanceReady(paths);
	const bin = which("clawalski");
	if (!bin) {
		console.error("clawalski not found on PATH. Install globally first:\n  npm i -g git+https://github.com/prempv/clawalski");
		return 1;
	}
	const file = unitFilePath(parsed.name);
	if (existsSync(file)) {
		console.error(`Unit already exists: ${file}`);
		return 1;
	}
	mkdirSync(unitDir(), { recursive: true });
	writeFileSync(file, unitContent(parsed.name, paths.root, bin));
	writeServiceName(paths, parsed.name);
	console.log(`Wrote ${file}`);
	const reload = systemctl(["daemon-reload"]);
	if (reload.code !== 0) {
		console.error(reload.output);
		return reload.code;
	}
	const enable = systemctl(["enable", unitName(parsed.name)]);
	if (enable.code !== 0) {
		console.error(enable.output);
		return enable.code;
	}
	const start = systemctl(["start", unitName(parsed.name)]);
	if (start.code !== 0) {
		console.error(start.output);
		return start.code;
	}
	console.log(`Service ${unitName(parsed.name)} enabled and started.`);
	console.log(`Tail logs: clawalski service logs ${paths.root}`);
	return 0;
}
async function uninstall(argv) {
	const r = pathArg(argv);
	if (typeof r !== "string") {
		console.error(r.error);
		return 2;
	}
	const paths = resolveInstancePaths(r);
	const nameOrErr = requireServiceName(paths);
	if (typeof nameOrErr !== "string") {
		console.error(nameOrErr.error);
		return 1;
	}
	const name = nameOrErr;
	systemctl(["stop", unitName(name)]);
	systemctl(["disable", unitName(name)]);
	const file = unitFilePath(name);
	if (existsSync(file)) rmSync(file);
	systemctl(["daemon-reload"]);
	deleteServiceFile(paths);
	console.log(`Uninstalled ${unitName(name)}.`);
	console.log(`Instance data at ${paths.root} left intact.`);
	return 0;
}
function passthrough(action) {
	return async (argv) => {
		const r = pathArg(argv);
		if (typeof r !== "string") {
			console.error(r.error);
			return 2;
		}
		const nameOrErr = requireServiceName(resolveInstancePaths(r));
		if (typeof nameOrErr !== "string") {
			console.error(nameOrErr.error);
			return 1;
		}
		const result = systemctl([action, unitName(nameOrErr)]);
		if (action === "status") process.stdout.write(result.output);
		else if (result.code !== 0) process.stderr.write(result.output);
		return result.code;
	};
}
async function logs(argv) {
	const r = pathArg(argv);
	if (typeof r !== "string") {
		console.error(r.error);
		return 2;
	}
	const nameOrErr = requireServiceName(resolveInstancePaths(r));
	if (typeof nameOrErr !== "string") {
		console.error(nameOrErr.error);
		return 1;
	}
	return spawnSync("journalctl", [
		"--user",
		"-u",
		unitName(nameOrErr),
		"-f"
	], { stdio: "inherit" }).status ?? 0;
}
async function serviceCommand(argv) {
	const [sub, ...rest] = argv;
	switch (sub) {
		case "install": return install(rest);
		case "uninstall": return uninstall(rest);
		case "start": return passthrough("start")(rest);
		case "stop": return passthrough("stop")(rest);
		case "restart": return passthrough("restart")(rest);
		case "status": return passthrough("status")(rest);
		case "logs": return logs(rest);
		default:
			console.error(`Unknown service subcommand: ${sub ?? "(none)"}`);
			console.error("Subcommands: install | uninstall | start | stop | restart | status | logs");
			return 2;
	}
}
//#endregion
//#region src/cli/commands/update.ts
const LATEST_TARBALL = "https://github.com/prempv/clawalski/archive/refs/heads/master.tar.gz";
async function updateCommand(_argv) {
	if (spawnSync("which", ["npm"], { encoding: "utf-8" }).status !== 0) {
		console.error("npm not found on PATH. Install Node/npm to use `clawalski update`.");
		return 1;
	}
	console.log(`Upgrading via \`npm i -g ${LATEST_TARBALL}\`...`);
	return spawnSync("npm", [
		"i",
		"-g",
		LATEST_TARBALL
	], { stdio: "inherit" }).status ?? 0;
}
//#endregion
//#region src/cli/help.ts
function printTopHelp() {
	console.log(`clawalski — Telegram bot gateway to Claude Code CLI

Usage:
  clawalski init <path> [flags]            Scaffold a new instance directory
  clawalski run <path>                     Run an instance in the foreground
  clawalski service install <path> --name <n>
                                           Register and start a systemd user service
  clawalski service uninstall <path>       Remove the systemd user service
  clawalski service start|stop|restart|status|logs <path>
                                           Manage the instance's service
  clawalski list                           List registered clawalski-* services
  clawalski update                         Upgrade via \`pnpm add -g git+…\`
  clawalski version                        Show version
  clawalski help                           Show this help

Init flags:
  --token <T>           Bot token (interactive prompt if missing on a TTY)
  --admin-chat-id <ID>  Optional admin chat id
  --no-interactive      Fail instead of prompting
`);
}
//#endregion
//#region src/cli/version.ts
function getVersion() {
	try {
		const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return typeof pkg.version === "string" ? pkg.version : "dev";
	} catch {
		return "dev";
	}
}
function printVersion() {
	console.log(`clawalski ${getVersion()}`);
}
//#endregion
//#region src/cli.ts
async function main(argv) {
	if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
		printTopHelp();
		return 0;
	}
	if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "version") {
		printVersion();
		return 0;
	}
	const [cmd, ...rest] = argv;
	switch (cmd) {
		case "init": return initCommand(rest);
		case "run": return runCommand(rest);
		case "service": return serviceCommand(rest);
		case "list": return listCommand(rest);
		case "update": return updateCommand(rest);
		default:
			console.error(`Unknown command: ${cmd}\n`);
			printTopHelp();
			return 1;
	}
}
main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
	console.error(err?.stack ?? err);
	process.exit(1);
});
//#endregion
export {};

//# sourceMappingURL=cli.js.map