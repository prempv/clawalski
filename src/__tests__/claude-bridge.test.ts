import { describe, expect, it, vi } from "vitest";
import type { ClaudeProcessLike, ClaudeStreamEvent } from "../claude-bridge.js";
import {
	EventQueue,
	StreamEventParser,
	isAuthError,
	sendMessageWithAuthRetry,
} from "../claude-bridge.js";
import type { Logger } from "../logger.js";
import type { ContentBlock } from "../types.js";

const AUTH_401_MSG =
	'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_xyz"}';

function mockLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn(),
	} as unknown as Logger;
}

/**
 * Fake ClaudeProcess: scripts events for a single sendInput call, then ends
 * the stream so the consumer's loop terminates. Real procs end the stream
 * on close()/process death; for these tests we end it after the scripted
 * batch so collect() returns instead of hanging.
 */
function fakeProc(events: ClaudeStreamEvent[]): ClaudeProcessLike {
	const queue = new EventQueue();
	let sent = false;
	return {
		sendInput(): void {
			if (sent) return;
			sent = true;
			for (const ev of events) queue.push(ev);
			queue.end();
		},
		stream(): AsyncIterable<ClaudeStreamEvent> {
			return queue;
		},
	};
}

async function collect(
	gen: AsyncIterable<ClaudeStreamEvent>,
): Promise<ClaudeStreamEvent[]> {
	const out: ClaudeStreamEvent[] = [];
	for await (const ev of gen) out.push(ev);
	return out;
}

const CONTENT: ContentBlock[] = [{ type: "text", text: "hello" }];
const NO_RETRY_DELAY = { retryDelaysMs: [0] };

describe("isAuthError", () => {
	it("matches Claude CLI 401 message", () => {
		expect(isAuthError(AUTH_401_MSG)).toBe(true);
	});

	it("matches bare authentication_error", () => {
		expect(isAuthError("authentication_error: token expired")).toBe(true);
	});

	it("matches 'Invalid authentication'", () => {
		expect(isAuthError("Invalid authentication credentials")).toBe(true);
	});

	it("does not match unrelated errors", () => {
		expect(isAuthError("spawn ENOENT")).toBe(false);
		expect(isAuthError("rate_limit_exceeded")).toBe(false);
		expect(isAuthError("API Error: 500 overloaded")).toBe(false);
	});

	it("does not match 401 in a non-auth context", () => {
		// Pattern is anchored to 'API Error: 401' or auth keywords; a bare '401'
		// elsewhere should not trigger a retry.
		expect(isAuthError("got 401 responses earlier in the day")).toBe(false);
	});
});

// Helper that picks procs in order: first call returns procs[0] for
// initialProc, subsequent calls (the respawn closure) return procs[1..].
function procSequence(procs: ClaudeProcessLike[]): {
	initial: ClaudeProcessLike;
	respawn: () => ClaudeProcessLike;
	respawnFn: ReturnType<typeof vi.fn>;
} {
	const [first, ...rest] = procs;
	if (!first) throw new Error("procSequence requires at least one proc");
	let i = 0;
	const respawnFn = vi.fn(() => {
		const next = rest[i++];
		if (!next) throw new Error("procSequence: no more respawn procs");
		return next;
	});
	return { initial: first, respawn: respawnFn, respawnFn };
}

describe("sendMessageWithAuthRetry", () => {
	it("passes through a normal stream without retry", async () => {
		const remove = vi.fn();
		const proc = fakeProc([
			{ type: "session_meta", model: "claude-opus-4-6" },
			{ type: "text_delta", content: "hi" },
			{ type: "turn_complete", sessionId: "s1" },
		]);
		// Long-lived stream contract: end the stream so the consumer's loop
		// terminates. Real procs end the stream on close()/process death.
		const respawn = vi.fn<() => ClaudeProcessLike>();

		const events = await collect(
			sendMessageWithAuthRetry(
				proc,
				respawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				NO_RETRY_DELAY,
			),
		);

		expect(events.map((e) => e.type)).toEqual([
			"session_meta",
			"text_delta",
			"turn_complete",
		]);
		expect(respawn).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it("retries on auth 401 before any output, then succeeds", async () => {
		const remove = vi.fn();
		const log = mockLogger();
		const { initial, respawn, respawnFn } = procSequence([
			fakeProc([
				{ type: "session_meta", model: "claude-opus-4-6" },
				{ type: "error", message: AUTH_401_MSG },
			]),
			fakeProc([
				{ type: "session_meta", model: "claude-opus-4-6" },
				{ type: "text_delta", content: "recovered" },
				{ type: "turn_complete", sessionId: "s2" },
			]),
		]);

		const events = await collect(
			sendMessageWithAuthRetry(
				initial,
				respawn,
				remove,
				CONTENT,
				undefined,
				log,
				NO_RETRY_DELAY,
			),
		);

		// Caller should see ONLY the second attempt's events — the failed
		// first attempt is swallowed so Telegram never gets the 401.
		expect(events).toEqual([
			{ type: "session_meta", model: "claude-opus-4-6" },
			{ type: "text_delta", content: "recovered" },
			{ type: "turn_complete", sessionId: "s2" },
		]);
		expect(respawnFn).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ attempt: 1 }),
			expect.stringContaining("auth 401"),
		);
	});

	it("does not retry on non-auth errors", async () => {
		const remove = vi.fn();
		const proc = fakeProc([{ type: "error", message: "rate_limit_exceeded" }]);
		const respawn = vi.fn<() => ClaudeProcessLike>();

		const events = await collect(
			sendMessageWithAuthRetry(
				proc,
				respawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				NO_RETRY_DELAY,
			),
		);

		expect(events).toEqual([{ type: "error", message: "rate_limit_exceeded" }]);
		expect(respawn).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it("surfaces the final auth error when retries are exhausted", async () => {
		const remove = vi.fn();
		const { initial, respawn, respawnFn } = procSequence([
			fakeProc([{ type: "error", message: AUTH_401_MSG }]),
			fakeProc([{ type: "error", message: AUTH_401_MSG }]),
		]);

		const events = await collect(
			sendMessageWithAuthRetry(
				initial,
				respawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				{ maxAttempts: 2, retryDelaysMs: [0] },
			),
		);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error" });
		expect(respawnFn).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledTimes(1);
	});

	it("defaults to three attempts with auth 401 before giving up", async () => {
		const remove = vi.fn();
		const { initial, respawn, respawnFn } = procSequence([
			fakeProc([{ type: "error", message: AUTH_401_MSG }]),
			fakeProc([{ type: "error", message: AUTH_401_MSG }]),
			fakeProc([{ type: "error", message: AUTH_401_MSG }]),
		]);

		await collect(
			sendMessageWithAuthRetry(
				initial,
				respawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				{ retryDelaysMs: [0, 0] },
			),
		);

		// Default maxAttempts is 3 → respawn called twice (attempts 2 and 3),
		// remove called twice (before each retry).
		expect(respawnFn).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledTimes(2);
	});

	it("does not retry when an auth-like error arrives after commit", async () => {
		// Once we've seen a user-visible event (text_delta here), the wrapper
		// is committed to streaming and any subsequent error flows through.
		const remove = vi.fn();
		const proc = fakeProc([
			{ type: "text_delta", content: "partial " },
			{ type: "error", message: AUTH_401_MSG },
		]);
		const respawn = vi.fn<() => ClaudeProcessLike>();

		const events = await collect(
			sendMessageWithAuthRetry(
				proc,
				respawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				NO_RETRY_DELAY,
			),
		);

		expect(events.map((e) => e.type)).toEqual(["text_delta", "error"]);
		expect(respawn).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it("respects a custom maxAttempts", async () => {
		const remove = vi.fn();
		const { initial, respawn, respawnFn } = procSequence([
			fakeProc([{ type: "error", message: AUTH_401_MSG }]),
			fakeProc([{ type: "error", message: AUTH_401_MSG }]),
			fakeProc([{ type: "error", message: AUTH_401_MSG }]),
		]);

		await collect(
			sendMessageWithAuthRetry(
				initial,
				respawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				{ maxAttempts: 3, retryDelaysMs: [0] },
			),
		);

		expect(respawnFn).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledTimes(2);
	});

	it("buffers pre-commit events across a retry cleanly", async () => {
		// First attempt emits a session_meta before failing — that buffered
		// event must NOT leak into the second attempt's yielded stream.
		const remove = vi.fn();
		const { initial, respawn } = procSequence([
			fakeProc([
				{ type: "session_meta", model: "attempt-1-model" },
				{ type: "error", message: AUTH_401_MSG },
			]),
			fakeProc([
				{ type: "session_meta", model: "attempt-2-model" },
				{ type: "text_delta", content: "ok" },
				{ type: "turn_complete", sessionId: "s2" },
			]),
		]);

		const events = await collect(
			sendMessageWithAuthRetry(
				initial,
				respawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				NO_RETRY_DELAY,
			),
		);

		const sessionMetas = events.filter((e) => e.type === "session_meta");
		expect(sessionMetas).toHaveLength(1);
		expect(sessionMetas[0]).toMatchObject({ model: "attempt-2-model" });
	});

	it("uses initialProc on first attempt and never calls respawn if it succeeds", async () => {
		// Regression guard: pre-fix, the handler relied on a lazy spawn closure
		// that ran inside the iterator's first .next(). Now the proc is
		// captured synchronously by the caller and passed in directly.
		const remove = vi.fn();
		const respawn = vi.fn<() => ClaudeProcessLike>();
		const initial = fakeProc([
			{ type: "text_delta", content: "via-initial" },
			{ type: "turn_complete", sessionId: "s1" },
		]);

		await collect(
			sendMessageWithAuthRetry(
				initial,
				respawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				NO_RETRY_DELAY,
			),
		);

		expect(respawn).not.toHaveBeenCalled();
	});
});

describe("EventQueue", () => {
	it("yields buffered events in push order", async () => {
		const q = new EventQueue();
		q.push({ type: "text_delta", content: "a" });
		q.push({ type: "text_delta", content: "b" });
		q.end();

		const events: ClaudeStreamEvent[] = [];
		for await (const ev of q) events.push(ev);

		expect(events).toEqual([
			{ type: "text_delta", content: "a" },
			{ type: "text_delta", content: "b" },
		]);
	});

	it("waits for events when the buffer is empty", async () => {
		const q = new EventQueue();
		const collected: ClaudeStreamEvent[] = [];
		const consumer = (async () => {
			for await (const ev of q) collected.push(ev);
		})();

		await new Promise((r) => setTimeout(r, 5));
		q.push({ type: "text_delta", content: "late" });
		await new Promise((r) => setTimeout(r, 5));
		q.end();
		await consumer;

		expect(collected).toEqual([{ type: "text_delta", content: "late" }]);
	});

	it("ignores pushes after end()", async () => {
		const q = new EventQueue();
		q.push({ type: "text_delta", content: "before" });
		q.end();
		q.push({ type: "text_delta", content: "after" });

		const events: ClaudeStreamEvent[] = [];
		for await (const ev of q) events.push(ev);

		expect(events).toEqual([{ type: "text_delta", content: "before" }]);
	});

	it("does not end on turn_complete (long-lived contract)", async () => {
		// Critical regression guard for the fix: the queue must NOT terminate
		// on turn_complete. Auto-continuations (CLI-driven follow-ups, or new
		// user inputs in the long-running conversation forwarder) push more
		// events into the same queue afterwards.
		const q = new EventQueue();
		q.push({ type: "text_delta", content: "first" });
		q.push({ type: "turn_complete", sessionId: "s1" });
		q.push({ type: "text_delta", content: "auto-continuation" });
		q.push({ type: "turn_complete", sessionId: "s1" });
		q.end();

		const events: ClaudeStreamEvent[] = [];
		for await (const ev of q) events.push(ev);

		expect(events.map((e) => e.type)).toEqual([
			"text_delta",
			"turn_complete",
			"text_delta",
			"turn_complete",
		]);
	});
});

describe("StreamEventParser", () => {
	it("emits text deltas from stream events", () => {
		const parser = new StreamEventParser();

		expect(
			parser.process({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "hello" },
				},
			}),
		).toEqual([{ type: "text_delta", content: "hello" }]);
	});

	it("emits complete tool_use events after accumulating JSON deltas", () => {
		const parser = new StreamEventParser();

		expect(
			parser.process({
				type: "stream_event",
				event: {
					type: "content_block_start",
					content_block: { type: "tool_use", id: "toolu_1", name: "Read" },
				},
			}),
		).toEqual([]);
		expect(
			parser.process({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "input_json_delta", partial_json: '{"file_path":' },
				},
			}),
		).toEqual([]);
		expect(
			parser.process({
				type: "stream_event",
				event: {
					type: "content_block_delta",
					delta: { type: "input_json_delta", partial_json: '"/tmp/a"}' },
				},
			}),
		).toEqual([]);

		expect(
			parser.process({
				type: "stream_event",
				event: { type: "content_block_stop" },
			}),
		).toEqual([
			{
				type: "tool_use",
				toolUseId: "toolu_1",
				toolName: "Read",
				input: '{"file_path":"/tmp/a"}',
			},
		]);
	});

	it("does not complete the turn for tool-use message stops", () => {
		const parser = new StreamEventParser();

		expect(
			parser.process({
				type: "stream_event",
				event: {
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
				},
				session_id: "s1",
			}),
		).toEqual([]);
		expect(
			parser.process({
				type: "stream_event",
				event: { type: "message_stop" },
				session_id: "s1",
			}),
		).toEqual([]);
	});

	it("emits turn_complete for final assistant message stops", () => {
		const parser = new StreamEventParser();

		expect(
			parser.process({
				type: "stream_event",
				event: { type: "message_start" },
				session_id: "s1",
			}),
		).toEqual([]);
		expect(
			parser.process({
				type: "stream_event",
				event: {
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
				},
				session_id: "s1",
			}),
		).toEqual([]);
		expect(
			parser.process({
				type: "stream_event",
				event: { type: "message_stop" },
				session_id: "s1",
			}),
		).toEqual([{ type: "turn_complete", sessionId: "s1" }]);
	});
});
