import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EXPIRY_BUFFER_MS,
	type WarmupChild,
	_isExpired,
	ensureFreshCliToken,
} from "../cli-token-warmup.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

function makeCredentials(expiresAt: number) {
	return {
		claudeAiOauth: {
			accessToken: "oauth-access-token-test",
			refreshToken: "oauth-refresh-token-test",
			expiresAt,
			scopes: ["user:inference", "user:profile"],
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_20x",
		},
		organizationUuid: "test-org-uuid",
	};
}

interface FakeChild {
	child: WarmupChild;
	signals: string[];
	exit: (code?: number | null) => void;
	isAlive: () => boolean;
}

function makeFakeChild(pid = 12345): FakeChild {
	let closeCb: ((code: number | null) => void) | null = null;
	let closed = false;
	const signals: string[] = [];

	const doClose = (code: number | null) => {
		if (closed) return;
		closed = true;
		queueMicrotask(() => closeCb?.(code));
	};

	const child: WarmupChild = {
		pid,
		kill: (signal) => {
			signals.push(String(signal ?? "SIGTERM"));
			doClose(signal === "SIGKILL" ? 137 : 0);
		},
		onClose: (cb) => {
			closeCb = cb;
			if (closed) queueMicrotask(() => cb(0));
		},
	};

	return {
		child,
		signals,
		exit: (code = 0) => doClose(code),
		isAlive: () => !closed,
	};
}

/** Touch the mtime of a file to simulate the CLI having written to it. */
function bumpMtime(path: string) {
	const now = Date.now() / 1000;
	utimesSync(path, now, now);
}

// ---------------------------------------------------------------------------
// _isExpired
// ---------------------------------------------------------------------------

describe("_isExpired", () => {
	it("returns false for tokens well in the future", () => {
		expect(_isExpired(Date.now() + 60 * 60 * 1000)).toBe(false);
	});

	it("returns true for tokens already expired", () => {
		expect(_isExpired(Date.now() - 1000)).toBe(true);
	});

	it("returns true for tokens within the buffer window", () => {
		expect(_isExpired(Date.now() + EXPIRY_BUFFER_MS - 1000)).toBe(true);
	});

	it("handles epoch-seconds format", () => {
		expect(_isExpired(Math.floor(Date.now() / 1000) - 60)).toBe(true);
		expect(_isExpired(Math.floor(Date.now() / 1000) + 7200)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// ensureFreshCliToken
// ---------------------------------------------------------------------------

describe("ensureFreshCliToken", () => {
	const originalHome = process.env.HOME;
	let fakeHome: string;
	let credsPath: string;

	beforeEach(() => {
		fakeHome = join(originalHome ?? "/tmp", ".claude-test-cli-warmup");
		rmSync(join(fakeHome, ".claude"), { recursive: true, force: true });
		mkdirSync(join(fakeHome, ".claude"), { recursive: true });
		process.env.HOME = fakeHome;
		credsPath = join(fakeHome, ".claude", ".credentials.json");
	});

	afterEach(() => {
		process.env.HOME = originalHome;
		vi.restoreAllMocks();
	});

	it("returns immediately without spawning when token is valid", async () => {
		writeFileSync(
			credsPath,
			JSON.stringify(makeCredentials(Date.now() + 60 * 60 * 1000)),
		);
		const spawner = vi.fn(() => makeFakeChild().child);

		await ensureFreshCliToken(mockLogger(), {
			spawn: spawner,
			pollIntervalMs: 5,
			timeoutMs: 200,
		});

		expect(spawner).not.toHaveBeenCalled();
	});

	it("returns immediately when credentials file is missing", async () => {
		const spawner = vi.fn(() => makeFakeChild().child);
		const log = mockLogger();

		await ensureFreshCliToken(log, {
			spawn: spawner,
			pollIntervalMs: 5,
			timeoutMs: 200,
		});

		expect(spawner).not.toHaveBeenCalled();
		expect(log.warn).toHaveBeenCalled();
	});

	it("spawns warmup and terminates on mtime bump (SIGTERM path)", async () => {
		writeFileSync(
			credsPath,
			JSON.stringify(makeCredentials(Date.now() - 1000)),
		);
		// Back-date the existing mtime so our bump is detectably newer.
		const past = (Date.now() - 5000) / 1000;
		utimesSync(credsPath, past, past);

		const fake = makeFakeChild();
		const spawner = vi.fn(() => fake.child);

		// Bump mtime shortly after spawn — simulates the CLI writing fresh creds.
		setTimeout(() => bumpMtime(credsPath), 30);

		const log = mockLogger();
		await ensureFreshCliToken(log, {
			spawn: spawner,
			pollIntervalMs: 5,
			timeoutMs: 1_000,
		});

		expect(spawner).toHaveBeenCalledTimes(1);
		expect(fake.signals).toContain("SIGTERM");
		expect(fake.isAlive()).toBe(false);
		expect(log.info).toHaveBeenCalledWith(
			expect.any(Object),
			expect.stringContaining("credentials refreshed"),
		);
	});

	it("kills with SIGKILL on timeout (soft success, resolves)", async () => {
		writeFileSync(
			credsPath,
			JSON.stringify(makeCredentials(Date.now() - 1000)),
		);

		const fake = makeFakeChild();
		const spawner = vi.fn(() => fake.child);

		const log = mockLogger();
		// Tight timeout, mtime never bumps — timeout branch.
		await ensureFreshCliToken(log, {
			spawn: spawner,
			pollIntervalMs: 5,
			timeoutMs: 50,
		});

		expect(spawner).toHaveBeenCalledTimes(1);
		expect(fake.signals).toContain("SIGKILL");
		expect(log.warn).toHaveBeenCalledWith(
			expect.any(Object),
			expect.stringContaining("timed out"),
		);
	});

	it("handles natural subprocess exit before mtime bump", async () => {
		writeFileSync(
			credsPath,
			JSON.stringify(makeCredentials(Date.now() - 1000)),
		);

		const fake = makeFakeChild();
		const spawner = vi.fn(() => fake.child);

		// Exit naturally before any mtime bump — the loop should notice on next tick.
		setTimeout(() => fake.exit(0), 20);

		const log = mockLogger();
		await ensureFreshCliToken(log, {
			spawn: spawner,
			pollIntervalMs: 5,
			timeoutMs: 1_000,
		});

		expect(spawner).toHaveBeenCalledTimes(1);
		expect(fake.signals).toEqual([]); // we never sent a signal
		expect(log.info).toHaveBeenCalledWith(
			expect.any(Object),
			expect.stringContaining("exited naturally"),
		);
	});

	it("coalesces concurrent callers into a single warmup", async () => {
		writeFileSync(
			credsPath,
			JSON.stringify(makeCredentials(Date.now() - 1000)),
		);
		const past = (Date.now() - 5000) / 1000;
		utimesSync(credsPath, past, past);

		const fake = makeFakeChild();
		const spawner = vi.fn(() => fake.child);

		setTimeout(() => bumpMtime(credsPath), 30);

		const p1 = ensureFreshCliToken(mockLogger(), {
			spawn: spawner,
			pollIntervalMs: 5,
			timeoutMs: 1_000,
		});
		const p2 = ensureFreshCliToken(mockLogger(), {
			spawn: spawner,
			pollIntervalMs: 5,
			timeoutMs: 1_000,
		});
		const p3 = ensureFreshCliToken(mockLogger(), {
			spawn: spawner,
			pollIntervalMs: 5,
			timeoutMs: 1_000,
		});

		await Promise.all([p1, p2, p3]);

		expect(spawner).toHaveBeenCalledTimes(1);
	});

	it("allows a fresh warmup after the previous one completed", async () => {
		writeFileSync(
			credsPath,
			JSON.stringify(makeCredentials(Date.now() - 1000)),
		);
		const past = (Date.now() - 5000) / 1000;
		utimesSync(credsPath, past, past);

		const fake1 = makeFakeChild();
		const fake2 = makeFakeChild(12346);
		const spawner = vi
			.fn<() => WarmupChild>()
			.mockReturnValueOnce(fake1.child)
			.mockReturnValueOnce(fake2.child);

		setTimeout(() => bumpMtime(credsPath), 20);

		await ensureFreshCliToken(mockLogger(), {
			spawn: spawner,
			pollIntervalMs: 5,
			timeoutMs: 1_000,
		});

		// Token is still "expired" on disk — inflight is cleared, so a second
		// call should spawn again.
		const past2 = (Date.now() - 100) / 1000;
		utimesSync(credsPath, past2, past2);
		setTimeout(() => bumpMtime(credsPath), 20);

		await ensureFreshCliToken(mockLogger(), {
			spawn: spawner,
			pollIntervalMs: 5,
			timeoutMs: 1_000,
		});

		expect(spawner).toHaveBeenCalledTimes(2);
	});
});
