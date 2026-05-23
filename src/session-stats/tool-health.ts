import type { ToolCallRecord } from "./types.js";

const FAILURE_PATTERNS: RegExp[] = [
	/command not found/i,
	/Permission denied/,
	/Traceback \(most recent call last\):/,
	/^panic: /m,
	/goroutine \d+ \[/,
];
const JS_STACK_TRACE = /(?:^|\n)\s+at .+(?:\n\s+at .+){2,}/;
const EXIT_STATUS_NONZERO = /exit status [1-9]\d*/;

function isToolCallFailure(call: ToolCallRecord): boolean {
	if (call.isError) return true;
	const out = call.output;
	if (!out) return false;
	for (const re of FAILURE_PATTERNS) {
		if (re.test(out)) return true;
	}
	if (JS_STACK_TRACE.test(out)) return true;
	// Bare "exit status N" alone is too noisy (e.g. clean `git diff` returning 1).
	// Require it paired with one of the strong failure signals above — if any
	// fired we'd already have returned true. So an isolated exit status N is
	// only counted when it shows up alongside ANY of the patterns above; since
	// that's already handled, we just require explicit exit-status as a tiebreak
	// for the Edit/Write FAILED literal below.
	if (
		(call.toolName === "Edit" || call.toolName === "Write") &&
		out.includes("FAILED")
	) {
		return true;
	}
	if (call.toolName === "Bash" && EXIT_STATUS_NONZERO.test(out)) {
		// Already covered by isError most of the time; this is a backstop for
		// bridges that surface non-zero exits without setting isError.
		return true;
	}
	return false;
}

export interface ToolHealth {
	failureCount: number;
	consecutiveMax: number;
	retryCount: number;
	finalFailureStreak: number;
}

export function computeToolHealth(calls: ToolCallRecord[]): ToolHealth {
	let failureCount = 0;
	let currentStreak = 0;
	let consecutiveMax = 0;
	for (const c of calls) {
		if (isToolCallFailure(c)) {
			failureCount++;
			currentStreak++;
			if (currentStreak > consecutiveMax) consecutiveMax = currentStreak;
		} else {
			currentStreak = 0;
		}
	}
	return {
		failureCount,
		consecutiveMax,
		retryCount: countRetries(calls),
		finalFailureStreak: countFinalFailureStreak(calls),
	};
}

function countRetries(calls: ToolCallRecord[]): number {
	let total = 0;
	let i = 0;
	while (i < calls.length) {
		let j = i + 1;
		const head = calls[i];
		if (!head) break;
		while (j < calls.length) {
			const next = calls[j];
			if (
				!next ||
				next.toolName !== head.toolName ||
				next.inputJson !== head.inputJson
			) {
				break;
			}
			j++;
		}
		const runLen = j - i;
		if (runLen >= 3) total += runLen - 1;
		i = j > i ? j : i + 1;
	}
	return total;
}

function countFinalFailureStreak(calls: ToolCallRecord[]): number {
	let n = 0;
	for (let i = calls.length - 1; i >= 0; i--) {
		const c = calls[i];
		if (!c) break;
		if (isToolCallFailure(c)) n++;
		else break;
	}
	return n;
}

const FILE_PATH_RE = /"file_path":"([^"\\]*(?:\\.[^"\\]*)*)"/;

export function countEditChurn(calls: ToolCallRecord[]): number {
	const byFile = new Map<string, number[]>();
	for (const c of calls) {
		if (c.toolName !== "Edit" && c.toolName !== "Write") continue;
		const m = FILE_PATH_RE.exec(c.inputJson);
		if (!m?.[1]) continue;
		const file = m[1];
		const list = byFile.get(file) ?? [];
		list.push(c.messageOrdinal);
		byFile.set(file, list);
	}
	let churn = 0;
	for (const ordinals of byFile.values()) {
		ordinals.sort((a, b) => a - b);
		for (let i = 0; i + 2 < ordinals.length; i++) {
			const lo = ordinals[i];
			const hi = ordinals[i + 2];
			if (lo === undefined || hi === undefined) continue;
			if (hi - lo < 10) {
				churn++;
				break;
			}
		}
	}
	return churn;
}
