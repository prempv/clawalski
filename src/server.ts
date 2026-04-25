import { Hono } from "hono";
import type { HandleUpdateOptions } from "./claude-handler.js";
import { handleUpdate } from "./claude-handler.js";
import type { Logger } from "./logger.js";
import { RequestTimer } from "./request-timer.js";
import type { TelegramClient } from "./telegram-client.js";
import type { TelegramUpdate } from "./types.js";

interface ServerOptions {
	client: TelegramClient;
	log: Logger;
	webhookSecret?: string;
	webhookPath: string;
	startedAt: number;
	handlerOpts: HandleUpdateOptions;
}

export function createApp(opts: ServerOptions): Hono {
	const { client, log, webhookSecret, webhookPath, startedAt, handlerOpts } =
		opts;
	const app = new Hono();

	// Health check
	app.get("/healthz", (c) =>
		c.json({
			status: "ok",
			uptime: Math.floor((Date.now() - startedAt) / 1000),
		}),
	);

	// Readiness — verifies bot token is still valid
	app.get("/readyz", async (c) => {
		try {
			await client.getMe();
			return c.json({ status: "ready" });
		} catch {
			return c.json({ status: "not ready" }, 503);
		}
	});

	// Telegram webhook endpoint
	app.post(webhookPath, async (c) => {
		if (webhookSecret) {
			const headerSecret = c.req.header("x-telegram-bot-api-secret-token");
			if (headerSecret !== webhookSecret) {
				return c.json({ error: "unauthorized" }, 401);
			}
		}

		const timer = new RequestTimer();
		timer.mark("message_received");
		const update = (await c.req.json()) as TelegramUpdate;

		handleUpdate(client, update, log, handlerOpts, timer).catch((err) => {
			log.error({ err }, "webhook handler error");
		});

		return c.json({ ok: true });
	});

	return app;
}
