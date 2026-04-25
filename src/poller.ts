import type { HandleUpdateOptions } from "./claude-handler.js";
import { handleUpdate } from "./claude-handler.js";
import type { Logger } from "./logger.js";
import { RequestTimer } from "./request-timer.js";
import type { TelegramClient } from "./telegram-client.js";

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
