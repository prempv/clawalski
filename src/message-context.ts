import type { TelegramMessage } from "./types.js";

export interface MessageContext {
	conversationId: string;
	chatType: "private" | "group" | "supergroup" | "channel";
	chatId: number;
	chatTitle: string | null;
	senderId: number | null;
	senderName: string;
	senderUsername: string | null;
	threadId: number | null;
	isForum: boolean;
}

export function buildConversationId(params: {
	chatType: MessageContext["chatType"];
	chatId: number;
	senderId: number | null;
	threadId: number | null;
	isForum: boolean;
}): string {
	if (params.chatType === "private") {
		return `tg:dm:${params.senderId ?? params.chatId}`;
	}

	const base = `tg:group:${params.chatId}`;

	if (params.isForum && params.threadId != null) {
		return `${base}:topic:${params.threadId}`;
	}

	return base;
}

export function extractMessageContext(
	message: TelegramMessage,
): MessageContext {
	const chat = message.chat;
	const from = message.from;

	const isGroup = chat.type === "group" || chat.type === "supergroup";
	const isForum =
		chat.type === "supergroup" &&
		chat.is_forum === true &&
		message.message_thread_id != null;

	const threadId = isForum ? (message.message_thread_id ?? null) : null;

	const senderId = from?.id ?? null;
	const senderUsername = from?.username ?? null;
	const senderName = from?.username ?? from?.first_name ?? "unknown";

	const chatTitle = isGroup ? (chat.title ?? null) : null;

	const conversationId = buildConversationId({
		chatType: chat.type,
		chatId: chat.id,
		senderId,
		threadId,
		isForum,
	});

	return {
		conversationId,
		chatType: chat.type,
		chatId: chat.id,
		chatTitle,
		senderId,
		senderName,
		senderUsername,
		threadId,
		isForum,
	};
}

export function formatEchoResponse(
	ctx: MessageContext,
	originalText: string,
): string {
	const lines: string[] = [`[${ctx.conversationId}]`];

	// From line
	const fromParts = [ctx.senderName];
	if (ctx.senderUsername) {
		fromParts[0] = `${ctx.senderName} (@${ctx.senderUsername})`;
	}
	lines.push(`From: ${fromParts[0]}`);

	// Context line
	lines.push(`Context: ${describeContext(ctx)}`);

	// Blank line + original message
	lines.push("", originalText);

	return lines.join("\n");
}

function describeContext(ctx: MessageContext): string {
	if (ctx.chatType === "private") {
		return "DM";
	}

	if (ctx.isForum && ctx.threadId != null) {
		const chatName = ctx.chatTitle ? ` in "${ctx.chatTitle}"` : "";
		return `Forum topic${chatName} (topic ${ctx.threadId})`;
	}

	if (ctx.chatTitle) {
		return `Group "${ctx.chatTitle}"`;
	}

	return "Group";
}
