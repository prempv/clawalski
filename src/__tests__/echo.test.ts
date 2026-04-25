import { describe, expect, it, vi } from "vitest";
import type { HandleUpdateOptions } from "../echo.js";
import { handleUpdate } from "../echo.js";
import type { TelegramClient } from "../telegram-client.js";
import type { TelegramMessage, TelegramUpdate } from "../types.js";

function mockClient() {
	return { sendMessage: vi.fn() } as unknown as TelegramClient;
}

function mockLogger() {
	return {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};
}

const openAccess = {
	dmPolicy: "open" as const,
	groupPolicy: "open" as const,
	allowedUsers: new Set<number>(),
	allowedGroups: new Set<number>(),
	allowAllUsers: false,
	allowAllGroups: false,
	adminChatId: null,
	dmDefaultBackend: null,
	groupDefaultBackend: null,
};

const defaultOpts: HandleUpdateOptions = {
	respondMode: "all",
	botUsername: "TestBot",
	getAccess: () => openAccess,
};

function makeDmUpdate(text: string, chatId = 123): TelegramUpdate {
	return {
		update_id: 1,
		message: {
			message_id: 1,
			date: Date.now(),
			chat: { id: chatId, type: "private" },
			from: { id: 1, is_bot: false, first_name: "Test", username: "tester" },
			text,
		},
	};
}

function makeGroupUpdate(
	text: string,
	overrides?: Partial<TelegramMessage>,
): TelegramUpdate {
	return {
		update_id: 1,
		message: {
			message_id: 1,
			date: Date.now(),
			chat: { id: -200, type: "group", title: "Test Group" },
			from: { id: 1, is_bot: false, first_name: "Test", username: "tester" },
			text,
			...overrides,
		},
	};
}

function makeForumUpdate(text: string, threadId: number): TelegramUpdate {
	return {
		update_id: 1,
		message: {
			message_id: 1,
			date: Date.now(),
			chat: {
				id: -100200300,
				type: "supergroup",
				title: "Dev Chat",
				is_forum: true,
			},
			from: { id: 1, is_bot: false, first_name: "Test", username: "tester" },
			text,
			message_thread_id: threadId,
		},
	};
}

describe("handleUpdate", () => {
	it("echoes DM with conversation ID", async () => {
		const client = mockClient();
		await handleUpdate(
			client,
			makeDmUpdate("hello"),
			mockLogger() as never,
			defaultOpts,
		);

		expect(client.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				chat_id: 123,
				text: expect.stringContaining("[tg:dm:1]"),
			}),
		);
		expect(client.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("hello"),
			}),
		);
	});

	it("echoes group message with group conversation ID", async () => {
		const client = mockClient();
		await handleUpdate(
			client,
			makeGroupUpdate("hey"),
			mockLogger() as never,
			defaultOpts,
		);

		expect(client.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				chat_id: -200,
				text: expect.stringContaining("[tg:group:-200]"),
			}),
		);
		expect(client.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining('Group "Test Group"'),
			}),
		);
	});

	it("echoes forum topic with topic ID in conversation ID", async () => {
		const client = mockClient();
		await handleUpdate(
			client,
			makeForumUpdate("topic msg", 42),
			mockLogger() as never,
			defaultOpts,
		);

		expect(client.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				chat_id: -100200300,
				text: expect.stringContaining("[tg:group:-100200300:topic:42]"),
				message_thread_id: 42,
			}),
		);
	});

	it("skips updates with no message", async () => {
		const client = mockClient();
		await handleUpdate(
			client,
			{ update_id: 1 },
			mockLogger() as never,
			defaultOpts,
		);
		expect(client.sendMessage).not.toHaveBeenCalled();
	});

	it("echoes edited messages", async () => {
		const client = mockClient();
		const update: TelegramUpdate = {
			update_id: 2,
			edited_message: {
				message_id: 1,
				date: Date.now(),
				chat: { id: 456, type: "private" },
				from: { id: 1, is_bot: false, first_name: "Test" },
				text: "edited",
			},
		};

		await handleUpdate(client, update, mockLogger() as never, defaultOpts);
		expect(client.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				chat_id: 456,
				text: expect.stringContaining("edited"),
			}),
		);
	});

	it("handles photo messages", async () => {
		const client = mockClient();
		const update: TelegramUpdate = {
			update_id: 3,
			message: {
				message_id: 1,
				date: Date.now(),
				chat: { id: 789, type: "private" },
				from: { id: 1, is_bot: false, first_name: "Test" },
				photo: [
					{
						file_id: "abc",
						file_unique_id: "abc1",
						width: 100,
						height: 100,
					},
				],
			},
		};

		await handleUpdate(client, update, mockLogger() as never, defaultOpts);
		expect(client.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("[photo received]"),
			}),
		);
	});
});

describe("handleUpdate — mention mode", () => {
	const mentionOpts: HandleUpdateOptions = {
		respondMode: "mention",
		botUsername: "TestBot",
		getAccess: () => openAccess,
	};

	it("always responds to DMs regardless of mode", async () => {
		const client = mockClient();
		await handleUpdate(
			client,
			makeDmUpdate("hello"),
			mockLogger() as never,
			mentionOpts,
		);
		expect(client.sendMessage).toHaveBeenCalled();
	});

	it("skips group messages without mention", async () => {
		const client = mockClient();
		await handleUpdate(
			client,
			makeGroupUpdate("hello"),
			mockLogger() as never,
			mentionOpts,
		);
		expect(client.sendMessage).not.toHaveBeenCalled();
	});

	it("responds to group messages with @mention", async () => {
		const client = mockClient();
		await handleUpdate(
			client,
			makeGroupUpdate("hey @TestBot"),
			mockLogger() as never,
			mentionOpts,
		);
		expect(client.sendMessage).toHaveBeenCalled();
	});

	it("responds when replied to the bot", async () => {
		const client = mockClient();
		await handleUpdate(
			client,
			makeGroupUpdate("reply", {
				reply_to_message: {
					message_id: 0,
					date: Date.now(),
					chat: { id: -200, type: "group" },
					from: {
						id: 99,
						is_bot: true,
						first_name: "Bot",
						username: "TestBot",
					},
				},
			}),
			mockLogger() as never,
			mentionOpts,
		);
		expect(client.sendMessage).toHaveBeenCalled();
	});
});

describe("handleUpdate — access control", () => {
	it("silently ignores denied users", async () => {
		const client = mockClient();
		const deniedOpts: HandleUpdateOptions = {
			respondMode: "all",
			botUsername: "TestBot",
			getAccess: () => ({
				dmPolicy: "allowlist",
				groupPolicy: "allowlist",
				allowedUsers: new Set([999]),
				allowedGroups: new Set(),
				allowAllUsers: false,
				allowAllGroups: false,
				adminChatId: null,
				dmDefaultBackend: null,
				groupDefaultBackend: null,
			}),
		};
		await handleUpdate(
			client,
			makeDmUpdate("hello"),
			mockLogger() as never,
			deniedOpts,
		);
		expect(client.sendMessage).not.toHaveBeenCalled();
	});
});
