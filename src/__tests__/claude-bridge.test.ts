import { describe, expect, it, vi } from "vitest";
import type { ClaudeProcessLike, ClaudeStreamEvent } from "../claude-bridge.js";
import { isAuthError, sendMessageWithAuthRetry } from "../claude-bridge.js";
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

/** Fake ClaudeProcess that emits a scripted list of events for one turn. */
function fakeProc(events: ClaudeStreamEvent[]): ClaudeProcessLike {
	return {
		sendMessage(): AsyncIterable<ClaudeStreamEvent> {
			return {
				[Symbol.asyncIterator]: async function* () {
					for (const ev of events) yield ev;
				},
			};
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

describe("sendMessageWithAuthRetry", () => {
	it("passes through a normal stream without retry", async () => {
		const remove = vi.fn();
		const spawn = vi.fn(() =>
			fakeProc([
				{ type: "session_meta", model: "claude-opus-4-6" },
				{ type: "text_delta", content: "hi" },
				{ type: "turn_complete", sessionId: "s1" },
			]),
		);

		const events = await collect(
			sendMessageWithAuthRetry(
				spawn,
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
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(remove).not.toHaveBeenCalled();
	});

	it("retries on auth 401 before any output, then succeeds", async () => {
		const remove = vi.fn();
		const log = mockLogger();
		const spawn = vi
			.fn<() => ClaudeProcessLike>()
			.mockReturnValueOnce(
				fakeProc([
					{ type: "session_meta", model: "claude-opus-4-6" },
					{ type: "error", message: AUTH_401_MSG },
				]),
			)
			.mockReturnValueOnce(
				fakeProc([
					{ type: "session_meta", model: "claude-opus-4-6" },
					{ type: "text_delta", content: "recovered" },
					{ type: "turn_complete", sessionId: "s2" },
				]),
			);

		const events = await collect(
			sendMessageWithAuthRetry(
				spawn,
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
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ attempt: 1 }),
			expect.stringContaining("auth 401"),
		);
	});

	it("does not retry on non-auth errors", async () => {
		const remove = vi.fn();
		const spawn = vi.fn(() =>
			fakeProc([{ type: "error", message: "rate_limit_exceeded" }]),
		);

		const events = await collect(
			sendMessageWithAuthRetry(
				spawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				NO_RETRY_DELAY,
			),
		);

		expect(events).toEqual([{ type: "error", message: "rate_limit_exceeded" }]);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(remove).not.toHaveBeenCalled();
	});

	it("surfaces the final auth error when retries are exhausted", async () => {
		const remove = vi.fn();
		const spawn = vi.fn(() =>
			fakeProc([{ type: "error", message: AUTH_401_MSG }]),
		);

		const events = await collect(
			sendMessageWithAuthRetry(
				spawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				{ maxAttempts: 2, retryDelaysMs: [0] },
			),
		);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error" });
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledTimes(1);
	});

	it("defaults to three attempts with auth 401 before giving up", async () => {
		const remove = vi.fn();
		const spawn = vi.fn(() =>
			fakeProc([{ type: "error", message: AUTH_401_MSG }]),
		);

		await collect(
			sendMessageWithAuthRetry(
				spawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				{ retryDelaysMs: [0, 0] },
			),
		);

		// Default maxAttempts is 3 → spawn called three times, remove twice
		expect(spawn).toHaveBeenCalledTimes(3);
		expect(remove).toHaveBeenCalledTimes(2);
	});

	it("does not retry when an auth-like error arrives after commit", async () => {
		// Once we've seen a user-visible event (text_delta here), the wrapper
		// is committed to streaming and any subsequent error flows through.
		const remove = vi.fn();
		const spawn = vi.fn(() =>
			fakeProc([
				{ type: "text_delta", content: "partial " },
				{ type: "error", message: AUTH_401_MSG },
			]),
		);

		const events = await collect(
			sendMessageWithAuthRetry(
				spawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				NO_RETRY_DELAY,
			),
		);

		expect(events.map((e) => e.type)).toEqual(["text_delta", "error"]);
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(remove).not.toHaveBeenCalled();
	});

	it("respects a custom maxAttempts", async () => {
		const remove = vi.fn();
		const spawn = vi.fn(() =>
			fakeProc([{ type: "error", message: AUTH_401_MSG }]),
		);

		await collect(
			sendMessageWithAuthRetry(
				spawn,
				remove,
				CONTENT,
				undefined,
				mockLogger(),
				{ maxAttempts: 3, retryDelaysMs: [0] },
			),
		);

		expect(spawn).toHaveBeenCalledTimes(3);
		expect(remove).toHaveBeenCalledTimes(2);
	});

	it("buffers pre-commit events across a retry cleanly", async () => {
		// First attempt emits a session_meta before failing — that buffered
		// event must NOT leak into the second attempt's yielded stream.
		const remove = vi.fn();
		const spawn = vi
			.fn<() => ClaudeProcessLike>()
			.mockReturnValueOnce(
				fakeProc([
					{ type: "session_meta", model: "attempt-1-model" },
					{ type: "error", message: AUTH_401_MSG },
				]),
			)
			.mockReturnValueOnce(
				fakeProc([
					{ type: "session_meta", model: "attempt-2-model" },
					{ type: "text_delta", content: "ok" },
					{ type: "turn_complete", sessionId: "s2" },
				]),
			);

		const events = await collect(
			sendMessageWithAuthRetry(
				spawn,
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
});
