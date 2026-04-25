import { describe, expect, it } from "vitest";
import {
	buildConversationId,
	extractMessageContext,
	formatEchoResponse,
} from "../message-context.js";
import type { TelegramMessage } from "../types.js";

function makeMessage(
	overrides: Partial<TelegramMessage> & { chat: TelegramMessage["chat"] },
): TelegramMessage {
	return {
		message_id: 1,
		date: Date.now(),
		from: { id: 100, is_bot: false, first_name: "Alice", username: "alice" },
		...overrides,
	};
}

describe("buildConversationId", () => {
	it("DM with sender ID", () => {
		expect(
			buildConversationId({
				chatType: "private",
				chatId: 999,
				senderId: 100,
				threadId: null,
				isForum: false,
			}),
		).toBe("tg:dm:100");
	});

	it("DM without sender ID falls back to chatId", () => {
		expect(
			buildConversationId({
				chatType: "private",
				chatId: 999,
				senderId: null,
				threadId: null,
				isForum: false,
			}),
		).toBe("tg:dm:999");
	});

	it("regular group", () => {
		expect(
			buildConversationId({
				chatType: "group",
				chatId: -200,
				senderId: 100,
				threadId: null,
				isForum: false,
			}),
		).toBe("tg:group:-200");
	});

	it("supergroup non-forum", () => {
		expect(
			buildConversationId({
				chatType: "supergroup",
				chatId: -100200300,
				senderId: 100,
				threadId: null,
				isForum: false,
			}),
		).toBe("tg:group:-100200300");
	});

	it("forum topic", () => {
		expect(
			buildConversationId({
				chatType: "supergroup",
				chatId: -100200300,
				senderId: 100,
				threadId: 42,
				isForum: true,
			}),
		).toBe("tg:group:-100200300:topic:42");
	});

	it("forum without threadId omits topic suffix", () => {
		expect(
			buildConversationId({
				chatType: "supergroup",
				chatId: -100200300,
				senderId: 100,
				threadId: null,
				isForum: true,
			}),
		).toBe("tg:group:-100200300");
	});
});

describe("extractMessageContext", () => {
	it("private chat", () => {
		const ctx = extractMessageContext(
			makeMessage({ chat: { id: 100, type: "private", first_name: "Alice" } }),
		);
		expect(ctx.chatType).toBe("private");
		expect(ctx.isForum).toBe(false);
		expect(ctx.threadId).toBeNull();
		expect(ctx.conversationId).toBe("tg:dm:100");
		expect(ctx.senderUsername).toBe("alice");
	});

	it("group message", () => {
		const ctx = extractMessageContext(
			makeMessage({
				chat: { id: -200, type: "group", title: "Friends" },
			}),
		);
		expect(ctx.chatType).toBe("group");
		expect(ctx.chatTitle).toBe("Friends");
		expect(ctx.conversationId).toBe("tg:group:-200");
	});

	it("forum supergroup with thread", () => {
		const ctx = extractMessageContext(
			makeMessage({
				chat: {
					id: -100200300,
					type: "supergroup",
					title: "Dev Chat",
					is_forum: true,
				},
				message_thread_id: 42,
			}),
		);
		expect(ctx.isForum).toBe(true);
		expect(ctx.threadId).toBe(42);
		expect(ctx.conversationId).toBe("tg:group:-100200300:topic:42");
	});

	it("non-forum supergroup with message_thread_id ignores thread", () => {
		const ctx = extractMessageContext(
			makeMessage({
				chat: { id: -100200300, type: "supergroup", title: "General" },
				message_thread_id: 99,
			}),
		);
		expect(ctx.isForum).toBe(false);
		expect(ctx.threadId).toBeNull();
		expect(ctx.conversationId).toBe("tg:group:-100200300");
	});

	it("missing from field", () => {
		const ctx = extractMessageContext({
			message_id: 1,
			date: Date.now(),
			chat: { id: 100, type: "private" },
		});
		expect(ctx.senderId).toBeNull();
		expect(ctx.senderName).toBe("unknown");
		expect(ctx.senderUsername).toBeNull();
	});
});

describe("formatEchoResponse", () => {
	it("DM format", () => {
		const result = formatEchoResponse(
			{
				conversationId: "tg:dm:100",
				chatType: "private",
				chatId: 100,
				chatTitle: null,
				senderId: 100,
				senderName: "alice",
				senderUsername: "alice",
				threadId: null,
				isForum: false,
			},
			"hello",
		);
		expect(result).toBe(
			"[tg:dm:100]\nFrom: alice (@alice)\nContext: DM\n\nhello",
		);
	});

	it("group format", () => {
		const result = formatEchoResponse(
			{
				conversationId: "tg:group:-200",
				chatType: "group",
				chatId: -200,
				chatTitle: "Friends",
				senderId: 100,
				senderName: "bob",
				senderUsername: "bob",
				threadId: null,
				isForum: false,
			},
			"hey",
		);
		expect(result).toContain("[tg:group:-200]");
		expect(result).toContain('Group "Friends"');
		expect(result).toContain("hey");
	});

	it("forum topic format", () => {
		const result = formatEchoResponse(
			{
				conversationId: "tg:group:-100123:topic:42",
				chatType: "supergroup",
				chatId: -100123,
				chatTitle: "Dev Chat",
				senderId: 100,
				senderName: "charlie",
				senderUsername: "charlie",
				threadId: 42,
				isForum: true,
			},
			"world",
		);
		expect(result).toContain("[tg:group:-100123:topic:42]");
		expect(result).toContain('Forum topic in "Dev Chat" (topic 42)');
		expect(result).toContain("world");
	});

	it("sender without username", () => {
		const result = formatEchoResponse(
			{
				conversationId: "tg:dm:100",
				chatType: "private",
				chatId: 100,
				chatTitle: null,
				senderId: 100,
				senderName: "Alice",
				senderUsername: null,
				threadId: null,
				isForum: false,
			},
			"hi",
		);
		expect(result).toContain("From: Alice");
		expect(result).not.toContain("(@");
	});
});
