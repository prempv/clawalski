import { describe, expect, it, vi } from "vitest";
import type { BackendStreamEvent } from "../backend.js";
import { streamToTelegram } from "../streaming.js";
import type { TelegramClient } from "../telegram-client.js";

function mockLogger() {
	return {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};
}

async function* events(items: BackendStreamEvent[]) {
	for (const item of items) yield item;
}

describe("streamToTelegram", () => {
	it("reports per-turn completion with Telegram delivery ids", async () => {
		let nextMessageId = 10;
		const client = {
			sendMessage: vi.fn().mockImplementation(async () => ({
				message_id: nextMessageId++,
			})),
			editMessageText: vi.fn().mockResolvedValue({ message_id: 10 }),
			sendChatAction: vi.fn().mockResolvedValue(undefined),
		} as unknown as TelegramClient;
		const onTurnComplete = vi.fn();

		await streamToTelegram(
			client,
			{ conversationId: "tg:dm:1", backend: "claude-v2", chatId: 123 },
			events([
				{ type: "text_delta", content: "hello" },
				{ type: "turn_complete", sessionId: "session-1", outputTokens: 2 },
			]),
			mockLogger() as never,
			undefined,
			undefined,
			onTurnComplete,
		);

		expect(onTurnComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session-1",
				responseText: "hello",
				outputTokens: 2,
				delivery: expect.objectContaining({
					messageIds: [10],
					failedChunks: 0,
				}),
			}),
		);
	});
});
