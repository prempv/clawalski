import type { HandleUpdateOptions } from "./claude-handler.js";
import { handleUpdate } from "./claude-handler.js";
import type { Logger } from "./logger.js";
import { RequestTimer } from "./request-timer.js";
import type { TelegramClient } from "./telegram-client.js";
import type { TelegramUpdate } from "./types.js";

const TEXT_PREVIEW_MAX = 200;

function summarizeUpdate(update: TelegramUpdate): Record<string, unknown> {
	const kind = update.message
		? "message"
		: update.edited_message
			? "edited_message"
			: update.callback_query
				? "callback_query"
				: "other";
	const msg = update.message ?? update.edited_message;
	if (!msg) {
		return { updateId: update.update_id, kind };
	}
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
		replyToMessageId: msg.reply_to_message?.message_id,
	};
}

export async function startPolling(
	client: TelegramClient,
	log: Logger,
	signal: AbortSignal,
	opts: HandleUpdateOptions,
): Promise<void> {
	let offset: number | undefined;
	const pollLog = log.child({ component: "poller" });

	pollLog.info("starting long-poll loop");

	while (!signal.aborted) {
		try {
			const updates = await client.getUpdates(offset, 30);

			for (const update of updates) {
				offset = update.update_id + 1;
				pollLog.info(summarizeUpdate(update), "telegram update received");
				const timer = new RequestTimer();
				timer.mark("message_received");
				handleUpdate(client, update, log, opts, timer).catch((err) => {
					pollLog.error(
						{ err, updateId: update.update_id },
						"error handling update",
					);
				});
			}
		} catch (err) {
			if (signal.aborted) break;
			pollLog.error({ err }, "getUpdates failed, retrying in 3s");
			await sleep(3000);
		}
	}

	pollLog.info("stopped");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
