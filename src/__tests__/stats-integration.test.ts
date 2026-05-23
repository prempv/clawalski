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

// ---------------------------------------------------------------------------
// Test helpers — mirrored from claude-handler.test.ts (not refactored to
// avoid disturbing the existing test).
// ---------------------------------------------------------------------------

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
		close: vi.fn(),
	};
}

/**
 * Make a fake ConversationProcess that pushes a canned event script on its
 * first sendInput then ends the queue (so the long-running forwarder
 * finishes naturally). Mirrors the helper in claude-handler.test.ts.
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

/**
 * Variant that pushes events but DOES NOT close the queue — so the
 * forwarder stays alive and `recorder.end()` is not yet called. Returned
 * `queue` lets the test close the stream after `/stats` runs.
 */
function fakeConversationProcessOpen(events: BackendStreamEvent[] = []): {
	proc: ConversationProcess;
	queue: EventQueue;
} {
	const queue = new EventQueue();
	let sent = false;
	const proc: ConversationProcess = {
		stream: () => queue,
		sendInput: vi.fn(() => {
			if (sent) return;
			sent = true;
			for (const ev of events) queue.push(ev);
			// Intentionally leave queue open — let the test drive teardown.
		}),
		quiescent: true,
		alive: true,
		sessionId: null,
		onQuiescent: () => () => {},
		close: vi.fn(),
	};
	return { proc, queue };
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

function mockBackends(
	procFactory?: () => ConversationProcess,
): BackendRegistry {
	const pools = new Map<BackendId, BackendPool>([
		["claude", mockPool("claude", procFactory)],
		["codex", mockPool("codex", procFactory)],
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

/**
 * Each test uses a distinct senderId so the global `sessions` map inside
 * claude-handler.ts can't leak state between tests.
 */
function makeDmUpdate(
	text: string,
	senderId: number,
	updateId: number,
	messageId: number,
): TelegramUpdate {
	return {
		update_id: updateId,
		message: {
			message_id: messageId,
			date: Date.now(),
			chat: { id: senderId, type: "private" },
			from: {
				id: senderId,
				is_bot: false,
				first_name: "Tester",
				username: "tester",
			},
			text,
		},
	};
}

/** Capture the captured /stats reply text, given a sendMessage spy. */
function findStatsReply(
	client: TelegramClient,
): { text: string; replyToId: number | undefined } | null {
	const spy = client.sendMessage as ReturnType<typeof vi.fn>;
	for (let i = spy.mock.calls.length - 1; i >= 0; i--) {
		const call = spy.mock.calls[i];
		const arg = call?.[0] as
			| { text?: string; reply_parameters?: { message_id?: number } }
			| undefined;
		if (!arg?.text) continue;
		// /stats reply always starts with "Session Stats" or is the empty
		// "No active session." sentinel — both are short, distinct from the
		// streaming forwarder's HTML reply.
		if (
			arg.text.startsWith("Session Stats") ||
			arg.text === "No active session."
		) {
			return {
				text: arg.text,
				replyToId: arg.reply_parameters?.message_id,
			};
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("/stats end-to-end integration", () => {
	it("happy path: text_delta → tool_use → tool_result → turn_complete, then /stats reports the recorded session", async () => {
		const client = mockClient();
		const recorder = new SessionRecorder();
		const senderId = 1001;

		const events: BackendStreamEvent[] = [
			{ type: "session_meta", model: "claude-opus-4-7" },
			{ type: "text_delta", content: "Sure, " },
			{ type: "text_delta", content: "I'll take a look." },
			{
				type: "tool_use",
				toolUseId: "tu_1",
				toolName: "Read",
				input: '{"file_path":"/etc/hosts"}',
			},
			{
				type: "tool_result",
				toolUseId: "tu_1",
				output: "127.0.0.1 localhost\n",
				isError: false,
			},
			{
				type: "turn_complete",
				sessionId: "happy-session-id",
				model: "claude-opus-4-7",
				outputTokens: 137,
				inputTokens: 4_200,
				contextWindow: 200_000,
				costUsd: 0.0123,
			} as BackendStreamEvent,
		];

		const backends = mockBackends(() => fakeConversationProcess(events));
		const opts = makeOpts({ sessionRecorder: recorder, backends });

		// First user message → starts session, forwarder consumes events,
		// queue.end() → forwarder resolves → recorder.end() fires.
		await handleUpdate(
			client,
			makeDmUpdate("read /etc/hosts please", senderId, 1, 1),
			mockLogger() as never,
			opts,
		);

		// Drain microtasks so the forwarder's `.finally` (which calls
		// recorder.end and removes the session from the in-memory map) has run.
		await new Promise((r) => setTimeout(r, 30));

		// Now /stats — runs synchronously off the recorder.
		await handleUpdate(
			client,
			makeDmUpdate("/stats", senderId, 2, 2),
			mockLogger() as never,
			opts,
		);

		const reply = findStatsReply(client);
		expect(reply).not.toBeNull();
		const text = reply?.text ?? "";

		// eslint-disable-next-line no-console
		console.log(
			`\n----- happy-path /stats reply -----\n${text}\n----- end -----\n`,
		);

		expect(text).toContain("Session Stats");
		expect(text).toContain("claude-opus-4-7");
		expect(text).toContain("Output tokens:");
		expect(text).toContain("137");
		expect(text).toMatch(/Health: [A-F]/);
		expect(text).toMatch(
			/Status: (awaiting user|tool call in progress|ended cleanly)/,
		);

		// Tier-1 bug regression: legacy "Input tokens:" line must be gone.
		expect(text).not.toContain("Input tokens:");

		// Peak context must be captured — must NOT show 0% / 0 tokens.
		expect(text).toContain("Context peak:");
		expect(text).not.toMatch(/Context peak: 0\b/);
		expect(text).not.toMatch(/\(0\.0%\)/);
	});

	it("empty conversation: /stats with no prior session replies with the empty sentinel", async () => {
		const client = mockClient();
		const recorder = new SessionRecorder();
		const senderId = 1002;
		const opts = makeOpts({ sessionRecorder: recorder });

		await handleUpdate(
			client,
			makeDmUpdate("/stats", senderId, 1, 1),
			mockLogger() as never,
			opts,
		);

		const spy = client.sendMessage as ReturnType<typeof vi.fn>;
		expect(spy).toHaveBeenCalledTimes(1);
		const arg = spy.mock.calls[0]?.[0] as { text?: string } | undefined;
		expect(arg?.text).toBe("No active session.");
	});

	it("tool retry path: 4 identical Bash calls → /stats reports Tool retries: 3", async () => {
		const client = mockClient();
		const recorder = new SessionRecorder();
		const senderId = 1003;

		const bashInput = '{"command":"ls -la /tmp"}';
		const events: BackendStreamEvent[] = [
			{ type: "session_meta", model: "claude-opus-4-7" },
			{ type: "text_delta", content: "Retrying..." },
			...[1, 2, 3, 4].flatMap<BackendStreamEvent>((i) => [
				{
					type: "tool_use",
					toolUseId: `tu_${i}`,
					toolName: "Bash",
					input: bashInput,
				},
				{
					type: "tool_result",
					toolUseId: `tu_${i}`,
					output: "",
					isError: false,
				},
			]),
			{
				type: "turn_complete",
				sessionId: "retry-session",
				model: "claude-opus-4-7",
				outputTokens: 50,
				inputTokens: 1_000,
				contextWindow: 200_000,
				costUsd: 0.001,
			} as BackendStreamEvent,
		];

		const backends = mockBackends(() => fakeConversationProcess(events));
		const opts = makeOpts({ sessionRecorder: recorder, backends });

		await handleUpdate(
			client,
			makeDmUpdate("ls /tmp four times", senderId, 1, 1),
			mockLogger() as never,
			opts,
		);
		await new Promise((r) => setTimeout(r, 30));

		await handleUpdate(
			client,
			makeDmUpdate("/stats", senderId, 2, 2),
			mockLogger() as never,
			opts,
		);

		const reply = findStatsReply(client);
		expect(reply).not.toBeNull();
		const text = reply?.text ?? "";
		expect(text).toContain("Session Stats");
		expect(text).toContain("Tool retries: 3");
	});

	it("awaiting user: turn_complete with no in-flight tool → /stats Status says 'awaiting user'", async () => {
		const client = mockClient();
		const recorder = new SessionRecorder();
		const senderId = 1004;

		// Use the OPEN-queue variant so the forwarder stays alive and
		// recorder.end() is not yet called when /stats fires.
		const { proc, queue } = fakeConversationProcessOpen([
			{ type: "session_meta", model: "claude-opus-4-7" },
			{ type: "text_delta", content: "All done." },
			{
				type: "turn_complete",
				sessionId: "awaiting-session",
				model: "claude-opus-4-7",
				outputTokens: 12,
				inputTokens: 800,
				contextWindow: 200_000,
				costUsd: 0.0001,
			} as BackendStreamEvent,
		]);

		const claudePool: BackendPool = {
			id: "claude",
			getOrCreate: vi.fn(() => proc),
			remove: vi.fn(),
			closeAll: vi.fn(),
		} as unknown as BackendPool;
		const codexPool = mockPool("codex");
		const backends: BackendRegistry = {
			defaultId: "claude",
			pool: (id: BackendId) => (id === "claude" ? claudePool : codexPool),
			cronPool: (_id: BackendId) =>
				({}) as unknown as ReturnType<BackendRegistry["cronPool"]>,
			closeAll: vi.fn(),
		};

		const opts = makeOpts({ sessionRecorder: recorder, backends });

		await handleUpdate(
			client,
			makeDmUpdate("hi there", senderId, 1, 1),
			mockLogger() as never,
			opts,
		);
		// Let the forwarder process the pushed events (text_delta +
		// turn_complete). It will then sit waiting on the still-open queue.
		await new Promise((r) => setTimeout(r, 30));

		await handleUpdate(
			client,
			makeDmUpdate("/stats", senderId, 2, 2),
			mockLogger() as never,
			opts,
		);

		const reply = findStatsReply(client);
		expect(reply).not.toBeNull();
		const text = reply?.text ?? "";
		expect(text).toContain("Session Stats");
		expect(text).toMatch(/Status: awaiting user/);

		// Cleanup: close the queue so the forwarder can resolve and not
		// leak past the test.
		queue.end();
		await new Promise((r) => setTimeout(r, 20));
	});
});
