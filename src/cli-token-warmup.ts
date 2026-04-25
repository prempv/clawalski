import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CredentialsFile {
	claudeAiOauth?: {
		expiresAt?: number;
	};
}

/**
 * Minimal surface we need from a warmup subprocess. Implemented by
 * the default `node:child_process` spawner, and by fakes in tests.
 */
export interface WarmupChild {
	pid: number | undefined;
	kill(signal?: NodeJS.Signals | number): void;
	onClose(cb: (code: number | null) => void): void;
}

export type WarmupSpawner = () => WarmupChild;

export interface WarmupOptions {
	/** Override the subprocess spawner (used in tests). */
	spawn?: WarmupSpawner;
	/** Max time to wait for the CLI to refresh the token. Default 20s. */
	timeoutMs?: number;
	/** How often to poll `~/.claude/.credentials.json` mtime. Default 100ms. */
	pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Refresh if the token will expire within this window. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function credentialsPath(): string {
	const home = process.env.HOME ?? "/home/dev";
	return join(home, ".claude", ".credentials.json");
}

function readExpiry(path: string): number | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as CredentialsFile;
		return parsed.claudeAiOauth?.expiresAt ?? null;
	} catch {
		return null;
	}
}

function isExpired(expiresAt: number): boolean {
	// expiresAt may be stored in epoch ms or epoch s depending on the writer.
	const expiresMs = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
	return Date.now() + EXPIRY_BUFFER_MS >= expiresMs;
}

function statMtimeMs(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Default warmup spawner. Runs `claude ping` in interactive mode (no
 * `-p`) — interactive startup is the code path that actually performs
 * the OAuth refresh; pipe mode does not.
 *
 * We set `CLAUDE_CODE_SANDBOXED=1` to bypass the workspace trust dialog
 * (which only appears in non-`-p` mode). The subprocess is not placed
 * under landrun, since it needs to write `~/.claude/.credentials.json`
 * and we want zero filesystem constraints on the refresh path.
 */
function defaultSpawner(): WarmupChild {
	const child = spawn("claude", ["ping"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, CLAUDE_CODE_SANDBOXED: "1" },
	});
	// Without an 'error' listener, a spawn failure (ENOENT when claude is off
	// PATH, EACCES, etc.) crashes the whole Node process. The child still
	// emits 'close' after 'error', so runWarmup's existing exit path handles
	// cleanup on its own.
	child.on("error", () => {});
	// Drain stdout/stderr so the child doesn't block on full pipes.
	child.stdout?.resume();
	child.stderr?.resume();
	return {
		pid: child.pid,
		kill: (signal) => {
			try {
				child.kill(signal);
			} catch {
				// ignore — child may already be dead
			}
		},
		onClose: (cb) => {
			child.once("close", cb);
		},
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let inflight: Promise<void> | null = null;

/**
 * Ensure the OAuth credentials on disk are fresh enough for the next
 * Claude CLI subprocess spawn. If the cached access token has already
 * expired (or will expire within {@link EXPIRY_BUFFER_MS}), this spawns
 * a throwaway `claude ping` in interactive mode — long enough for the
 * CLI's own startup lifecycle to hit the OAuth refresh endpoint and
 * write the new credentials to disk — then terminates it.
 *
 * We intentionally go through the real CLI rather than POSTing to
 * `/v1/oauth/token` ourselves: Anthropic appears to rate-limit or
 * otherwise block direct client calls to that endpoint.
 *
 * Concurrent callers are coalesced into a single warmup via
 * `inflight`, so a burst of Telegram messages does not spawn multiple
 * warmups. Resolves as a soft success on timeout or unexpected errors
 * — the existing `sendMessageWithAuthRetry` safety net will still try
 * to handle any surviving 401s.
 */
export async function ensureFreshCliToken(
	log: Logger,
	options: WarmupOptions = {},
): Promise<void> {
	const path = credentialsPath();
	const expiresAt = readExpiry(path);

	if (expiresAt === null) {
		log.warn({ path }, "could not read credentials — skipping CLI warmup");
		return;
	}

	if (!isExpired(expiresAt)) {
		return;
	}

	if (inflight) return inflight;

	inflight = runWarmup(log, path, options).finally(() => {
		inflight = null;
	});

	return inflight;
}

async function runWarmup(
	log: Logger,
	path: string,
	options: WarmupOptions,
): Promise<void> {
	const spawner = options.spawn ?? defaultSpawner;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

	const beforeMtime = statMtimeMs(path);
	const start = Date.now();
	log.info("OAuth token expired — spawning claude CLI warmup to refresh");

	let child: WarmupChild;
	try {
		child = spawner();
	} catch (err) {
		log.error({ err }, "failed to spawn claude CLI warmup — proceeding anyway");
		return;
	}

	let exited = false;
	let exitCode: number | null = null;
	const exitPromise = new Promise<void>((resolve) => {
		child.onClose((code) => {
			exited = true;
			exitCode = code;
			resolve();
		});
	});

	const killAndWait = async (signal: NodeJS.Signals) => {
		child.kill(signal);
		await exitPromise;
	};

	try {
		while (true) {
			if (exited) {
				const afterMtime = statMtimeMs(path);
				const refreshed =
					afterMtime !== null &&
					beforeMtime !== null &&
					afterMtime > beforeMtime;
				log.info(
					{ exitCode, elapsedMs: Date.now() - start, refreshed },
					"CLI warmup exited naturally",
				);
				return;
			}

			if (Date.now() - start >= timeoutMs) {
				log.warn(
					{ elapsedMs: Date.now() - start },
					"CLI warmup timed out — SIGKILL and proceeding",
				);
				await killAndWait("SIGKILL");
				return;
			}

			const currentMtime = statMtimeMs(path);
			if (
				currentMtime !== null &&
				beforeMtime !== null &&
				currentMtime > beforeMtime
			) {
				log.info(
					{ elapsedMs: Date.now() - start },
					"credentials refreshed by CLI warmup — terminating",
				);
				await killAndWait("SIGTERM");
				return;
			}

			await sleep(pollIntervalMs);
		}
	} catch (err) {
		log.error({ err }, "CLI warmup unexpected error — killing child");
		try {
			await killAndWait("SIGKILL");
		} catch {
			// ignore
		}
	}
}

// Exported for testing
export {
	isExpired as _isExpired,
	credentialsPath as _credentialsPath,
	EXPIRY_BUFFER_MS,
};
