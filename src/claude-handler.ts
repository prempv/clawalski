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
	BackendStreamEvent,
	ConversationProcess,
} from "./backend.js";
import { BACKEND_IDS, isBackendId } from "./backend.js";
import type { BindingConfig } from "./binding-config.js";
import { resolveBinding } from "./binding-config.js";
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
import { redactedPreview } from "./redaction.js";
import { RequestTimer } from "./request-timer.js";
import type { SessionRecorder } from "./session-stats/index.js";
import type { SessionStore } from "./session-store.js";
import { formatStatsMessage } from "./stats-format.js";
import {
	type StreamTurnResult,
	type StreamingContext,
	streamToTelegram,
} from "./streaming.js";
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
	sessionRecorder: SessionRecorder;
	backends: BackendRegistry;
	pendingBackends: PendingBackendStore;
	conversationLogger: ConversationLogger;
	cronScheduler?: CronScheduler;
	promptsDir: string;
	cronFilePath: string;
	conversationLogDir: string;
	bindings: BindingConfig;
}

function pickBackend(
	ctx: MessageContext,
	opts: HandleUpdateOptions,
	existing: { backend: BackendId } | null,
): BackendId {
	// /new-<backend> always wins over a leftover row. The user just told us
	// to switch backends; the row may be stale (e.g. a pre-existing session
	// the user hasn't typed into yet, or, historically, a row resurrected
	// by a forwarder we no longer own).
	const pending = opts.pendingBackends.get(ctx.conversationId);
	if (pending) return pending;
	if (existing) return existing.backend;
	const access = opts.getAccess();
	const channelDefault =
		ctx.chatType === "private"
			? access.dmDefaultBackend
			: access.groupDefaultBackend;
	if (channelDefault) return channelDefault;
	return opts.backends.defaultId;
}

function isClaudeBackend(backendId: BackendId): boolean {
	return backendId === "claude" || backendId === "claude-v2";
}

async function* sendMessageDirect(
	proc: ConversationProcess,
	content: ContentBlock[],
	timer?: RequestTimer,
): AsyncGenerator<BackendStreamEvent> {
	proc.sendInput(content, timer);
	yield* proc.stream();
}

function firstTurnEvents(
	backendId: BackendId,
	proc: ConversationProcess,
	pool: ReturnType<BackendRegistry["pool"]>,
	conversationId: string,
	resumeSessionId: string | null,
	overrides: Partial<BackendBridgeOptions>,
	content: ContentBlock[],
	timer: RequestTimer,
	log: Logger,
): AsyncIterable<BackendStreamEvent> {
	if (backendId === "claude-v2") {
		return sendMessageDirect(proc, content, timer);
	}
	return sendMessageWithAuthRetry(
		proc,
		() => pool.getOrCreate(conversationId, resumeSessionId, timer, overrides),
		() => pool.remove(conversationId),
		content,
		timer,
		log,
	);
}

function persistSessionId(
	opts: HandleUpdateOptions,
	conversationId: string,
	sessionId: string | null | undefined,
	backendId: BackendId,
): void {
	if (!sessionId) return;
	opts.sessionStore.setSession(conversationId, sessionId, backendId);
	opts.pendingBackends.clear(conversationId);
}

// ---------------------------------------------------------------------------
// Per-conversation session state
//
// Each conversation owns one long-lived ClaudeProcess and one long-running
// streamToTelegram forwarder. User inputs (Telegram messages) are submitted
// via proc.sendInput when the proc is quiescent; while it's busy, they're
// queued and drained on the proc's onQuiescent callback. This is the new
// busy-gate — there's no more idle timer, and no per-message iterator that
// has to "end" before the next user input can be submitted.
// ---------------------------------------------------------------------------

type PendingItem =
	| { kind: "single"; message: TelegramMessage }
	| { kind: "group"; messages: TelegramMessage[] };

interface ClaudeSession {
	conversationId: string;
	backendId: BackendId;
	proc: ConversationProcess;
	/** Long-running streamToTelegram. Resolves when proc closes or dies. */
	forwarder: Promise<unknown>;
	/** Detach the onQuiescent listener when tearing the session down. */
	unsubscribeQuiescent: () => void;
	pending: PendingItem[];
	streamingContext: StreamingContext;
	/** True while a sendInput's content blocks are being built/dispatched.
	 * Prevents the onQuiescent drain from racing with an in-flight submit. */
	submitInFlight: boolean;
	activeTurn: ActiveTurnInput | null;
}

interface ActiveTurnInput {
	startedAt: number;
	input: string;
	inputDescription: string;
	sender: { id: number | null; name: string; username: string | null };
	messageId: number;
	textPreview: string;
}

const sessions = new Map<string, ClaudeSession>();
const MAX_QUEUE_SIZE = 10;
const QUEUE_ACK_EMOJI = "👀";

// Buffer media group messages so multiple photos sent together are batched
// into a single Claude turn.
const MEDIA_GROUP_DELAY_MS = 500;
const mediaGroupBuffers = new Map<
	string,
	{ messages: TelegramMessage[]; timeout: ReturnType<typeof setTimeout> }
>();

function enqueueMessage(session: ClaudeSession, item: PendingItem): boolean {
	if (session.pending.length >= MAX_QUEUE_SIZE) return false;
	session.pending.push(item);
	return true;
}

function pendingItemLogFields(item: PendingItem): Record<string, unknown> {
	const firstMsg =
		item.kind === "single"
			? item.message
			: (item.messages[0] as TelegramMessage);
	const text = extractText(firstMsg);
	return {
		kind: item.kind,
		messageId: firstMsg.message_id,
		textLen: text?.length ?? 0,
		textPreview: text ? redactedPreview(text) : "[media]",
		...(item.kind === "group" && { groupSize: item.messages.length }),
	};
}

/**
 * Acknowledge a queued message with an emoji reaction. Falls back to a tiny
 * text reply if reactions aren't available (older bot or restricted chat).
 */
async function ackQueued(
	client: TelegramClient,
	message: TelegramMessage,
	queueDepth: number,
	log: Logger,
): Promise<void> {
	try {
		await client.setMessageReaction({
			chat_id: message.chat.id,
			message_id: message.message_id,
			emojis: [QUEUE_ACK_EMOJI],
		});
	} catch (err) {
		log.debug({ err }, "reaction ack failed, sending text ack");
		await client
			.sendMessage({
				chat_id: message.chat.id,
				text: `Queued (${queueDepth} ahead). Will run after the current turn.`,
				...(message.message_thread_id && {
					message_thread_id: message.message_thread_id,
				}),
				reply_parameters: { message_id: message.message_id },
			})
			.catch(() => {});
	}
}

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
	const ctx = extractMessageContext(message);

	// Access + mention + content-presence checks: cheap and they decide
	// whether we even acknowledge this message. We want denied users not to
	// get a 👀 reaction, so we run these BEFORE the queue gate.
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

	// Commands run immediately and never queue: /new-* must be able to cancel
	// in-flight state, /stats and /run_X are non-LLM and harmless mid-turn.
	const newBackend = matchNewBackendCommand(text);
	if (newBackend) {
		await handleNewBackendCommand(
			client,
			ctx.conversationId,
			message,
			newBackend,
			opts,
			log,
		);
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

	const existing = sessions.get(ctx.conversationId);
	if (existing?.proc.alive) {
		await submitToExistingSession(
			client,
			existing,
			{ kind: "single", message },
			log,
			opts,
		);
		return;
	}

	// No active session — create one and submit this message as the first input.
	await startSession(client, message, log, opts, timer);
}

/**
 * Submit a message to an already-running session. If Claude is busy
 * (mid-turn), enqueue and ack with 👀; the session's onQuiescent listener
 * will drain when the turn really ends. If quiescent, dispatch immediately.
 */
async function submitToExistingSession(
	client: TelegramClient,
	session: ClaudeSession,
	item: PendingItem,
	log: Logger,
	opts: HandleUpdateOptions,
): Promise<void> {
	if (!session.proc.quiescent || session.submitInFlight) {
		const ok = enqueueMessage(session, item);
		const firstMsg =
			item.kind === "single"
				? item.message
				: (item.messages[0] as TelegramMessage);
		if (!ok) {
			await client
				.sendMessage({
					chat_id: firstMsg.chat.id,
					text: `Queue is full (${MAX_QUEUE_SIZE} messages). Wait for the current turn to finish.`,
					...(firstMsg.message_thread_id && {
						message_thread_id: firstMsg.message_thread_id,
					}),
					reply_parameters: { message_id: firstMsg.message_id },
				})
				.catch(() => {});
			return;
		}
		log.info(
			{
				conversationId: session.conversationId,
				backend: session.backendId,
				sessionId: session.proc.sessionId,
				queueDepth: session.pending.length,
				quiescent: session.proc.quiescent,
				submitInFlight: session.submitInFlight,
				...pendingItemLogFields(item),
			},
			"message queued behind active session",
		);
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
async function dispatchPendingItem(
	client: TelegramClient,
	session: ClaudeSession,
	item: PendingItem,
	log: Logger,
	opts: HandleUpdateOptions,
): Promise<void> {
	session.submitInFlight = true;
	try {
		if (item.kind === "single") {
			const content = await buildSingleContent(client, item.message, log, opts);
			if (content && content.length > 0) {
				const text = describeContentBlocks(content);
				opts.sessionRecorder.recordUserInput(session.conversationId, text);
				log.info(
					{
						conversationId: session.conversationId,
						backend: session.backendId,
						sessionId: session.proc.sessionId,
						blocks: content.length,
						textLen: text.length,
						textPreview: redactedPreview(text),
						kind: "single",
					},
					"dispatching to backend CLI",
				);
				session.activeTurn = activeTurnFromMessage(
					extractMessageContext(item.message),
					item.message,
					text,
				);
				session.proc.sendInput(content);
			}
		} else {
			const content = await buildGroupContent(client, item.messages, log, opts);
			if (content && content.length > 0) {
				const text = describeContentBlocks(content);
				const first = item.messages[0] as TelegramMessage;
				opts.sessionRecorder.recordUserInput(session.conversationId, text);
				log.info(
					{
						conversationId: session.conversationId,
						backend: session.backendId,
						sessionId: session.proc.sessionId,
						blocks: content.length,
						textLen: text.length,
						textPreview: redactedPreview(text),
						kind: "group",
					},
					"dispatching to backend CLI",
				);
				session.activeTurn = activeTurnFromMessage(
					extractMessageContext(first),
					first,
					text,
				);
				session.proc.sendInput(content);
			}
		}
	} finally {
		session.submitInFlight = false;
	}
}

function describeContentBlocks(blocks: ContentBlock[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join("\n").trim() || "[media]";
}

function activeTurnFromMessage(
	ctx: MessageContext,
	message: TelegramMessage,
	input: string,
	inputDescription = input,
): ActiveTurnInput {
	return {
		startedAt: Date.now(),
		input,
		inputDescription,
		sender: {
			id: ctx.senderId,
			name: ctx.senderName,
			username: ctx.senderUsername,
		},
		messageId: message.message_id,
		textPreview: redactedPreview(input),
	};
}

/**
 * Spawn a new ClaudeProcess for this conversation, attach a long-running
 * streamToTelegram forwarder, register the queue-drain listener, and submit
 * the first user message. Auth retry is handled by sendMessageWithAuthRetry
 * during the first message; subsequent messages reuse the committed proc
 * directly via proc.sendInput.
 */
async function startSession(
	client: TelegramClient,
	message: TelegramMessage,
	log: Logger,
	opts: HandleUpdateOptions,
	timer?: RequestTimer,
): Promise<void> {
	const ctx = extractMessageContext(message);
	const t = timer ?? new RequestTimer();
	t.mark("handler_start");

	const text = extractText(message);
	const cleanText =
		text != null
			? /^\/cron(\s|@|$)/.test(text)
				? buildCronSkillMessage(
						text.replace(/^\/cron(@\S+)?\s*/, ""),
						ctx,
						opts.promptsDir,
						opts.cronFilePath,
					)
				: stripBotMention(text, opts.botUsername)
			: null;

	const content = await buildContent(client, message, cleanText, log);
	if (content.length === 0) return;

	const inputDescription = describeInput(
		!!message.photo?.length,
		!!message.document,
		cleanText,
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
			hasPhoto: !!message.photo?.length,
			hasDocument: !!message.document,
		},
		"routing first message — starting session",
	);

	t.mark("claude_invoke");

	if (isClaudeBackend(backendId)) {
		try {
			await ensureFreshCliToken(log);
		} catch (err) {
			log.error({ err }, "CLI token warmup failed — proceeding anyway");
		}
	}

	const overrides = buildProcessOverrides(opts, ctx);
	const resumeSessionId = opts.pendingBackends.get(ctx.conversationId)
		? null
		: (existingSession?.sessionId ?? null);

	// Spawn synchronously up front so we own a proc reference before the
	// forwarder starts consuming events. Earlier versions deferred the spawn
	// into sendMessageWithAuthRetry's iterator, which produced an orphan
	// forwarder (and a corrupted sessions row) whenever streamToTelegram's
	// own setup awaited before pulling its first event.
	const proc = pool.getOrCreate(
		ctx.conversationId,
		resumeSessionId,
		t,
		overrides,
	);
	persistSessionId(opts, ctx.conversationId, proc.sessionId, backendId);

	opts.sessionRecorder.start({
		conversationId: ctx.conversationId,
		backend: backendId,
	});
	const dispatchText = describeContentBlocks(content);
	opts.sessionRecorder.recordUserInput(ctx.conversationId, dispatchText);
	log.info(
		{
			conversationId: ctx.conversationId,
			backend: backendId,
			sessionId: existingSession?.sessionId ?? null,
			blocks: content.length,
			textLen: dispatchText.length,
			textPreview: redactedPreview(dispatchText),
			kind: "single",
			firstTurn: true,
		},
		"dispatching to backend CLI",
	);

	const events = firstTurnEvents(
		backendId,
		proc,
		pool,
		ctx.conversationId,
		resumeSessionId,
		overrides,
		content,
		t,
		log,
	);

	const streamingContext: StreamingContext = {
		conversationId: ctx.conversationId,
		backend: backendId,
		chatId: ctx.chatId,
		messageThreadId: message.message_thread_id,
		replyToMessageId: message.message_id,
	};

	const session: ClaudeSession = {
		conversationId: ctx.conversationId,
		backendId,
		proc,
		// Filled in below after `forwarder` is constructed; chained .then/.catch
		// can't reference itself synchronously.
		forwarder: Promise.resolve(),
		streamingContext,
		pending: [],
		submitInFlight: false,
		unsubscribeQuiescent: () => {},
		activeTurn: activeTurnFromMessage(
			ctx,
			message,
			dispatchText,
			inputDescription,
		),
	};
	sessions.set(ctx.conversationId, session);

	// Long-lived forwarder. handleSessionResult only runs if the session is
	// still the one we just registered — guards against any future path that
	// might leave a forwarder running after teardown.
	const forwarder = streamToTelegram(
		client,
		streamingContext,
		events,
		log,
		t,
		(event) => {
			opts.sessionRecorder.recordEvent(ctx.conversationId, event);
			if (event.type === "turn_complete") {
				const owned = sessions.get(ctx.conversationId);
				if (owned === session) {
					persistSessionId(
						opts,
						ctx.conversationId,
						event.sessionId,
						backendId,
					);
				}
			}
		},
		backendId === "claude-v2"
			? (turn) =>
					handleSessionTurnComplete(ctx, session, turn, backendId, opts, log)
			: undefined,
	)
		.then((result) => {
			t.mark("done");
			const owned = sessions.get(ctx.conversationId);
			if (owned !== session) return result;
			handleSessionResult(
				ctx,
				message,
				inputDescription,
				result,
				backendId,
				t,
				opts,
				log,
			);
			return result;
		})
		.catch((err) => {
			log.error(
				{ err, conversationId: ctx.conversationId },
				"long-running forwarder threw",
			);
			return null;
		})
		.finally(() => {
			const s = sessions.get(ctx.conversationId);
			if (s === session) {
				s.unsubscribeQuiescent();
				sessions.delete(ctx.conversationId);
			}
			opts.sessionRecorder.end(ctx.conversationId);
		});
	session.forwarder = forwarder;
	session.unsubscribeQuiescent = proc.onQuiescent(() => {
		drainPending(client, session, log, opts).catch((err) =>
			log.error({ err, conversationId: ctx.conversationId }, "drain error"),
		);
	});
}

async function drainPending(
	client: TelegramClient,
	session: ClaudeSession,
	log: Logger,
	opts: HandleUpdateOptions,
): Promise<void> {
	// We only drain ONE item per quiescent — sending it flips the proc back
	// to active, and the next quiescent fires after that turn finishes.
	if (session.submitInFlight) {
		log.debug(
			{
				conversationId: session.conversationId,
				backend: session.backendId,
				queueDepth: session.pending.length,
			},
			"queue drain skipped during submit",
		);
		return;
	}
	if (!session.proc.quiescent) {
		log.debug(
			{
				conversationId: session.conversationId,
				backend: session.backendId,
				queueDepth: session.pending.length,
				sessionId: session.proc.sessionId,
			},
			"queue drain skipped while session busy",
		);
		return;
	}
	const next = session.pending.shift();
	if (!next) return;
	log.info(
		{
			conversationId: session.conversationId,
			backend: session.backendId,
			sessionId: session.proc.sessionId,
			queueDepthRemaining: session.pending.length,
			...pendingItemLogFields(next),
		},
		"draining queued message",
	);
	await dispatchPendingItem(client, session, next, log, opts);
}

function handleSessionTurnComplete(
	ctx: MessageContext,
	session: ClaudeSession,
	turn: StreamTurnResult,
	backendId: BackendId,
	opts: HandleUpdateOptions,
	log: Logger,
): void {
	const sessionId = turn.sessionId ?? session.proc.sessionId;
	if (sessionId) {
		opts.sessionStore.setSession(ctx.conversationId, sessionId, backendId);
		opts.pendingBackends.clear(ctx.conversationId);
	}

	const input = session.activeTurn;
	const durationMs = input ? Date.now() - input.startedAt : 0;
	if (sessionId) {
		opts.conversationLogger.log({
			timestamp: new Date().toISOString(),
			conversationId: ctx.conversationId,
			sessionId,
			sender: input?.sender ?? {
				id: ctx.senderId,
				name: ctx.senderName,
				username: ctx.senderUsername,
			},
			input: input?.inputDescription ?? "[unknown input]",
			output: turn.responseText,
			tools: turn.toolHistory,
			durationMs,
			error: turn.error ?? (turn.interrupted ? "stream interrupted" : null),
			timings: {
				turn_duration_ms: durationMs,
			},
		});
	}

	log.info(
		{
			conversationId: ctx.conversationId,
			backend: backendId,
			sessionId,
			turnIndex: turn.turnIndex,
			durationMs,
			inputMessageId: input?.messageId,
			inputPreview: input?.textPreview,
			responseLen: turn.responseText.length,
			responsePreview: redactedPreview(turn.responseText),
			toolCount: turn.toolHistory.length,
			telegramMessageIds: turn.delivery.messageIds,
			telegramFailedChunks: turn.delivery.failedChunks,
			inputTokens: turn.inputTokens,
			outputTokens: turn.outputTokens,
			error: turn.error,
			interrupted: turn.interrupted,
		},
		"claude turn complete",
	);

	session.activeTurn = null;
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
function handleSessionResult(
	ctx: MessageContext,
	firstMessage: TelegramMessage,
	inputDescription: string,
	result: import("./streaming.js").StreamResult,
	backendId: BackendId,
	t: RequestTimer,
	opts: HandleUpdateOptions,
	log: Logger,
): void {
	const sessionId = result.sessionId;
	if (!sessionId) return;

	if (backendId === "claude-v2") {
		log.info(
			{
				conversationId: ctx.conversationId,
				sessionId,
				responseLen: result.responseText.length,
				toolCount: result.toolHistory.length,
				error:
					result.error ?? (result.interrupted ? "stream interrupted" : null),
			},
			"claude-v2 stream ended",
		);
		return;
	}

	opts.sessionStore.setSession(ctx.conversationId, sessionId, backendId);
	opts.pendingBackends.clear(ctx.conversationId);
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
		error: result.error ?? (result.interrupted ? "stream interrupted" : null),
		timings: t.summary(),
	});

	log.info(
		{
			conversationId: ctx.conversationId,
			timings: t.summary(),
			tools: result.toolHistory.length,
			triggeredBy: redactedPreview(extractText(firstMessage), 60) || "[media]",
		},
		"claude session ended",
	);
}

async function buildContent(
	client: TelegramClient,
	message: TelegramMessage,
	cleanText: string | null,
	log: Logger,
): Promise<ContentBlock[]> {
	const content: ContentBlock[] = [];
	const hasPhoto = !!message.photo?.length;
	const hasDocument = !!message.document;

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

	return content;
}

async function buildSingleContent(
	client: TelegramClient,
	message: TelegramMessage,
	log: Logger,
	opts: HandleUpdateOptions,
): Promise<ContentBlock[]> {
	const text = extractText(message);
	const cleanText =
		text != null
			? /^\/cron(\s|@|$)/.test(text)
				? buildCronSkillMessage(
						text.replace(/^\/cron(@\S+)?\s*/, ""),
						extractMessageContext(message),
						opts.promptsDir,
						opts.cronFilePath,
					)
				: stripBotMention(text, opts.botUsername)
			: null;
	return buildContent(client, message, cleanText, log);
}

async function buildGroupContent(
	client: TelegramClient,
	messages: TelegramMessage[],
	log: Logger,
	opts: HandleUpdateOptions,
): Promise<ContentBlock[]> {
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
		if (!caption && msg.caption) {
			caption = stripBotMention(msg.caption, opts.botUsername);
		}
	}

	if (caption) content.push({ type: "text", text: caption });
	return content;
}

async function handleStatsCommand(
	client: TelegramClient,
	conversationId: string,
	message: TelegramMessage,
	opts: HandleUpdateOptions,
): Promise<void> {
	const replyOpts = {
		chat_id: message.chat.id,
		...(message.message_thread_id && {
			message_thread_id: message.message_thread_id,
		}),
		reply_parameters: { message_id: message.message_id },
	};

	const signals = opts.sessionRecorder.compute(conversationId);
	if (!signals) {
		await client.sendMessage({ ...replyOpts, text: "No active session." });
		return;
	}

	await client.sendMessage({
		...replyOpts,
		text: formatStatsMessage(signals),
	});
}

/**
 * Match `/new-claude`, `/new-claude-v2`, `/new-claudev2`, `/new-codex` and underscore
 * variants (with optional `@botname` suffix and trailing whitespace).
 * Telegram's BotFather menu only allows `[a-z0-9_]` so the registered
 * commands use underscores; we accept hyphens too because it's natural to
 * type. No bare `/new` — explicit commands only, since argument parsing was
 * a regular source of confusion ("did the bot read codex or did it default?").
 */
function matchNewBackendCommand(text: string | null): BackendId | null {
	if (!text) return null;
	const m = text.match(/^\/new[-_](claude(?:[-_]?v2)?|codex)(@\S+)?(\s|$)/i);
	if (!m) return null;
	const raw = m[1]?.toLowerCase();
	const backend = raw?.replace(/^claude[-_]?v2$/, "claude-v2");
	return isBackendId(backend ?? "") ? (backend as BackendId) : null;
}

async function handleNewBackendCommand(
	client: TelegramClient,
	conversationId: string,
	message: TelegramMessage,
	backend: BackendId,
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

	// Tear down whichever backend's pool currently holds this conversation.
	for (const id of BACKEND_IDS) {
		opts.backends.pool(id).remove(conversationId);
	}
	opts.sessionStore.deleteSession(conversationId);
	opts.sessionRecorder.delete(conversationId);

	// Drop in-memory session state — the forwarder will end as the proc dies.
	const session = sessions.get(conversationId);
	const droppedQueueDepth = session?.pending.length ?? 0;
	if (session) {
		session.unsubscribeQuiescent();
		sessions.delete(conversationId);
	}
	const droppedSuffix =
		droppedQueueDepth > 0
			? ` Dropped ${droppedQueueDepth} queued message${droppedQueueDepth === 1 ? "" : "s"}.`
			: "";

	opts.pendingBackends.set(conversationId, backend);
	await client.sendMessage({
		...replyOpts,
		text: `Session cleared. Next message will use ${backend}.${droppedSuffix}`,
	});
	log.info(
		{ conversationId, backend, droppedQueueDepth },
		"session cleared via /new-<backend>",
	);
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
 * Process a batch of messages that share a media_group_id. Mirrors
 * processSingleMessage but with grouped content.
 */
async function processMediaGroup(
	client: TelegramClient,
	messages: TelegramMessage[],
	log: Logger,
	opts: HandleUpdateOptions,
): Promise<void> {
	if (messages.length === 0) return;

	const first = messages[0] as TelegramMessage;
	const ctx = extractMessageContext(first);

	if (!isAllowed(ctx, opts.getAccess())) return;

	if (
		opts.respondMode === "mention" &&
		ctx.chatType !== "private" &&
		!messages.some((m) => isBotAddressed(m, opts.botUsername))
	) {
		return;
	}

	const existing = sessions.get(ctx.conversationId);
	if (existing?.proc.alive) {
		await submitToExistingSession(
			client,
			existing,
			{ kind: "group", messages },
			log,
			opts,
		);
		return;
	}

	await startSessionFromGroup(client, messages, log, opts);
}

async function startSessionFromGroup(
	client: TelegramClient,
	messages: TelegramMessage[],
	log: Logger,
	opts: HandleUpdateOptions,
): Promise<void> {
	const t = new RequestTimer();
	t.mark("handler_start");

	const first = messages[0] as TelegramMessage;
	const ctx = extractMessageContext(first);

	const content = await buildGroupContent(client, messages, log, opts);
	if (content.length === 0) return;

	const photoCount = messages.filter((m) => m.photo?.length).length;
	const docCount = messages.filter((m) => m.document).length;
	let caption: string | null = null;
	for (const msg of messages) {
		if (!caption && msg.caption) {
			caption = stripBotMention(msg.caption, opts.botUsername);
			break;
		}
	}
	const inputDescription = describeInput(photoCount > 0, docCount > 0, caption);

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
		"routing media group — starting session",
	);

	t.mark("claude_invoke");

	if (isClaudeBackend(backendId)) {
		try {
			await ensureFreshCliToken(log);
		} catch (err) {
			log.error({ err }, "CLI token warmup failed — proceeding anyway");
		}
	}

	const overrides = buildProcessOverrides(opts, ctx);
	const resumeSessionId = opts.pendingBackends.get(ctx.conversationId)
		? null
		: (existingSession?.sessionId ?? null);

	const proc = pool.getOrCreate(
		ctx.conversationId,
		resumeSessionId,
		t,
		overrides,
	);
	persistSessionId(opts, ctx.conversationId, proc.sessionId, backendId);

	opts.sessionRecorder.start({
		conversationId: ctx.conversationId,
		backend: backendId,
	});
	const dispatchText = describeContentBlocks(content);
	opts.sessionRecorder.recordUserInput(ctx.conversationId, dispatchText);
	log.info(
		{
			conversationId: ctx.conversationId,
			backend: backendId,
			sessionId: existingSession?.sessionId ?? null,
			blocks: content.length,
			textLen: dispatchText.length,
			textPreview: redactedPreview(dispatchText),
			kind: "group",
			firstTurn: true,
		},
		"dispatching to backend CLI",
	);

	const events = firstTurnEvents(
		backendId,
		proc,
		pool,
		ctx.conversationId,
		resumeSessionId,
		overrides,
		content,
		t,
		log,
	);

	const streamingContext: StreamingContext = {
		conversationId: ctx.conversationId,
		backend: backendId,
		chatId: ctx.chatId,
		messageThreadId: first.message_thread_id,
		replyToMessageId: first.message_id,
	};

	const session: ClaudeSession = {
		conversationId: ctx.conversationId,
		backendId,
		proc,
		forwarder: Promise.resolve(),
		streamingContext,
		pending: [],
		submitInFlight: false,
		unsubscribeQuiescent: () => {},
		activeTurn: activeTurnFromMessage(
			ctx,
			first,
			dispatchText,
			inputDescription,
		),
	};
	sessions.set(ctx.conversationId, session);

	const forwarder = streamToTelegram(
		client,
		streamingContext,
		events,
		log,
		t,
		(event) => {
			opts.sessionRecorder.recordEvent(ctx.conversationId, event);
			if (event.type === "turn_complete") {
				const owned = sessions.get(ctx.conversationId);
				if (owned === session) {
					persistSessionId(
						opts,
						ctx.conversationId,
						event.sessionId,
						backendId,
					);
				}
			}
		},
		backendId === "claude-v2"
			? (turn) =>
					handleSessionTurnComplete(ctx, session, turn, backendId, opts, log)
			: undefined,
	)
		.then((result) => {
			t.mark("done");
			const owned = sessions.get(ctx.conversationId);
			if (owned !== session) return result;
			handleSessionResult(
				ctx,
				first,
				inputDescription,
				result,
				backendId,
				t,
				opts,
				log,
			);
			return result;
		})
		.catch((err) => {
			log.error(
				{ err, conversationId: ctx.conversationId },
				"long-running forwarder threw (group)",
			);
			return null;
		})
		.finally(() => {
			const s = sessions.get(ctx.conversationId);
			if (s === session) {
				s.unsubscribeQuiescent();
				sessions.delete(ctx.conversationId);
			}
			opts.sessionRecorder.end(ctx.conversationId);
		});
	session.forwarder = forwarder;
	session.unsubscribeQuiescent = proc.onQuiescent(() => {
		drainPending(client, session, log, opts).catch((err) =>
			log.error(
				{ err, conversationId: ctx.conversationId },
				"drain error (group)",
			),
		);
	});
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

	const binding = resolveBinding(ctx, opts.bindings);
	if (binding?.prompt) {
		systemPrompt =
			systemPrompt !== undefined
				? `${systemPrompt}\n\n${binding.prompt}`
				: binding.prompt;
	}

	const convDirName = conversationIdToDir(ctx.conversationId);
	const conversationHistoryDir = join(opts.conversationLogDir, convDirName);

	const historyNote = `Past conversation history for this channel is stored in: ${conversationHistoryDir}/\nEach file is a JSONL log of a previous session containing input/output pairs. Read them if prior context would help answer the current question.`;
	systemPrompt =
		systemPrompt !== undefined
			? `${systemPrompt}\n\n${historyNote}`
			: historyNote;

	const overrides: Partial<BackendBridgeOptions> = {
		systemPrompt,
		conversationHistoryDir,
	};
	if (binding?.workingDir) overrides.workingDir = binding.workingDir;
	return overrides;
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
