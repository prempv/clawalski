import type { AccessConfig } from "./access.js";
import {
	formatAdminNotification,
	isAllowed,
	shouldNotifyAdmin,
} from "./access.js";
import type { Logger } from "./logger.js";
import {
	extractMessageContext,
	formatEchoResponse,
} from "./message-context.js";
import type { TelegramClient } from "./telegram-client.js";
import type { TelegramMessage, TelegramUpdate } from "./types.js";

export interface HandleUpdateOptions {
	respondMode: "all" | "mention";
	botUsername: string;
	getAccess: () => AccessConfig;
}

export async function handleUpdate(
	client: TelegramClient,
	update: TelegramUpdate,
	log: Logger,
	opts: HandleUpdateOptions,
): Promise<void> {
	const message = update.message ?? update.edited_message;
	if (!message) return;

	const ctx = extractMessageContext(message);

	// Access control gate — silently ignore unauthorized senders
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

	// In mention mode, skip group messages unless the bot is mentioned or replied to
	if (
		opts.respondMode === "mention" &&
		ctx.chatType !== "private" &&
		!isBotAddressed(message, opts.botUsername)
	) {
		return;
	}

	const originalText = extractText(message);
	if (!originalText) return;

	const echoText = formatEchoResponse(ctx, originalText);

	log.info(
		{
			conversationId: ctx.conversationId,
			chatType: ctx.chatType,
			sender: ctx.senderName,
		},
		"echoing message",
	);

	await client.sendMessage({
		chat_id: ctx.chatId,
		text: echoText,
		...(message.message_thread_id && {
			message_thread_id: message.message_thread_id,
		}),
	});
}

function isBotAddressed(
	message: TelegramMessage,
	botUsername: string,
): boolean {
	const lower = botUsername.toLowerCase();

	// Check if the message text mentions the bot
	if (message.text?.toLowerCase().includes(`@${lower}`)) {
		return true;
	}

	// Check if the message is a reply to the bot
	if (message.reply_to_message?.from?.username?.toLowerCase() === lower) {
		return true;
	}

	return false;
}

function extractText(
	message: NonNullable<TelegramUpdate["message"]>,
): string | null {
	if (message.text) return message.text;
	if (message.caption) return `[media] ${message.caption}`;
	if (message.sticker?.emoji) return message.sticker.emoji;
	if (message.photo) return "[photo received]";
	if (message.video) return "[video received]";
	if (message.document) return "[document received]";
	if (message.audio) return "[audio received]";
	if (message.voice) return "[voice received]";
	return null;
}
