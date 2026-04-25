import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessConfig } from "./access.js";
import {
	formatAdminNotification,
	isAllowed,
	shouldNotifyAdmin,
} from "./access.js";
import type { PendingBackendStore } from "./backend-registry.js";
import type {
	BackendBridgeOptions,
	BackendId,
	BackendRegistry,
	ConversationProcess,
} from "./backend.js";
import { isBackendId } from "./backend.js";
import { sendMessageWithAuthRetry } from "./claude-bridge.js";
import { ensureFreshCliToken } from "./cli-token-warmup.js";
import {
	type ConversationLogger,
	conversationIdToDir,
} from "./conversation-logger.js";
import { commandToJobName } from "./cron-config.js";
import type { CronScheduler } from "./cron-scheduler.js";
import type { Logger } from "./logger.js";
import {
	type MessageContext,
	extractMessageContext,
} from "./message-context.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { RequestTimer } from "./request-timer.js";
import type { SessionStore } from "./session-store.js";
import { streamToTelegram } from "./streaming.js";
import type { TelegramClient } from "./telegram-client.js";
import type {
	ContentBlock,
	PhotoSize,
	TelegramMessage,
	TelegramUpdate,
} from "./types.js";

export interface HandleUpdateOptions {
	respondMode: "all" | "mention";
	botUsername: string;
	getAccess: () => AccessConfig;
	sessionStore: SessionStore;
	backends: BackendRegistry;
	pendingBackends: PendingBackendStore;
	conversationLogger: ConversationLogger;
	cronScheduler?: CronScheduler;
	promptsDir: string;
	cronFilePath: string;
	conversationLogDir: string;
}

function pickBackend(
	ctx: MessageContext,
	opts: HandleUpdateOptions,
	existing: { backend: BackendId } | null,
): BackendId {
	// Existing session pins backend for its lifetime — see decision: backend
	// locked at session start, /new clears the session and the pin.
	if (existing) return existing.backend;
	const pending = opts.pendingBackends.get(ctx.conversationId);
	if (pending) return pending;
	const access = opts.getAccess();
	const channelDefault =
		ctx.chatType === "private"
			? access.dmDefaultBackend
			: access.groupDefaultBackend;
	if (channelDefault) return channelDefault;
	return opts.backends.defaultId;
}

// Track in-flight requests per conversation to prevent concurrent processing
const activeRequests = new Set<string>();

// Buffer media group messages so multiple photos sent together are batched
// into a single Claude turn.
const MEDIA_GROUP_DELAY_MS = 500;
const mediaGroupBuffers = new Map<
	string,
	{ messages: TelegramMessage[]; timeout: ReturnType<typeof setTimeout> }
>();

export async function handleUpdate(
	client: TelegramClient,
	update: TelegramUpdate,
	log: Logger,
	opts: HandleUpdateOptions,
	timer?: RequestTimer,
): Promise<void> {
	const message = update.message ?? update.edited_message;
	if (!message) return;

	// Media group batching: buffer messages that share a media_group_id,
	// then process them together after a short delay.
	if (message.media_group_id) {
		const groupId = message.media_group_id;
		const existing = mediaGroupBuffers.get(groupId);
		if (existing) {
			existing.messages.push(message);
			clearTimeout(existing.timeout);
			existing.timeout = setTimeout(() => {
				mediaGroupBuffers.delete(groupId);
				processMediaGroup(client, existing.messages, log, opts).catch((err) =>
					log.error({ err, groupId }, "media group handler error"),
				);
			}, MEDIA_GROUP_DELAY_MS);
			return;
		}
		const buf = {
			messages: [message],
			timeout: setTimeout(() => {
				mediaGroupBuffers.delete(groupId);
				processMediaGroup(client, buf.messages, log, opts).catch((err) =>
					log.error({ err, groupId }, "media group handler error"),
				);
			}, MEDIA_GROUP_DELAY_MS),
		};
		mediaGroupBuffers.set(groupId, buf);
		return;
	}

	await processSingleMessage(client, message, log, opts, timer);
}

async function processSingleMessage(
	client: TelegramClient,
	message: TelegramMessage,
	log: Logger,
	opts: HandleUpdateOptions,
	timer?: RequestTimer,
): Promise<void> {
	const t = timer ?? new RequestTimer();
	t.mark("handler_start");

	const ctx = extractMessageContext(message);

	// Access control gate
	const access = opts.getAccess();
	if (!isAllowed(ctx, access)) {
		log.debug(
			{ conversationId: ctx.conversationId, sender: ctx.senderName },
			"access denied",
		);
		if (access.adminChatId && shouldNotifyAdmin(ctx)) {
			const notification = formatAdminNotification(ctx);
			client
				.sendMessage({ chat_id: access.adminChatId, text: notification })
				.catch((err) => {
					log.error({ err }, "failed to send admin notification");
				});
		}
		return;
	}

	// Mention mode: skip group messages unless bot is addressed
	if (
		opts.respondMode === "mention" &&
		ctx.chatType !== "private" &&
		!isBotAddressed(message, opts.botUsername)
	) {
		return;
	}

	const text = extractText(message);
	const hasPhoto = !!message.photo?.length;
	const hasDocument = !!message.document;

	if (!text && !hasPhoto && !hasDocument) return;

	// Command routing
	if (text?.startsWith("/new")) {
		await handleNewCommand(client, ctx.conversationId, message, opts, log);
		return;
	}

	if (text?.startsWith("/stats")) {
		await handleStatsCommand(client, ctx.conversationId, message, opts);
		return;
	}

	if (text?.startsWith("/run_") && opts.cronScheduler) {
		const commandPart = text.split(/\s/)[0]?.slice(1) ?? "";
		const jobName = commandToJobName(commandPart);
		await handleRunCronCommand(
			client,
			message,
			jobName,
			opts.cronScheduler,
			log,
		);
		return;
	}

	// /cron skill — enrich message with skill reference and context
	const effectiveText =
		text != null && /^\/cron(\s|@|$)/.test(text)
			? buildCronSkillMessage(
					text.replace(/^\/cron(@\S+)?\s*/, ""),
					ctx,
					opts.promptsDir,
					opts.cronFilePath,
				)
			: text;

	// Strip bot mention from group messages
	const cleanText = effectiveText
		? stripBotMention(effectiveText, opts.botUsername)
		: null;

	// Concurrency gate
	if (activeRequests.has(ctx.conversationId)) {
		await client.sendMessage({
			chat_id: ctx.chatId,
			text: "Still processing your previous message. Please wait.",
			...(message.message_thread_id && {
				message_thread_id: message.message_thread_id,
			}),
			reply_parameters: { message_id: message.message_id },
		});
		return;
	}

	activeRequests.add(ctx.conversationId);

	try {
		// Build content blocks (may involve downloading media)
		const content: ContentBlock[] = [];

		if (hasPhoto) {
			try {
				const imageBlock = await downloadPhoto(client, message.photo ?? []);
				content.push(imageBlock);
			} catch (err) {
				log.error({ err }, "failed to download photo");
				content.push({ type: "text", text: "[photo — download failed]" });
			}
		}

		if (hasDocument && message.document) {
			try {
				const filePath = await downloadDocument(client, message.document);
				const ref = `[File saved to: ${filePath}]\nRead and process this file.`;
				content.push({ type: "text", text: ref });
			} catch (err) {
				log.error({ err }, "failed to download document");
				content.push({
					type: "text",
					text: `[document: ${message.document.file_name ?? "unknown"} — download failed]`,
				});
			}
		}

		if (cleanText) {
			content.push({ type: "text", text: cleanText });
		}

		if (content.length === 0) return;

		// Describe input for logging
		const inputDescription = describeInput(hasPhoto, hasDocument, cleanText);

		t.mark("session_lookup");
		const existingSession = opts.sessionStore.getSession(ctx.conversationId);
		const backendId = pickBackend(ctx, opts, existingSession);
		const pool = opts.backends.pool(backendId);

		log.info(
			{
				conversationId: ctx.conversationId,
				backend: backendId,
				hasSession: !!existingSession,
				sender: ctx.senderName,
				hasPhoto,
				hasDocument,
			},
			"routing message",
		);

		t.mark("claude_invoke");

		if (backendId === "claude") {
			try {
				await ensureFreshCliToken(log);
			} catch (err) {
				log.error({ err }, "CLI token warmup failed — proceeding anyway");
			}
		}

		const overrides = buildProcessOverrides(opts, ctx);

		let lastProc: ConversationProcess | null = null;
		const events = sendMessageWithAuthRetry(
			() => {
				lastProc = pool.getOrCreate(
					ctx.conversationId,
					existingSession?.sessionId ?? null,
					t,
					overrides,
				);
				return lastProc;
			},
			() => pool.remove(ctx.conversationId),
			content,
			t,
			log,
		);

		const result = await streamToTelegram(
			client,
			{
				chatId: ctx.chatId,
				messageThreadId: message.message_thread_id,
				replyToMessageId: message.message_id,
			},
			events,
			log,
			t,
		);

		t.mark("done");

		// Save session from either the stream result or the process
		const sessionId =
			result.sessionId ?? (lastProc as ConversationProcess | null)?.sessionId;
		if (sessionId) {
			opts.sessionStore.setSession(ctx.conversationId, sessionId, backendId);
			opts.pendingBackends.clear(ctx.conversationId);
			opts.sessionStore.updateStats(ctx.conversationId, {
				backend: backendId,
				claudeSessionId: sessionId,
				model: result.model,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				costUsd: result.costUsd,
				contextWindow: result.contextWindow,
			});
			opts.conversationLogger.log({
				timestamp: new Date().toISOString(),
				conversationId: ctx.conversationId,
				sessionId,
				sender: {
					id: ctx.senderId,
					name: ctx.senderName,
					username: ctx.senderUsername,
				},
				input: inputDescription,
				output: result.responseText,
				tools: result.toolHistory,
				durationMs: t.summary().total ?? 0,
				error:
					result.error ?? (result.interrupted ? "stream interrupted" : null),
				timings: t.summary(),
			});
		}

		log.info(
			{
				conversationId: ctx.conversationId,
				timings: t.summary(),
				tools: result.toolHistory.length,
				sender: ctx.senderName,
			},
			"claude response complete",
		);
	} catch (err) {
		log.error(
			{ err, conversationId: ctx.conversationId },
			"claude handler error",
		);
		// Try to notify the user
		await client
			.sendMessage({
				chat_id: ctx.chatId,
				text: "Something went wrong. Please try again.",
				...(message.message_thread_id && {
					message_thread_id: message.message_thread_id,
				}),
				reply_parameters: { message_id: message.message_id },
			})
			.catch(() => {});
	} finally {
		activeRequests.delete(ctx.conversationId);
	}
}

async function handleStatsCommand(
	client: TelegramClient,
	conversationId: string,
	message: TelegramMessage,
	opts: HandleUpdateOptions,
): Promise<void> {
	const stats = opts.sessionStore.getStats(conversationId);
	const replyOpts = {
		chat_id: message.chat.id,
		...(message.message_thread_id && {
			message_thread_id: message.message_thread_id,
		}),
		reply_parameters: { message_id: message.message_id },
	};

	if (!stats) {
		await client.sendMessage({ ...replyOpts, text: "No active session." });
		return;
	}

	const fmt = (n: number) => n.toLocaleString("en-US");
	const totalTokens = stats.totalInputTokens + stats.totalOutputTokens;

	const lines = ["Session Stats", ""];
	lines.push(`Session: ${stats.claudeSessionId ?? "unknown"}`);
	if (stats.model) lines.push(`Model: ${stats.model}`);
	if (stats.contextWindow) {
		const pct = ((totalTokens / stats.contextWindow) * 100).toFixed(1);
		lines.push(
			`Context: ${fmt(totalTokens)} / ${fmt(stats.contextWindow)} (${pct}%)`,
		);
	}
	lines.push("");
	lines.push(`Input tokens: ${fmt(stats.totalInputTokens)}`);
	lines.push(`Output tokens: ${fmt(stats.totalOutputTokens)}`);
	if (stats.totalCostUsd != null) {
		lines.push(`Session cost: $${stats.totalCostUsd.toFixed(4)}`);
	}
	lines.push(`Turns: ${stats.turns}`);

	const ago = Math.floor(Date.now() / 1000) - stats.createdAt;
	if (ago < 3600) {
		lines.push(`Active since: ${Math.floor(ago / 60)}m ago`);
	} else {
		const hours = Math.floor(ago / 3600);
		const mins = Math.floor((ago % 3600) / 60);
		lines.push(`Active since: ${hours}h ${mins}m ago`);
	}

	await client.sendMessage({ ...replyOpts, text: lines.join("\n") });
}

async function handleNewCommand(
	client: TelegramClient,
	conversationId: string,
	message: TelegramMessage,
	opts: HandleUpdateOptions,
	log: Logger,
): Promise<void> {
	const replyOpts = {
		chat_id: message.chat.id,
		...(message.message_thread_id && {
			message_thread_id: message.message_thread_id,
		}),
		reply_parameters: { message_id: message.message_id },
	};

	const arg =
		message.text
			?.replace(/^\/new(@\S+)?/, "")
			.trim()
			.toLowerCase() ?? "";

	if (arg && !isBackendId(arg)) {
		await client.sendMessage({
			...replyOpts,
			text: `Unknown backend: "${arg}". Use 'claude' or 'codex'.`,
		});
		return;
	}

	// Tear down whichever backend's pool currently holds this conversation.
	for (const id of ["claude", "codex"] as const) {
		opts.backends.pool(id).remove(conversationId);
	}
	opts.sessionStore.deleteSession(conversationId);

	if (arg && isBackendId(arg)) {
		opts.pendingBackends.set(conversationId, arg);
		await client.sendMessage({
			...replyOpts,
			text: `Session cleared. Next message will use ${arg}.`,
		});
		log.info(
			{ conversationId, backend: arg },
			"session cleared via /new <backend>",
		);
	} else {
		opts.pendingBackends.clear(conversationId);
		await client.sendMessage({
			...replyOpts,
			text: "Session cleared. Next message starts a fresh conversation.",
		});
		log.info({ conversationId }, "session cleared via /new");
	}
}

async function handleRunCronCommand(
	client: TelegramClient,
	message: TelegramMessage,
	jobName: string,
	cronScheduler: CronScheduler,
	log: Logger,
): Promise<void> {
	const result = await cronScheduler.runJob(jobName, {
		manual: true,
		overrideChatId: message.chat.id,
		overrideThreadId: message.message_thread_id,
	});

	if (!result.found) {
		await client.sendMessage({
			chat_id: message.chat.id,
			text: `Unknown cron job: "${jobName}"`,
			...(message.message_thread_id && {
				message_thread_id: message.message_thread_id,
			}),
			reply_parameters: { message_id: message.message_id },
		});
		return;
	}

	if (result.busy) {
		await client.sendMessage({
			chat_id: message.chat.id,
			text: `Job "${jobName}" is already running. Please wait.`,
			...(message.message_thread_id && {
				message_thread_id: message.message_thread_id,
			}),
			reply_parameters: { message_id: message.message_id },
		});
		return;
	}

	// Job was enqueued — execution happens async, output streams to this chat
	log.info({ job: jobName, chatId: message.chat.id }, "manual cron trigger");
}

/**
 * Process a batch of messages that share a media_group_id.
 * Downloads all photos/documents and sends them as a single Claude turn.
 */
async function processMediaGroup(
	client: TelegramClient,
	messages: TelegramMessage[],
	log: Logger,
	opts: HandleUpdateOptions,
): Promise<void> {
	if (messages.length === 0) return;

	const t = new RequestTimer();
	t.mark("handler_start");

	// Use the first message for context (chat, thread, sender)
	const first = messages[0] as TelegramMessage;
	const ctx = extractMessageContext(first);

	const access = opts.getAccess();
	if (!isAllowed(ctx, access)) return;

	if (
		opts.respondMode === "mention" &&
		ctx.chatType !== "private" &&
		!messages.some((m) => isBotAddressed(m, opts.botUsername))
	) {
		return;
	}

	if (activeRequests.has(ctx.conversationId)) {
		await client.sendMessage({
			chat_id: ctx.chatId,
			text: "Still processing your previous message. Please wait.",
			...(first.message_thread_id && {
				message_thread_id: first.message_thread_id,
			}),
			reply_parameters: { message_id: first.message_id },
		});
		return;
	}

	activeRequests.add(ctx.conversationId);

	try {
		const content: ContentBlock[] = [];
		let caption: string | null = null;

		for (const msg of messages) {
			if (msg.photo?.length) {
				try {
					const imageBlock = await downloadPhoto(client, msg.photo);
					content.push(imageBlock);
				} catch (err) {
					log.error({ err }, "failed to download photo in media group");
				}
			}
			if (msg.document) {
				try {
					const filePath = await downloadDocument(client, msg.document);
					content.push({
						type: "text",
						text: `[File saved to: ${filePath}]\nRead and process this file.`,
					});
				} catch (err) {
					log.error({ err }, "failed to download document in media group");
				}
			}
			// Media groups typically have caption on the first message only
			if (!caption && msg.caption) {
				caption = stripBotMention(msg.caption, opts.botUsername);
			}
		}

		if (caption) {
			content.push({ type: "text", text: caption });
		}

		if (content.length === 0) return;

		const photoCount = messages.filter((m) => m.photo?.length).length;
		const docCount = messages.filter((m) => m.document).length;
		const inputDescription = describeInput(
			photoCount > 0,
			docCount > 0,
			caption,
		);

		t.mark("session_lookup");
		const existingSession = opts.sessionStore.getSession(ctx.conversationId);
		const backendId = pickBackend(ctx, opts, existingSession);
		const pool = opts.backends.pool(backendId);

		log.info(
			{
				conversationId: ctx.conversationId,
				backend: backendId,
				hasSession: !!existingSession,
				sender: ctx.senderName,
				mediaGroupSize: messages.length,
				photoCount,
				docCount,
			},
			"routing media group",
		);

		t.mark("claude_invoke");

		if (backendId === "claude") {
			try {
				await ensureFreshCliToken(log);
			} catch (err) {
				log.error({ err }, "CLI token warmup failed — proceeding anyway");
			}
		}

		const overrides = buildProcessOverrides(opts, ctx);

		let lastProc: ConversationProcess | null = null;
		const events = sendMessageWithAuthRetry(
			() => {
				lastProc = pool.getOrCreate(
					ctx.conversationId,
					existingSession?.sessionId ?? null,
					t,
					overrides,
				);
				return lastProc;
			},
			() => pool.remove(ctx.conversationId),
			content,
			t,
			log,
		);

		const result = await streamToTelegram(
			client,
			{
				chatId: ctx.chatId,
				messageThreadId: first.message_thread_id,
				replyToMessageId: first.message_id,
			},
			events,
			log,
			t,
		);

		t.mark("done");

		const sessionId =
			result.sessionId ?? (lastProc as ConversationProcess | null)?.sessionId;
		if (sessionId) {
			opts.sessionStore.setSession(ctx.conversationId, sessionId, backendId);
			opts.pendingBackends.clear(ctx.conversationId);
			opts.sessionStore.updateStats(ctx.conversationId, {
				backend: backendId,
				claudeSessionId: sessionId,
				model: result.model,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				costUsd: result.costUsd,
				contextWindow: result.contextWindow,
			});
			opts.conversationLogger.log({
				timestamp: new Date().toISOString(),
				conversationId: ctx.conversationId,
				sessionId,
				sender: {
					id: ctx.senderId,
					name: ctx.senderName,
					username: ctx.senderUsername,
				},
				input: inputDescription,
				output: result.responseText,
				tools: result.toolHistory,
				durationMs: t.summary().total ?? 0,
				error:
					result.error ?? (result.interrupted ? "stream interrupted" : null),
				timings: t.summary(),
			});
		}

		log.info(
			{
				conversationId: ctx.conversationId,
				timings: t.summary(),
				tools: result.toolHistory.length,
				sender: ctx.senderName,
			},
			"claude media group response complete",
		);
	} catch (err) {
		log.error(
			{ err, conversationId: ctx.conversationId },
			"media group handler error",
		);
		await client
			.sendMessage({
				chat_id: ctx.chatId,
				text: "Something went wrong. Please try again.",
				...(first.message_thread_id && {
					message_thread_id: first.message_thread_id,
				}),
				reply_parameters: { message_id: first.message_id },
			})
			.catch(() => {});
	} finally {
		activeRequests.delete(ctx.conversationId);
	}
}

function isBotAddressed(
	message: TelegramMessage,
	botUsername: string,
): boolean {
	const lower = botUsername.toLowerCase();

	const textToCheck = message.text ?? message.caption;
	if (textToCheck?.toLowerCase().includes(`@${lower}`)) {
		return true;
	}

	if (message.reply_to_message?.from?.username?.toLowerCase() === lower) {
		return true;
	}

	return false;
}

/**
 * Extract the text portion of a message.
 * Returns null for photos/documents without captions — those are handled
 * via content blocks (image base64 / file path) in the handler.
 */
function extractText(
	message: NonNullable<TelegramUpdate["message"]>,
): string | null {
	if (message.text) return message.text;
	if (message.caption) return message.caption;
	if (message.sticker?.emoji) return message.sticker.emoji;
	// Photos and documents without captions: no text, handled via content blocks
	if (message.photo?.length) return null;
	if (message.document) return null;
	// Unsupported media types
	if (message.video) return "[video received]";
	if (message.audio) return "[audio received]";
	if (message.voice) return "[voice received]";
	return null;
}

function stripBotMention(text: string, botUsername: string): string {
	const mention = new RegExp(`@${botUsername}\\b`, "gi");
	return text.replace(mention, "").trim();
}

async function downloadPhoto(
	client: TelegramClient,
	photos: PhotoSize[],
): Promise<ContentBlock> {
	// Telegram sends multiple sizes — pick the largest (last in array)
	const photo = photos[photos.length - 1] as PhotoSize;
	const file = await client.getFile(photo.file_id);
	if (!file.file_path) throw new Error("No file_path in getFile response");
	const buffer = await client.downloadFileBuffer(file.file_path);
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: "image/jpeg", // Telegram always converts photos to JPEG
			data: buffer.toString("base64"),
		},
	};
}

const TG_FILES_DIR = "/tmp/tg-files";

async function downloadDocument(
	client: TelegramClient,
	doc: NonNullable<TelegramMessage["document"]>,
): Promise<string> {
	const file = await client.getFile(doc.file_id);
	if (!file.file_path) throw new Error("No file_path in getFile response");
	const buffer = await client.downloadFileBuffer(file.file_path);
	mkdirSync(TG_FILES_DIR, { recursive: true });
	const filename = doc.file_name ?? `${doc.file_unique_id}`;
	const destPath = join(TG_FILES_DIR, `${doc.file_unique_id}_${filename}`);
	writeFileSync(destPath, buffer);
	return destPath;
}

function describeInput(
	hasPhoto: boolean,
	hasDocument: boolean,
	text: string | null,
): string {
	const parts: string[] = [];
	if (hasPhoto) parts.push("[photo]");
	if (hasDocument) parts.push("[document]");
	if (text) parts.push(text);
	return parts.join(" ") || "[media]";
}

function buildProcessOverrides(
	opts: HandleUpdateOptions,
	ctx: MessageContext,
): Partial<BackendBridgeOptions> {
	const tier = ctx.chatType === "private" ? "dm" : "group";
	let systemPrompt = buildSystemPrompt(opts.promptsDir, tier);

	const convDirName = conversationIdToDir(ctx.conversationId);
	const conversationHistoryDir = join(opts.conversationLogDir, convDirName);

	const historyNote = `Past conversation history for this channel is stored in: ${conversationHistoryDir}/\nEach file is a JSONL log of a previous session containing input/output pairs. Read them if prior context would help answer the current question.`;
	systemPrompt =
		systemPrompt !== undefined
			? `${systemPrompt}\n\n${historyNote}`
			: historyNote;

	return { systemPrompt, conversationHistoryDir };
}

function buildCronSkillMessage(
	userText: string,
	ctx: MessageContext,
	promptsDir: string,
	cronFilePath: string,
): string {
	const skillPath = join(promptsDir, "skills", "cron-manager.md");

	let triggerDesc: string;
	if (ctx.chatType === "private") {
		triggerDesc = `DM (chatId: ${ctx.chatId})`;
	} else if (ctx.isForum && ctx.threadId != null) {
		triggerDesc = `forum topic${ctx.chatTitle ? ` in "${ctx.chatTitle}"` : ""} (chatId: ${ctx.chatId}, threadId: ${ctx.threadId})`;
	} else {
		triggerDesc = `group${ctx.chatTitle ? ` "${ctx.chatTitle}"` : ""} (chatId: ${ctx.chatId})`;
	}

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
		request,
	].join("\n");
}
