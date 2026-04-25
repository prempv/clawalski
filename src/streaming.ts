import type { ClaudeStreamEvent } from "./claude-bridge.js";
import { summarizeToolInput } from "./claude-bridge.js";
import type { Logger } from "./logger.js";
import { markdownToTelegramHtml, splitHtml } from "./markdown-telegram.js";
import type { RequestTimer } from "./request-timer.js";
import type { TelegramClient } from "./telegram-client.js";

export interface StreamingContext {
	chatId: number;
	messageThreadId?: number;
	replyToMessageId?: number;
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
): Promise<StreamResult> {
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
	const typingInterval = setInterval(sendTyping, TYPING_INTERVAL_MS);

	let messageId: number | null = null;
	let accumulatedText = "";
	const textSegments: string[] = [];
	let currentSegment = "";
	let lastEditText = "";
	let lastEditTime = 0;
	let currentTool = "";
	const toolHistory: string[] = [];
	let sessionId: string | null = null;
	let errorText: string | null = null;
	let firstTokenMarked = false;
	let afterToolResult = false;
	let costUsd: number | null = null;
	let inputTokens: number | null = null;
	let outputTokens: number | null = null;
	let contextWindow: number | null = null;
	let model: string | null = null;
	let completed = false;
	let interrupted = false;

	try {
		try {
			for await (const event of events) {
				let shouldUpdate = false;

				switch (event.type) {
					case "text_delta":
						if (!firstTokenMarked) {
							firstTokenMarked = true;
							timer?.mark("first_token");
						}
						if (afterToolResult && accumulatedText.length > 0) {
							// Close current segment — visual separation is handled
							// by expandable blockquotes in the final HTML render.
							textSegments.push(currentSegment);
							currentSegment = "";
							afterToolResult = false;
						}
						currentSegment += event.content;
						accumulatedText += event.content;
						shouldUpdate = true;
						break;
					case "tool_use": {
						const detail = summarizeToolInput(event.toolName, event.input);
						const label = detail
							? `${event.toolName}: ${detail}`
							: event.toolName;
						currentTool = label;
						toolHistory.push(label);
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
						if (event.contextWindow != null)
							contextWindow = event.contextWindow;
						break;
					case "error":
						errorText = event.message;
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
						accumulatedText,
						currentTool,
						toolHistory,
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

		// Finalize the last segment
		if (currentSegment) {
			textSegments.push(currentSegment);
		}

		// Final response
		let finalText: string;
		if (errorText) {
			finalText = accumulatedText
				? `${truncate(accumulatedText)}\n\n[Error: ${errorText}]`
				: `Error: ${errorText}`;
		} else if (interrupted) {
			finalText = accumulatedText
				? `${truncate(accumulatedText)}\n\n${STREAM_INTERRUPTED_MARKER}`
				: STREAM_INTERRUPTED_MARKER;
		} else {
			finalText = accumulatedText || "No response from Claude.";
		}

		const finalSegments = errorText || interrupted ? [finalText] : textSegments;

		await sendFinalResponse(
			client,
			ctx,
			messageId,
			finalText,
			finalSegments,
			lastEditText,
			log,
		);

		timer?.mark("response_sent");
	} finally {
		clearInterval(typingInterval);
	}

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
		return msg.message_id;
	}

	await tryEdit(client, ctx.chatId, messageId, truncated, log);
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
): Promise<boolean> {
	try {
		await client.sendMessage({
			chat_id: ctx.chatId,
			text: html,
			parse_mode: "HTML",
			...(ctx.messageThreadId && { message_thread_id: ctx.messageThreadId }),
		});
		return true;
	} catch (err) {
		log.warn({ err }, "HTML send failed, falling back to plain text");
		return false;
	}
}

async function tryEditHtml(
	client: TelegramClient,
	chatId: number,
	messageId: number,
	html: string,
	log: Logger,
): Promise<boolean> {
	try {
		await client.editMessageText({
			chat_id: chatId,
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
	chatId: number,
	messageId: number,
	text: string,
	log: Logger,
): Promise<void> {
	try {
		await client.editMessageText({
			chat_id: chatId,
			message_id: messageId,
			text: truncate(text),
		});
	} catch (err) {
		const msg = String(err);
		if (!msg.includes("message is not modified")) {
			log.debug({ err }, "edit message failed");
		}
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
): Promise<void> {
	// Build HTML with intermediate segments in expandable blockquotes
	const html = buildFinalHtml(segments);
	const chunks = splitHtml(html);

	// Send first chunk: edit existing message or send new
	const firstChunk = chunks[0];
	if (firstChunk) {
		if (messageId !== null) {
			const edited = await tryEditHtml(
				client,
				ctx.chatId,
				messageId,
				firstChunk,
				log,
			);
			if (!edited) {
				await tryEdit(client, ctx.chatId, messageId, truncate(plainText), log);
			}
		} else {
			const sent = await trySendHtml(client, ctx, firstChunk, log);
			if (!sent) {
				await trySendPlain(client, ctx, truncate(plainText), log);
			}
		}
	}

	// Send remaining chunks as new messages
	for (let i = 1; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) continue;
		const sent = await trySendHtml(client, ctx, chunk, log);
		if (!sent) {
			const plainChunks = splitText(plainText, MAX_MESSAGE_LENGTH);
			const plainChunk = plainChunks[i];
			if (plainChunk) {
				await trySendPlain(client, ctx, plainChunk, log);
			}
		}
	}
}

async function trySendPlain(
	client: TelegramClient,
	ctx: StreamingContext,
	text: string,
	log: Logger,
): Promise<void> {
	try {
		await client.sendMessage({
			chat_id: ctx.chatId,
			text,
			...(ctx.messageThreadId && { message_thread_id: ctx.messageThreadId }),
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
