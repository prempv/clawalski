import type { ClaudeStreamEvent } from "./claude-bridge.js";
import { summarizeToolInput } from "./claude-bridge.js";
import type { Logger } from "./logger.js";
import { markdownToTelegramHtml, splitHtml } from "./markdown-telegram.js";
import { redactedPreview } from "./redaction.js";
import type { RequestTimer } from "./request-timer.js";
import type { TelegramClient } from "./telegram-client.js";

export interface StreamingContext {
	conversationId?: string;
	backend?: string;
	chatId: number;
	messageThreadId?: number;
	replyToMessageId?: number;
}

export interface TelegramDeliveryResult {
	messageIds: number[];
	chunks: number;
	failedChunks: number;
	fallbackChunks: number;
}

export interface StreamTurnResult {
	turnIndex: number;
	sessionId: string | null;
	responseText: string;
	toolHistory: string[];
	error: string | null;
	interrupted: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	contextWindow: number | null;
	model: string | null;
	delivery: TelegramDeliveryResult;
}

export interface StreamResult {
	sessionId: string | null;
	responseText: string;
	toolHistory: string[];
	error: string | null;
	interrupted: boolean;
	costUsd: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	contextWindow: number | null;
	model: string | null;
}

const EDIT_INTERVAL_MS = 1500;
const TYPING_INTERVAL_MS = 4000;
const MAX_MESSAGE_LENGTH = 4096;

const STREAM_INTERRUPTED_MARKER =
	"[Stream interrupted — the Claude CLI run ended before completion]";

export async function streamToTelegram(
	client: TelegramClient,
	ctx: StreamingContext,
	events: AsyncIterable<ClaudeStreamEvent>,
	log: Logger,
	timer?: RequestTimer,
	onEvent?: (event: ClaudeStreamEvent) => void,
	onTurnComplete?: (turn: StreamTurnResult) => void | Promise<void>,
): Promise<StreamResult> {
	log.info(
		{
			conversationId: ctx.conversationId,
			backend: ctx.backend,
			chatId: ctx.chatId,
			threadId: ctx.messageThreadId,
			replyToMessageId: ctx.replyToMessageId,
		},
		"stream started",
	);

	// Activity-driven typing: only send a typing indicator while we're seeing
	// recent events from the model. A long-lived forwarder may sit on a
	// quiescent stream for minutes between user inputs — we don't want a
	// constant "typing..." in those gaps.
	const TYPING_STALE_MS = TYPING_INTERVAL_MS * 2;
	let lastEventAt = 0;
	const sendTyping = () =>
		client
			.sendChatAction({
				chat_id: ctx.chatId,
				action: "typing",
				...(ctx.messageThreadId && {
					message_thread_id: ctx.messageThreadId,
				}),
			})
			.catch(() => {});

	await sendTyping();
	lastEventAt = Date.now();
	const typingInterval = setInterval(() => {
		if (Date.now() - lastEventAt < TYPING_STALE_MS) sendTyping();
	}, TYPING_INTERVAL_MS);

	// Per-turn state — reset every time we receive `turn_complete`. Each
	// agent-loop step (including auto-continuations the CLI kicks off after
	// background-task notifications) becomes its own Telegram bubble.
	let messageId: number | null = null;
	let turnText = "";
	let textSegments: string[] = [];
	let currentSegment = "";
	let lastEditText = "";
	let lastEditTime = 0;
	let currentTool = "";
	let turnTools: string[] = [];
	let turnErrorText: string | null = null;
	let afterToolResult = false;
	let turnIndex = 0;

	// Aggregate state — preserved across turns and returned to the handler
	// (for the conversation log + session stats).
	let aggregateText = "";
	const aggregateTools: string[] = [];
	let sessionId: string | null = null;
	let errorText: string | null = null;
	let firstTokenMarked = false;
	let costUsd: number | null = null;
	let inputTokens: number | null = null;
	let outputTokens: number | null = null;
	let contextWindow: number | null = null;
	let model: string | null = null;
	let completed = false;
	let interrupted = false;

	const notifyTurnComplete = async (turn: StreamTurnResult): Promise<void> => {
		try {
			await onTurnComplete?.(turn);
		} catch (err) {
			log.error(
				{ err, conversationId: ctx.conversationId },
				"turn completion observer failed",
			);
		}
	};

	const finalizeTurn = async (
		reason: "turn_complete" | "stream_end",
		turnTokens: {
			inputTokens?: number | null;
			outputTokens?: number | null;
			contextWindow?: number | null;
			sessionId?: string | null;
		} = {},
	): Promise<StreamTurnResult | null> => {
		// Flush whatever is accumulated for this turn into a Telegram bubble.
		// Called on every `turn_complete` and once more after the loop in case
		// the iterator ended without a final turn_complete (codex / process
		// death / interruption).
		if (currentSegment) {
			textSegments.push(currentSegment);
			currentSegment = "";
		}
		if (textSegments.length === 0 && !turnErrorText && !interrupted)
			return null;

		let finalText: string;
		let finalSegments: string[];
		if (turnErrorText) {
			finalText = turnText
				? `${truncate(turnText)}\n\n[Error: ${turnErrorText}]`
				: `Error: ${turnErrorText}`;
			finalSegments = [finalText];
		} else if (interrupted && textSegments.length === 0) {
			finalText = STREAM_INTERRUPTED_MARKER;
			finalSegments = [finalText];
		} else {
			finalText = turnText || "No response from Claude.";
			finalSegments = textSegments;
		}

		const delivery = await sendFinalResponse(
			client,
			ctx,
			messageId,
			finalText,
			finalSegments,
			lastEditText,
			log,
		);
		const completedTurn: StreamTurnResult = {
			turnIndex: ++turnIndex,
			sessionId: turnTokens.sessionId ?? sessionId,
			responseText: turnText || finalText,
			toolHistory: [...turnTools],
			error: turnErrorText,
			interrupted,
			inputTokens: turnTokens.inputTokens ?? null,
			outputTokens: turnTokens.outputTokens ?? null,
			contextWindow: turnTokens.contextWindow ?? contextWindow,
			model,
			delivery,
		};

		log.info(
			{
				conversationId: ctx.conversationId,
				backend: ctx.backend,
				chatId: ctx.chatId,
				threadId: ctx.messageThreadId,
				sessionId: completedTurn.sessionId,
				turnIndex: completedTurn.turnIndex,
				reason,
				responseLen: completedTurn.responseText.length,
				responsePreview: redactedPreview(completedTurn.responseText),
				toolCount: completedTurn.toolHistory.length,
				messageIds: delivery.messageIds,
				failedChunks: delivery.failedChunks,
				fallbackChunks: delivery.fallbackChunks,
				inputTokens: completedTurn.inputTokens,
				outputTokens: completedTurn.outputTokens,
				error: completedTurn.error,
				interrupted: completedTurn.interrupted,
			},
			"stream turn complete",
		);

		// Reset per-turn state so the next continuation gets its own bubble.
		messageId = null;
		turnText = "";
		textSegments = [];
		currentSegment = "";
		lastEditText = "";
		lastEditTime = 0;
		currentTool = "";
		turnTools = [];
		turnErrorText = null;
		afterToolResult = false;
		return completedTurn;
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
							// Close current segment — visual separation is handled
							// by expandable blockquotes in the final HTML render.
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
						const label = detail
							? `${event.toolName}: ${detail}`
							: event.toolName;
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
						// One agent-loop step finished. Finalize the bubble for
						// it and reset; the CLI may auto-continue with another
						// step driven by queued background-task notifications,
						// or — for long-lived conversation forwarders — a new
						// user input may arrive later. Either way the next
						// events feed a fresh bubble.
						completed = true;
						if (event.sessionId) sessionId = event.sessionId;
						if (event.costUsd != null) costUsd = event.costUsd;
						if (event.inputTokens != null) inputTokens = event.inputTokens;
						if (event.outputTokens != null) outputTokens = event.outputTokens;
						if (event.contextWindow != null)
							contextWindow = event.contextWindow;
						{
							const turn = await finalizeTurn("turn_complete", {
								sessionId: event.sessionId ?? sessionId,
								inputTokens: event.inputTokens ?? null,
								outputTokens: event.outputTokens ?? null,
								contextWindow: event.contextWindow ?? null,
							});
							if (turn) await notifyTurnComplete(turn);
						}
						break;
					case "error":
						errorText = event.message;
						turnErrorText = event.message;
						if (event.sessionId) sessionId = event.sessionId;
						break;
					case "session_meta":
						if (event.model) model = event.model;
						break;
					case "thinking_delta":
						break;
				}

				// Throttled send/edit
				const now = Date.now();
				if (shouldUpdate && now - lastEditTime >= EDIT_INTERVAL_MS) {
					const displayText = buildDisplayText(
						turnText,
						currentTool,
						turnTools,
					);
					if (displayText && displayText !== lastEditText) {
						messageId = await sendOrEdit(
							client,
							ctx,
							messageId,
							displayText,
							log,
						);
						lastEditText = displayText;
						lastEditTime = now;
					}
				}
			}
		} catch (err) {
			log.warn(
				{ err },
				"stream iterator threw — marking stream as interrupted",
			);
			interrupted = true;
		}

		if (!completed && !errorText && !interrupted) {
			interrupted = true;
		}

		timer?.mark("stream_complete");

		// Tail finalize — covers iterator-ended-mid-turn (e.g. codex one-shot
		// exit, process death, error). For the normal Claude conversation
		// path every turn is already flushed on `turn_complete`, so this is
		// a no-op there.
		{
			const turn = await finalizeTurn("stream_end", {
				sessionId,
				inputTokens,
				outputTokens,
				contextWindow,
			});
			if (turn) await notifyTurnComplete(turn);
		}

		timer?.mark("response_sent");
	} finally {
		clearInterval(typingInterval);
	}

	log.info(
		{
			chatId: ctx.chatId,
			threadId: ctx.messageThreadId,
			sessionId,
			responseLen: aggregateText.length,
			responsePreview: redactedPreview(aggregateText),
			toolCount: aggregateTools.length,
			interrupted,
			error: errorText,
			inputTokens,
			outputTokens,
		},
		"stream complete",
	);

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
		model,
	};
}

async function sendOrEdit(
	client: TelegramClient,
	ctx: StreamingContext,
	messageId: number | null,
	text: string,
	log: Logger,
): Promise<number> {
	const truncated = truncate(text);

	if (messageId === null) {
		const msg = await client.sendMessage({
			chat_id: ctx.chatId,
			text: truncated,
			...(ctx.messageThreadId && { message_thread_id: ctx.messageThreadId }),
		});
		log.debug(
			{
				conversationId: ctx.conversationId,
				backend: ctx.backend,
				chatId: ctx.chatId,
				threadId: ctx.messageThreadId,
				messageId: msg.message_id,
				textLen: truncated.length,
			},
			"telegram interim message sent",
		);
		return msg.message_id;
	}

	await tryEdit(client, ctx, messageId, truncated, log);
	return messageId;
}

function buildDisplayText(
	text: string,
	currentTool: string,
	toolHistory: string[],
): string {
	if (!text && !currentTool && toolHistory.length === 0) return "";

	// If no text yet, show tool activity log
	if (!text) {
		const lines = toolHistory.map((t) => `> ${t}`);
		if (currentTool) {
			lines[lines.length - 1] = `> ${currentTool} ...`;
		}
		return truncate(lines.join("\n"));
	}

	// Text exists — show it, with current tool as a status footer
	let display = truncate(text);
	if (currentTool) {
		const footer = `\n\n> ${currentTool} ...`;
		display = truncate(text, MAX_MESSAGE_LENGTH - footer.length) + footer;
	}
	return display;
}

function truncate(text: string, limit = MAX_MESSAGE_LENGTH): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit - 4)}...`;
}

async function trySendHtml(
	client: TelegramClient,
	ctx: StreamingContext,
	html: string,
	log: Logger,
): Promise<number | null> {
	try {
		const msg = await client.sendMessage({
			chat_id: ctx.chatId,
			text: html,
			parse_mode: "HTML",
			...(ctx.messageThreadId && { message_thread_id: ctx.messageThreadId }),
		});
		return msg.message_id;
	} catch (err) {
		log.warn({ err }, "HTML send failed, falling back to plain text");
		return null;
	}
}

async function tryEditHtml(
	client: TelegramClient,
	ctx: StreamingContext,
	messageId: number,
	html: string,
	log: Logger,
): Promise<boolean> {
	try {
		await client.editMessageText({
			chat_id: ctx.chatId,
			message_id: messageId,
			text: html,
			parse_mode: "HTML",
		});
		return true;
	} catch (err) {
		const msg = String(err);
		if (msg.includes("message is not modified")) return true;
		log.warn({ err }, "HTML edit failed, falling back to plain text");
		return false;
	}
}

async function tryEdit(
	client: TelegramClient,
	ctx: StreamingContext,
	messageId: number,
	text: string,
	log: Logger,
): Promise<boolean> {
	try {
		await client.editMessageText({
			chat_id: ctx.chatId,
			message_id: messageId,
			text: truncate(text),
		});
		log.debug(
			{
				conversationId: ctx.conversationId,
				backend: ctx.backend,
				chatId: ctx.chatId,
				threadId: ctx.messageThreadId,
				messageId,
				textLen: text.length,
			},
			"telegram interim message edited",
		);
		return true;
	} catch (err) {
		const msg = String(err);
		if (!msg.includes("message is not modified")) {
			log.debug({ err }, "edit message failed");
		}
		return msg.includes("message is not modified");
	}
}

async function sendFinalResponse(
	client: TelegramClient,
	ctx: StreamingContext,
	messageId: number | null,
	plainText: string,
	segments: string[],
	lastEditText: string,
	log: Logger,
): Promise<TelegramDeliveryResult> {
	const delivery: TelegramDeliveryResult = {
		messageIds: [],
		chunks: 0,
		failedChunks: 0,
		fallbackChunks: 0,
	};
	// Build HTML with intermediate segments in expandable blockquotes
	const html = buildFinalHtml(segments);
	const chunks = splitHtml(html);

	// Send first chunk: edit existing message or send new
	const firstChunk = chunks[0];
	if (firstChunk) {
		delivery.chunks += 1;
		if (messageId !== null) {
			const edited = await tryEditHtml(client, ctx, messageId, firstChunk, log);
			if (!edited) {
				delivery.fallbackChunks += 1;
				if (await tryEdit(client, ctx, messageId, truncate(plainText), log)) {
					delivery.messageIds.push(messageId);
				} else {
					delivery.failedChunks += 1;
				}
			} else {
				delivery.messageIds.push(messageId);
			}
		} else {
			const sent = await trySendHtml(client, ctx, firstChunk, log);
			if (sent) {
				delivery.messageIds.push(sent);
			} else {
				delivery.fallbackChunks += 1;
				const plainSent = await trySendPlain(
					client,
					ctx,
					truncate(plainText),
					log,
				);
				if (plainSent) {
					delivery.messageIds.push(plainSent);
				} else {
					delivery.failedChunks += 1;
				}
			}
		}
	}

	// Send remaining chunks as new messages
	for (let i = 1; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) continue;
		delivery.chunks += 1;
		const sent = await trySendHtml(client, ctx, chunk, log);
		if (sent) {
			delivery.messageIds.push(sent);
		} else {
			delivery.fallbackChunks += 1;
			const plainChunks = splitText(plainText, MAX_MESSAGE_LENGTH);
			const plainChunk = plainChunks[i];
			if (plainChunk) {
				const plainSent = await trySendPlain(client, ctx, plainChunk, log);
				if (plainSent) {
					delivery.messageIds.push(plainSent);
				} else {
					delivery.failedChunks += 1;
				}
			} else {
				delivery.failedChunks += 1;
			}
		}
	}
	return delivery;
}

async function trySendPlain(
	client: TelegramClient,
	ctx: StreamingContext,
	text: string,
	log: Logger,
): Promise<number | null> {
	try {
		const msg = await client.sendMessage({
			chat_id: ctx.chatId,
			text,
			...(ctx.messageThreadId && { message_thread_id: ctx.messageThreadId }),
		});
		return msg.message_id;
	} catch (err) {
		log.warn({ err }, "plain text send failed");
		return null;
	}
}

/**
 * Build final HTML from text segments.
 * If there are multiple segments, all intermediate ones are joined and
 * wrapped in a single expandable blockquote (collapsible in Telegram).
 * The last segment is the primary response shown prominently.
 */
function buildFinalHtml(segments: string[]): string {
	if (segments.length === 0)
		return markdownToTelegramHtml("No response from Claude.");

	if (segments.length === 1) {
		return markdownToTelegramHtml(segments[0] as string);
	}

	// Join all intermediate segments into one collapsed block
	const intermediate = segments
		.slice(0, -1)
		.map((s) => s.trim())
		.filter(Boolean)
		.join(" ; ");
	const intermediateHtml = markdownToTelegramHtml(intermediate);

	// Final segment rendered normally
	const finalHtml = markdownToTelegramHtml(
		segments[segments.length - 1] as string,
	);

	return `<blockquote expandable>${intermediateHtml}</blockquote>\n\n${finalHtml}`;
}

/**
 * Drain a Claude event stream without sending to Telegram.
 * Collects the full response for logging.
 */
export async function consumeEvents(
	events: AsyncIterable<ClaudeStreamEvent>,
	timer?: RequestTimer,
	onEvent?: (event: ClaudeStreamEvent) => void,
): Promise<StreamResult> {
	let accumulatedText = "";
	const toolHistory: string[] = [];
	let sessionId: string | null = null;
	let errorText: string | null = null;
	let firstTokenMarked = false;
	let costUsd: number | null = null;
	let inputTokens: number | null = null;
	let outputTokens: number | null = null;
	let contextWindow: number | null = null;
	let model: string | null = null;
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
					const label = detail
						? `${event.toolName}: ${detail}`
						: event.toolName;
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

	if (!completed && !errorText && !interrupted) {
		interrupted = true;
	}

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
		model,
	};
}

function splitText(text: string, maxLen: number): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLen) {
			chunks.push(remaining);
			break;
		}

		let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
		if (splitIdx < maxLen / 2) {
			splitIdx = remaining.lastIndexOf("\n", maxLen);
		}
		if (splitIdx < maxLen / 2) {
			splitIdx = maxLen;
		}

		chunks.push(remaining.slice(0, splitIdx));
		remaining = remaining.slice(splitIdx).replace(/^\n+/, "");
	}

	return chunks;
}
