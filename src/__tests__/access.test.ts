import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessConfig } from "../access.js";
import {
	formatAdminNotification,
	isAllowed,
	loadAccessConfig,
	shouldNotifyAdmin,
} from "../access.js";
import type { MessageContext } from "../message-context.js";

function makeCtx(overrides: Partial<MessageContext> = {}): MessageContext {
	return {
		conversationId: "tg:dm:100",
		chatType: "private",
		chatId: 100,
		chatTitle: null,
		senderId: 100,
		senderName: "Alice",
		senderUsername: "alice",
		threadId: null,
		isForum: false,
		...overrides,
	};
}

const openAccess: AccessConfig = {
	dmPolicy: "open",
	groupPolicy: "open",
	allowedUsers: new Set(),
	allowedGroups: new Set(),
	allowAllUsers: false,
	allowAllGroups: false,
	adminChatId: null,
	dmDefaultBackend: null,
	groupDefaultBackend: null,
};

const strictAccess: AccessConfig = {
	dmPolicy: "allowlist",
	groupPolicy: "allowlist",
	allowedUsers: new Set([100, 200]),
	allowedGroups: new Set([-300]),
	allowAllUsers: false,
	allowAllGroups: false,
	adminChatId: null,
	dmDefaultBackend: null,
	groupDefaultBackend: null,
};

describe("isAllowed", () => {
	it("allows all DMs when dmPolicy is open", () => {
		expect(isAllowed(makeCtx({ senderId: 999 }), openAccess)).toBe(true);
	});

	it("allows DM from listed user", () => {
		expect(isAllowed(makeCtx({ senderId: 100 }), strictAccess)).toBe(true);
	});

	it("denies DM from unlisted user", () => {
		expect(isAllowed(makeCtx({ senderId: 999 }), strictAccess)).toBe(false);
	});

	it("denies DM with null senderId in allowlist mode", () => {
		expect(isAllowed(makeCtx({ senderId: null }), strictAccess)).toBe(false);
	});

	it("allows all groups when groupPolicy is open", () => {
		const ctx = makeCtx({ chatType: "group", chatId: -999, senderId: 999 });
		expect(isAllowed(ctx, openAccess)).toBe(true);
	});

	it("allows group message when chat AND sender are listed", () => {
		const ctx = makeCtx({
			chatType: "supergroup",
			chatId: -300,
			senderId: 100,
		});
		expect(isAllowed(ctx, strictAccess)).toBe(true);
	});

	it("denies group message when chat is listed but sender is not", () => {
		const ctx = makeCtx({
			chatType: "supergroup",
			chatId: -300,
			senderId: 999,
		});
		expect(isAllowed(ctx, strictAccess)).toBe(false);
	});

	it("denies group message when sender is listed but chat is not", () => {
		const ctx = makeCtx({ chatType: "group", chatId: -999, senderId: 100 });
		expect(isAllowed(ctx, strictAccess)).toBe(false);
	});

	it("allows all users with wildcard", () => {
		const access: AccessConfig = { ...strictAccess, allowAllUsers: true };
		expect(isAllowed(makeCtx({ senderId: 999 }), access)).toBe(true);
	});

	it("allows all groups with wildcard", () => {
		const access: AccessConfig = {
			...strictAccess,
			allowAllGroups: true,
			allowAllUsers: true,
		};
		const ctx = makeCtx({ chatType: "group", chatId: -999, senderId: 999 });
		expect(isAllowed(ctx, access)).toBe(true);
	});

	it("always denies channel messages", () => {
		const ctx = makeCtx({ chatType: "channel", chatId: -100 });
		expect(isAllowed(ctx, openAccess)).toBe(false);
	});
});

describe("loadAccessConfig", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "access-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true });
	});

	it("loads valid config from file", async () => {
		const filePath = join(tmpDir, "access.json");
		await writeFile(
			filePath,
			JSON.stringify({
				dmPolicy: "allowlist",
				groupPolicy: "open",
				allowedUsers: [111, 222],
				allowedGroups: [-333],
			}),
		);

		const config = loadAccessConfig(filePath);
		expect(config.dmPolicy).toBe("allowlist");
		expect(config.groupPolicy).toBe("open");
		expect(config.allowedUsers.has(111)).toBe(true);
		expect(config.allowedUsers.has(222)).toBe(true);
		expect(config.allowedGroups.has(-333)).toBe(true);
	});

	it("returns open defaults when file does not exist", () => {
		const config = loadAccessConfig(join(tmpDir, "missing.json"));
		expect(config.dmPolicy).toBe("open");
		expect(config.groupPolicy).toBe("open");
	});

	it("detects wildcard in allowedUsers", async () => {
		const filePath = join(tmpDir, "access.json");
		await writeFile(filePath, JSON.stringify({ allowedUsers: ["*", 100] }));

		const config = loadAccessConfig(filePath);
		expect(config.allowAllUsers).toBe(true);
		expect(config.allowedUsers.has(100)).toBe(true);
	});

	it("throws on invalid JSON", async () => {
		const filePath = join(tmpDir, "access.json");
		await writeFile(filePath, "not json");
		expect(() => loadAccessConfig(filePath)).toThrow();
	});

	it("loads adminChatId", async () => {
		const filePath = join(tmpDir, "access.json");
		await writeFile(filePath, JSON.stringify({ adminChatId: 12345 }));
		const config = loadAccessConfig(filePath);
		expect(config.adminChatId).toBe(12345);
	});
});

describe("formatAdminNotification", () => {
	it("formats DM notification", () => {
		const text = formatAdminNotification(makeCtx());
		expect(text).toContain("New contact attempt");
		expect(text).toContain("Alice (@alice)");
		expect(text).toContain("User ID: 100");
		expect(text).toContain("Context: DM");
	});

	it("formats group notification", () => {
		const text = formatAdminNotification(
			makeCtx({
				chatType: "supergroup",
				chatId: -300,
				chatTitle: "Dev Chat",
			}),
		);
		expect(text).toContain("supergroup Dev Chat (-300)");
	});

	it("formats forum topic notification", () => {
		const text = formatAdminNotification(
			makeCtx({
				chatType: "supergroup",
				chatId: -300,
				chatTitle: "Dev Chat",
				isForum: true,
				threadId: 7,
			}),
		);
		expect(text).toContain("Topic: 7");
	});
});

describe("shouldNotifyAdmin", () => {
	it("returns true on first contact", () => {
		const ctx = makeCtx({ senderId: 50000, chatId: 50000 });
		expect(shouldNotifyAdmin(ctx)).toBe(true);
	});

	it("returns false for same sender within cooldown", () => {
		const ctx = makeCtx({ senderId: 50001, chatId: 50001 });
		shouldNotifyAdmin(ctx);
		expect(shouldNotifyAdmin(ctx)).toBe(false);
	});
});
