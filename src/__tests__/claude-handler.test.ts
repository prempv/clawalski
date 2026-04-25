import { describe, expect, it, vi } from "vitest";
import { PendingBackendStore } from "../backend-registry.js";
import type {
	BackendCronPool,
	BackendId,
	BackendPool,
	BackendRegistry,
} from "../backend.js";
import type { HandleUpdateOptions } from "../claude-handler.js";
import { handleUpdate } from "../claude-handler.js";
import type { SessionRecord, SessionStore } from "../session-store.js";
import type { TelegramClient } from "../telegram-client.js";
import type { TelegramUpdate } from "../types.js";

function mockClient() {
	return {
		sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
		editMessageText: vi.fn().mockResolvedValue({ message_id: 1 }),
		sendChatAction: vi.fn().mockResolvedValue(undefined),
		deleteMessage: vi.fn().mockResolvedValue(undefined),
	} as unknown as TelegramClient;
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

function mockSessionStore(): SessionStore {
	const sessions = new Map<string, SessionRecord>();
	return {
		getSession: vi.fn((id: string) => sessions.get(id) ?? null),
		setSession: vi.fn((id: string, sid: string, backend: BackendId) =>
			sessions.set(id, { sessionId: sid, backend }),
		),
		deleteSession: vi.fn((id: string) => sessions.delete(id)),
		getStats: vi.fn(() => null),
		updateStats: vi.fn(),
		close: vi.fn(),
	};
}

function mockPool(id: BackendId): BackendPool {
	return {
		id,
		getOrCreate: vi.fn(),
		remove: vi.fn(),
		closeAll: vi.fn(),
	} as unknown as BackendPool;
}

function mockCronPool(id: BackendId): BackendCronPool {
	return {
		id,
		create: vi.fn(),
		remove: vi.fn(),
		closeAll: vi.fn(),
	} as unknown as BackendCronPool;
}

function mockBackends(): BackendRegistry {
	const pools = new Map<BackendId, BackendPool>([
		["claude", mockPool("claude")],
		["codex", mockPool("codex")],
	]);
	const cronPools = new Map<BackendId, BackendCronPool>([
		["claude", mockCronPool("claude")],
		["codex", mockCronPool("codex")],
	]);
	return {
		defaultId: "claude",
		pool: (id: BackendId) => pools.get(id) as BackendPool,
		cronPool: (id: BackendId) => cronPools.get(id) as BackendCronPool,
		closeAll: vi.fn(),
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

function makeOpts(
	overrides: Partial<HandleUpdateOptions> = {},
): HandleUpdateOptions {
	return {
		respondMode: "all",
		botUsername: "TestBot",
		getAccess: () => openAccess,
		sessionStore: mockSessionStore(),
		backends: mockBackends(),
		pendingBackends: new PendingBackendStore(),
		conversationLogger: { log: vi.fn() },
		promptsDir: "/tmp/test-prompts",
		cronFilePath: "/tmp/test-crons.json",
		conversationLogDir: "/tmp/test-conversations",
		...overrides,
	};
}

function makeDmUpdate(text: string): TelegramUpdate {
	return {
		update_id: 1,
		message: {
			message_id: 1,
			date: Date.now(),
			chat: { id: 123, type: "private" },
			from: { id: 1, is_bot: false, first_name: "Test", username: "tester" },
			text,
		},
	};
}

describe("handleUpdate — command routing", () => {
	it("/new clears session and confirms", async () => {
		const client = mockClient();
		const store = mockSessionStore();
		store.setSession("tg:dm:1", "old-session", "claude");

		await handleUpdate(
			client,
			makeDmUpdate("/new"),
			mockLogger() as never,
			makeOpts({ sessionStore: store }),
		);

		expect(store.deleteSession).toHaveBeenCalledWith("tg:dm:1");
		expect(client.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("Session cleared"),
			}),
		);
	});

	it("/new codex pins the next message to the codex backend", async () => {
		const client = mockClient();
		const pending = new PendingBackendStore();

		await handleUpdate(
			client,
			makeDmUpdate("/new codex"),
			mockLogger() as never,
			makeOpts({ pendingBackends: pending }),
		);

		expect(pending.get("tg:dm:1")).toBe("codex");
		expect(client.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("codex"),
			}),
		);
	});

	it("/new with an unknown backend rejects", async () => {
		const client = mockClient();
		const pending = new PendingBackendStore();

		await handleUpdate(
			client,
			makeDmUpdate("/new gpt5"),
			mockLogger() as never,
			makeOpts({ pendingBackends: pending }),
		);

		expect(pending.get("tg:dm:1")).toBeNull();
		expect(client.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("Unknown backend"),
			}),
		);
	});
});

describe("handleUpdate — access control", () => {
	it("silently ignores denied users", async () => {
		const client = mockClient();
		const opts = makeOpts({
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
		});

		await handleUpdate(
			client,
			makeDmUpdate("hello"),
			mockLogger() as never,
			opts,
		);
		expect(client.sendMessage).not.toHaveBeenCalled();
	});
});

describe("handleUpdate — empty updates", () => {
	it("skips updates with no message", async () => {
		const client = mockClient();
		await handleUpdate(
			client,
			{ update_id: 1 },
			mockLogger() as never,
			makeOpts(),
		);
		expect(client.sendMessage).not.toHaveBeenCalled();
	});
});
