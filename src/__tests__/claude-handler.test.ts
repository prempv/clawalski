import { describe, expect, it, vi } from "vitest";
import { PendingBackendStore } from "../backend-registry.js";
import type {
	BackendCronPool,
	BackendId,
	BackendPool,
	BackendRegistry,
	BackendStreamEvent,
	ConversationProcess,
} from "../backend.js";
import { EventQueue } from "../claude-bridge.js";
import type { HandleUpdateOptions } from "../claude-handler.js";
import { handleUpdate } from "../claude-handler.js";
import { SessionRecorder } from "../session-stats/index.js";
import type { SessionRecord, SessionStore } from "../session-store.js";
import type { TelegramClient } from "../telegram-client.js";
import type { TelegramUpdate } from "../types.js";

function mockClient() {
	return {
		sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
		editMessageText: vi.fn().mockResolvedValue({ message_id: 1 }),
		sendChatAction: vi.fn().mockResolvedValue(undefined),
		deleteMessage: vi.fn().mockResolvedValue(undefined),
		setMessageReaction: vi.fn().mockResolvedValue(undefined),
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
		close: vi.fn(),
	};
}

/**
 * Make a fake ConversationProcess that:
 *   - returns an EventQueue stream you can push events into
 *   - exposes onQuiescent / sendInput / close as no-ops
 *   - reports `alive` = true so submitToExistingSession reuses it
 *
 * `events` is an optional canned script — pushed in order on the first
 * sendInput call, then the stream is closed so the forwarder resolves.
 */
function fakeConversationProcess(
	events: BackendStreamEvent[] = [],
): ConversationProcess {
	const queue = new EventQueue();
	let sent = false;
	const proc: ConversationProcess = {
		stream: () => queue,
		sendInput: vi.fn(() => {
			if (sent) return;
			sent = true;
			for (const ev of events) queue.push(ev);
			queue.end();
		}),
		quiescent: true,
		alive: true,
		sessionId: null,
		onQuiescent: () => () => {},
		close: vi.fn(),
	};
	return proc;
}

type ControllableConversationProcess = ConversationProcess & {
	queue: EventQueue;
	fireQuiescent: () => void;
	sendInput: ReturnType<typeof vi.fn>;
};

function controllableConversationProcess(): ControllableConversationProcess {
	const queue = new EventQueue();
	let quiescent = true;
	const callbacks = new Set<() => void>();
	const sendInput = vi.fn(() => {
		quiescent = false;
	});
	const proc = {
		stream: () => queue,
		sendInput,
		get quiescent() {
			return quiescent;
		},
		get alive() {
			return true;
		},
		get sessionId() {
			return null;
		},
		onQuiescent: (cb: () => void) => {
			callbacks.add(cb);
			return () => callbacks.delete(cb);
		},
		close: vi.fn(),
		queue,
		fireQuiescent: () => {
			quiescent = true;
			for (const cb of [...callbacks]) cb();
		},
	};
	return proc as ControllableConversationProcess;
}

function mockPool(
	id: BackendId,
	procFactory: () => ConversationProcess = () => fakeConversationProcess(),
): BackendPool {
	return {
		id,
		getOrCreate: vi.fn(procFactory),
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
		sessionRecorder: new SessionRecorder(),
		backends: mockBackends(),
		pendingBackends: new PendingBackendStore(),
		conversationLogger: { log: vi.fn() },
		promptsDir: "/tmp/test-prompts",
		cronFilePath: "/tmp/test-crons.json",
		conversationLogDir: "/tmp/test-conversations",
		bindings: { bindings: [] },
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
	it("/new-claude clears session and pins claude", async () => {
		const client = mockClient();
		const store = mockSessionStore();
		const pending = new PendingBackendStore();
		store.setSession("tg:dm:1", "old-session", "codex");

		await handleUpdate(
			client,
			makeDmUpdate("/new-claude"),
			mockLogger() as never,
			makeOpts({ sessionStore: store, pendingBackends: pending }),
		);

		expect(store.deleteSession).toHaveBeenCalledWith("tg:dm:1");
		expect(pending.get("tg:dm:1")).toBe("claude");
		expect(client.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("claude"),
			}),
		);
	});

	it("/new-codex clears session and pins codex", async () => {
		const client = mockClient();
		const pending = new PendingBackendStore();

		await handleUpdate(
			client,
			makeDmUpdate("/new-codex"),
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

	it("/new-codex tears down both backend pools (orphan-proof teardown)", async () => {
		// Older codex orphan procs from earlier failed attempts must be killed
		// when the user runs /new-codex, so they can't write a wrong-backend
		// row to sessionStore after we've cleared the conversation.
		const client = mockClient();
		const claudePool = mockPool("claude");
		const codexPool = mockPool("codex");
		const backends: BackendRegistry = {
			defaultId: "claude",
			pool: (id: BackendId) => (id === "claude" ? claudePool : codexPool),
			cronPool: (_id: BackendId) =>
				({}) as unknown as ReturnType<BackendRegistry["cronPool"]>,
			closeAll: vi.fn(),
		};

		await handleUpdate(
			client,
			makeDmUpdate("/new-codex"),
			mockLogger() as never,
			makeOpts({ backends }),
		);

		expect(claudePool.remove).toHaveBeenCalledWith("tg:dm:1");
		expect(codexPool.remove).toHaveBeenCalledWith("tg:dm:1");
	});

	it("bare /new is no longer a command — falls through to message dispatch", async () => {
		const client = mockClient();
		const pending = new PendingBackendStore();
		const claudePool = mockPool("claude");
		const codexPool = mockPool("codex");
		const backends: BackendRegistry = {
			defaultId: "claude",
			pool: (id: BackendId) => (id === "claude" ? claudePool : codexPool),
			cronPool: (_id: BackendId) =>
				({}) as unknown as ReturnType<BackendRegistry["cronPool"]>,
			closeAll: vi.fn(),
		};

		await handleUpdate(
			client,
			makeDmUpdate("/new"),
			mockLogger() as never,
			makeOpts({ pendingBackends: pending, backends }),
		);

		// The bare /new path used to clear the session; now it's just text.
		expect(pending.get("tg:dm:1")).toBeNull();
		// Pools should NOT be torn down for plain text — would only happen
		// if the new-backend command path matched.
		expect(claudePool.remove).not.toHaveBeenCalled();
		expect(codexPool.remove).not.toHaveBeenCalled();
	});

	it("/new-gpt5 (unknown backend) is not a command — does not clear", async () => {
		const client = mockClient();
		const pending = new PendingBackendStore();
		const store = mockSessionStore();

		await handleUpdate(
			client,
			makeDmUpdate("/new-gpt5"),
			mockLogger() as never,
			makeOpts({ pendingBackends: pending, sessionStore: store }),
		);

		expect(pending.get("tg:dm:1")).toBeNull();
		expect(store.deleteSession).not.toHaveBeenCalled();
	});

	it("/new-codex@SomeBot (group-mention form) still matches", async () => {
		const client = mockClient();
		const pending = new PendingBackendStore();

		await handleUpdate(
			client,
			makeDmUpdate("/new-codex@TestBot"),
			mockLogger() as never,
			makeOpts({ pendingBackends: pending }),
		);

		expect(pending.get("tg:dm:1")).toBe("codex");
	});

	it("/new_codex (underscore form, used by BotFather menu) also matches", async () => {
		const client = mockClient();
		const pending = new PendingBackendStore();

		await handleUpdate(
			client,
			makeDmUpdate("/new_codex"),
			mockLogger() as never,
			makeOpts({ pendingBackends: pending }),
		);

		expect(pending.get("tg:dm:1")).toBe("codex");
	});
});

describe("handleUpdate — backend selection (pickBackend)", () => {
	function backendsWithDistinguishablePools(): {
		backends: BackendRegistry;
		claudePool: BackendPool;
		codexPool: BackendPool;
	} {
		const claudePool = mockPool("claude", () =>
			fakeConversationProcess([
				{ type: "turn_complete", sessionId: "claude-session" },
			]),
		);
		const codexPool = mockPool("codex", () =>
			fakeConversationProcess([
				{ type: "turn_complete", sessionId: "codex-session" },
			]),
		);
		return {
			backends: {
				defaultId: "claude",
				pool: (id: BackendId) => (id === "claude" ? claudePool : codexPool),
				cronPool: (_id: BackendId) =>
					({}) as unknown as ReturnType<BackendRegistry["cronPool"]>,
				closeAll: vi.fn(),
			},
			claudePool,
			codexPool,
		};
	}

	it("pendingBackends pin wins over a stale session row", async () => {
		// The original /new-codex bug: a leftover sessions row pointed to
		// claude, so pickBackend short-circuited on `existing` and ignored
		// the codex pin the user had just set. Now the pin must always win.
		const client = mockClient();
		const { backends, claudePool, codexPool } =
			backendsWithDistinguishablePools();
		const store = mockSessionStore();
		// Stale row: pretend a previous turn (or, historically, an orphan
		// forwarder) wrote a claude row even though the user wants codex.
		store.setSession("tg:dm:1", "stale-claude-session", "claude");
		const pending = new PendingBackendStore();
		pending.set("tg:dm:1", "codex");

		await handleUpdate(
			client,
			makeDmUpdate("hello"),
			mockLogger() as never,
			makeOpts({ backends, sessionStore: store, pendingBackends: pending }),
		);

		expect(codexPool.getOrCreate).toHaveBeenCalled();
		expect(claudePool.getOrCreate).not.toHaveBeenCalled();
	});

	it("falls back to the existing session backend when no pin is set", async () => {
		const client = mockClient();
		const { backends, claudePool, codexPool } =
			backendsWithDistinguishablePools();
		const store = mockSessionStore();
		store.setSession("tg:dm:1", "codex-session", "codex");

		await handleUpdate(
			client,
			makeDmUpdate("hello"),
			mockLogger() as never,
			makeOpts({ backends, sessionStore: store }),
		);

		expect(codexPool.getOrCreate).toHaveBeenCalled();
		expect(claudePool.getOrCreate).not.toHaveBeenCalled();
	});

	it("end-to-end: /new-codex followed by a message routes via codex", async () => {
		// This is the exact scenario that failed in the wild: user runs
		// /new-codex, then sends a normal message. Even with a stale claude
		// row hanging around, the next message must route via codex.
		const client = mockClient();
		const { backends, claudePool, codexPool } =
			backendsWithDistinguishablePools();
		const store = mockSessionStore();
		store.setSession("tg:dm:1", "stale-claude-session", "claude");
		const pending = new PendingBackendStore();
		const opts = makeOpts({
			backends,
			sessionStore: store,
			pendingBackends: pending,
		});

		await handleUpdate(
			client,
			makeDmUpdate("/new-codex"),
			mockLogger() as never,
			opts,
		);
		// After /new-codex, pending=codex but store.deleteSession already
		// fired. We re-seed the stale row to simulate the real-world failure
		// mode where SOMETHING (orphan forwarder, pre-existing race, etc.)
		// resurrected the row before the user's next message.
		store.setSession("tg:dm:1", "stale-claude-session", "claude");

		await handleUpdate(
			client,
			{
				...makeDmUpdate("read this"),
				update_id: 2,
				message: { ...makeDmUpdate("read this").message, message_id: 2 },
			} as TelegramUpdate,
			mockLogger() as never,
			opts,
		);

		expect(codexPool.getOrCreate).toHaveBeenCalled();
		expect(claudePool.getOrCreate).not.toHaveBeenCalled();
	});
});

describe("handleUpdate — orphan-forwarder defense", () => {
	it("a forwarder whose session has been replaced does not write to the store", async () => {
		// Defense in depth: even if a forwarder is somehow still running
		// after a /new-* tore down its session, its resolution must not
		// touch sessionStore. handleSessionResult is gated by an ownership
		// check at the .then() call site.
		const client = mockClient();
		const store = mockSessionStore();
		const pending = new PendingBackendStore();

		// Build a controllable proc whose stream we can resolve on demand.
		const queue1 = new EventQueue();
		const proc1: ConversationProcess = {
			stream: () => queue1,
			sendInput: vi.fn(),
			quiescent: true,
			alive: true,
			sessionId: null,
			onQuiescent: () => () => {},
			close: vi.fn(),
		};
		const proc2 = fakeConversationProcess([
			{ type: "turn_complete", sessionId: "fresh-session" },
		]);

		let createCount = 0;
		const pool: BackendPool = {
			id: "claude",
			getOrCreate: vi.fn(() => (createCount++ === 0 ? proc1 : proc2)),
			remove: vi.fn(),
			closeAll: vi.fn(),
		} as unknown as BackendPool;

		const backends: BackendRegistry = {
			defaultId: "claude",
			pool: () => pool,
			cronPool: () =>
				({}) as unknown as ReturnType<BackendRegistry["cronPool"]>,
			closeAll: vi.fn(),
		};
		const opts = makeOpts({
			backends,
			sessionStore: store,
			pendingBackends: pending,
		});

		// First message starts session #1 with proc1. Forwarder is hanging
		// on queue1 — no events yet.
		await handleUpdate(
			client,
			makeDmUpdate("first"),
			mockLogger() as never,
			opts,
		);

		// /new-claude tears down the session (drops it from the in-memory
		// map, calls pool.remove which calls proc.close).
		await handleUpdate(
			client,
			{
				...makeDmUpdate("/new-claude"),
				update_id: 2,
				message: { ...makeDmUpdate("/new-claude").message, message_id: 2 },
			} as TelegramUpdate,
			mockLogger() as never,
			opts,
		);

		// Send a real message: starts session #2 with proc2. Its turn_complete
		// fires immediately; once that forwarder resolves, the row should be
		// written for "fresh-session".
		await handleUpdate(
			client,
			{
				...makeDmUpdate("second"),
				update_id: 3,
				message: { ...makeDmUpdate("second").message, message_id: 3 },
			} as TelegramUpdate,
			mockLogger() as never,
			opts,
		);

		// NOW resolve session #1's stream (the orphan-style late finalize).
		// It carries a turn_complete with a different sessionId. With the
		// ownership guard, this resolution should NOT write to the store.
		queue1.push({ type: "turn_complete", sessionId: "orphan-session" });
		queue1.end();
		// Let microtasks settle.
		await new Promise((r) => setTimeout(r, 10));

		// The store should reflect ONLY session #2's write — never the
		// orphan's stale "orphan-session" id.
		const calls = (store.setSession as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => c[1],
		);
		expect(calls).toContain("fresh-session");
		expect(calls).not.toContain("orphan-session");
	});
});

describe("handleUpdate — queued follow-ups", () => {
	it("queues behind a busy long-lived session and drains on quiescence", async () => {
		const client = mockClient();
		const log = mockLogger();
		const proc = controllableConversationProcess();
		const pool = mockPool("claude", () => proc);
		const backends: BackendRegistry = {
			defaultId: "claude",
			pool: () => pool,
			cronPool: () =>
				({}) as unknown as ReturnType<BackendRegistry["cronPool"]>,
			closeAll: vi.fn(),
		};
		const opts = makeOpts({ backends });

		await handleUpdate(client, makeDmUpdate("first"), log as never, opts);
		await new Promise((r) => setTimeout(r, 10));
		expect(proc.sendInput).toHaveBeenCalledTimes(1);

		await handleUpdate(
			client,
			{
				...makeDmUpdate("follow up"),
				update_id: 2,
				message: { ...makeDmUpdate("follow up").message, message_id: 2 },
			} as TelegramUpdate,
			log as never,
			opts,
		);

		expect(proc.sendInput).toHaveBeenCalledTimes(1);
		expect(client.setMessageReaction).toHaveBeenCalledWith(
			expect.objectContaining({
				message_id: 2,
				emojis: ["👀"],
			}),
		);
		expect(log.info).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "tg:dm:1",
				queueDepth: 1,
				messageId: 2,
			}),
			"message queued behind active session",
		);

		proc.fireQuiescent();
		await new Promise((r) => setTimeout(r, 10));

		expect(proc.sendInput).toHaveBeenCalledTimes(2);
		expect(log.info).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "tg:dm:1",
				queueDepthRemaining: 0,
				messageId: 2,
			}),
			"draining queued message",
		);

		proc.queue.end();
		await new Promise((r) => setTimeout(r, 10));
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
