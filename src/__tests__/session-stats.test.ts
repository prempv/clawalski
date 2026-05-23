import { describe, expect, it } from "vitest";
import {
	countCompactions,
	countMidTaskCompactions,
} from "../session-stats/compaction.js";
import { classifyOutcome } from "../session-stats/outcome.js";
import { SessionRecorder } from "../session-stats/recorder.js";
import { computeHealthScore } from "../session-stats/score.js";
import { classifyTermination } from "../session-stats/termination.js";
import { accumulateTokens } from "../session-stats/tokens.js";
import {
	computeToolHealth,
	countEditChurn,
} from "../session-stats/tool-health.js";
import type { MessageRecord, ToolCallRecord } from "../session-stats/types.js";

function userMsg(ordinal: number, text: string): MessageRecord {
	return {
		ordinal,
		role: "user",
		timestamp: ordinal * 1000,
		textContent: text,
		outputTokens: null,
		contextTokens: null,
		costUsd: null,
		toolCalls: [],
		isCompactBoundary: false,
		stopReason: null,
	};
}

function assistantMsg(
	ordinal: number,
	opts: {
		text?: string;
		outputTokens?: number;
		contextTokens?: number;
		costUsd?: number;
		toolCalls?: ToolCallRecord[];
		isCompactBoundary?: boolean;
	} = {},
): MessageRecord {
	return {
		ordinal,
		role: "assistant",
		timestamp: ordinal * 1000,
		textContent: opts.text ?? "",
		outputTokens: opts.outputTokens ?? null,
		contextTokens: opts.contextTokens ?? null,
		costUsd: opts.costUsd ?? null,
		toolCalls: opts.toolCalls ?? [],
		isCompactBoundary: opts.isCompactBoundary ?? false,
		stopReason: null,
	};
}

function toolCall(
	ordinal: number,
	name: string,
	input: string,
	opts: {
		isError?: boolean;
		output?: string;
		status?: "in_progress" | "completed";
	} = {},
): ToolCallRecord {
	return {
		toolUseId: `${name}-${ordinal}-${input}`,
		toolName: name,
		inputJson: input,
		output: opts.output ?? "",
		isError: opts.isError ?? false,
		status: opts.status ?? "completed",
		messageOrdinal: ordinal,
	};
}

describe("accumulateTokens", () => {
	it("sums output tokens, takes max of context tokens, latest non-null cost", () => {
		const messages: MessageRecord[] = [
			assistantMsg(1, {
				outputTokens: 100,
				contextTokens: 5_000,
				costUsd: 0.01,
			}),
			assistantMsg(2, {
				outputTokens: 200,
				contextTokens: 12_000,
				costUsd: 0.05,
			}),
			assistantMsg(3, { outputTokens: 50, contextTokens: 8_000 }),
		];
		const result = accumulateTokens(messages);
		expect(result.totalOutputTokens).toBe(350);
		expect(result.peakContextTokens).toBe(12_000);
		expect(result.totalCostUsd).toBeCloseTo(0.05);
		expect(result.hasTotalOutputTokens).toBe(true);
		expect(result.hasPeakContextTokens).toBe(true);
	});

	it("flags absence when no token data ever arrived", () => {
		const result = accumulateTokens([userMsg(0, "hi")]);
		expect(result.hasTotalOutputTokens).toBe(false);
		expect(result.hasPeakContextTokens).toBe(false);
		expect(result.totalCostUsd).toBeNull();
	});
});

describe("computeToolHealth", () => {
	it("counts failures via isError flag and tracks consecutive streak", () => {
		const calls = [
			toolCall(1, "Bash", '{"command":"ls"}'),
			toolCall(2, "Bash", '{"command":"cd /missing"}', { isError: true }),
			toolCall(3, "Bash", '{"command":"foo"}', { isError: true }),
			toolCall(4, "Read", '{"file_path":"/a"}'),
			toolCall(5, "Bash", '{"command":"oops"}', { isError: true }),
		];
		const result = computeToolHealth(calls);
		expect(result.failureCount).toBe(3);
		expect(result.consecutiveMax).toBe(2);
		expect(result.finalFailureStreak).toBe(1);
	});

	it("counts content-heuristic failures when isError is missing", () => {
		const calls = [
			toolCall(1, "Bash", '{"command":"npm test"}', {
				output: "Error: command not found",
			}),
			toolCall(2, "Bash", '{"command":"py"}', {
				output: "Traceback (most recent call last):\n  File foo.py",
			}),
		];
		const result = computeToolHealth(calls);
		expect(result.failureCount).toBe(2);
	});

	it("counts retries as runs of >=3 with identical name+input", () => {
		const calls = [
			toolCall(1, "Bash", '{"command":"ls"}'),
			toolCall(2, "Bash", '{"command":"ls"}'),
			toolCall(3, "Bash", '{"command":"ls"}'),
			toolCall(4, "Bash", '{"command":"ls"}'),
			toolCall(5, "Read", '{"file_path":"/x"}'),
			toolCall(6, "Read", '{"file_path":"/x"}'),
		];
		const result = computeToolHealth(calls);
		// One run of length 4 (Bash) → 3 retries; Read has only 2 → 0
		expect(result.retryCount).toBe(3);
	});
});

describe("countEditChurn", () => {
	it("returns 1 when 3 edits to the same file land within 10 ordinals", () => {
		const calls = [
			toolCall(
				1,
				"Edit",
				'{"file_path":"/a/b.ts","old_string":"x","new_string":"y"}',
			),
			toolCall(3, "Edit", '{"file_path":"/a/b.ts"}'),
			toolCall(7, "Edit", '{"file_path":"/a/b.ts"}'),
		];
		expect(countEditChurn(calls)).toBe(1);
	});

	it("returns 0 when edits to the same file are spread out", () => {
		const calls = [
			toolCall(1, "Edit", '{"file_path":"/a/b.ts"}'),
			toolCall(50, "Edit", '{"file_path":"/a/b.ts"}'),
			toolCall(100, "Edit", '{"file_path":"/a/b.ts"}'),
		];
		expect(countEditChurn(calls)).toBe(0);
	});

	it("counts per file once even with many edits", () => {
		const calls = [
			toolCall(1, "Edit", '{"file_path":"/a.ts"}'),
			toolCall(2, "Edit", '{"file_path":"/a.ts"}'),
			toolCall(3, "Edit", '{"file_path":"/a.ts"}'),
			toolCall(4, "Edit", '{"file_path":"/a.ts"}'),
			toolCall(5, "Edit", '{"file_path":"/b.ts"}'),
			toolCall(6, "Edit", '{"file_path":"/b.ts"}'),
			toolCall(7, "Edit", '{"file_path":"/b.ts"}'),
		];
		expect(countEditChurn(calls)).toBe(2);
	});
});

describe("classifyTermination", () => {
	it("returns tool_call_pending when an in_progress tool exists", () => {
		const messages = [
			userMsg(0, "go"),
			assistantMsg(1, {
				toolCalls: [
					toolCall(1, "Bash", '{"command":"x"}', { status: "in_progress" }),
				],
			}),
		];
		expect(classifyTermination(messages, true)).toBe("tool_call_pending");
	});

	it("returns awaiting_user when alive and last message is assistant", () => {
		const messages = [userMsg(0, "go"), assistantMsg(1, { text: "done" })];
		expect(classifyTermination(messages, true)).toBe("awaiting_user");
	});

	it("returns clean when not alive", () => {
		const messages = [userMsg(0, "go"), assistantMsg(1, { text: "done" })];
		expect(classifyTermination(messages, false)).toBe("clean");
	});

	it("returns unknown when alive and last message is user", () => {
		const messages = [userMsg(0, "go")];
		expect(classifyTermination(messages, true)).toBe("unknown");
	});
});

describe("classifyOutcome", () => {
	const baseInput = {
		isAutomated: false,
		messageCount: 6,
		endedWithRole: "assistant" as "assistant" | "user" | null,
		finalFailureStreak: 0,
		lastAssistantText: "All set.",
		lastActivity: 0,
		now: 60 * 60 * 1000,
	};

	it("flags automated as unknown/low", () => {
		const r = classifyOutcome({ ...baseInput, isAutomated: true });
		expect(r.outcome).toBe("unknown");
		expect(r.confidence).toBe("low");
	});

	it("treats 2-message exchanges as completed/medium", () => {
		const r = classifyOutcome({ ...baseInput, messageCount: 2 });
		expect(r.outcome).toBe("completed");
		expect(r.confidence).toBe("medium");
	});

	it("flags recent activity as unknown/low/recent", () => {
		const r = classifyOutcome({ ...baseInput, now: 60_000 });
		expect(r.isRecent).toBe(true);
		expect(r.outcome).toBe("unknown");
	});

	it("classifies user-ended long sessions as abandoned/high", () => {
		const r = classifyOutcome({
			...baseInput,
			endedWithRole: "user",
			messageCount: 12,
		});
		expect(r.outcome).toBe("abandoned");
		expect(r.confidence).toBe("high");
	});

	it("classifies final failure streak >= 3 as errored", () => {
		const r = classifyOutcome({ ...baseInput, finalFailureStreak: 3 });
		expect(r.outcome).toBe("errored");
	});

	it("downgrades completed to low when last assistant text gives up", () => {
		const r = classifyOutcome({
			...baseInput,
			lastAssistantText: "I'm unable to continue without access.",
		});
		expect(r.outcome).toBe("completed");
		expect(r.confidence).toBe("low");
	});
});

describe("computeHealthScore", () => {
	const baseInput = {
		outcome: "completed" as const,
		outcomeConfidence: "medium" as const,
		hasToolCalls: true,
		hasContextData: true,
		toolFailureSignalCount: 0,
		toolRetryCount: 0,
		editChurnCount: 0,
		consecutiveFailureMax: 0,
		compactionCount: 0,
		midTaskCompactionCount: 0,
		peakContextTokens: 0,
		contextWindow: 200_000,
	};

	it("starts at 100 / grade A with no penalties", () => {
		const r = computeHealthScore(baseInput);
		expect(r.score).toBe(100);
		expect(r.grade).toBe("A");
		expect(r.basis).toEqual(["outcome", "tool_health", "context_pressure"]);
	});

	it("caps tool retry penalty at 25", () => {
		const r = computeHealthScore({ ...baseInput, toolRetryCount: 100 });
		expect(r.score).toBe(75);
		expect(r.grade).toBe("B");
	});

	it("does not penalize a single compaction (free)", () => {
		const r = computeHealthScore({ ...baseInput, compactionCount: 1 });
		expect(r.score).toBe(100);
	});

	it("penalizes mid-task compactions heavily", () => {
		const r = computeHealthScore({
			...baseInput,
			midTaskCompactionCount: 1,
		});
		expect(r.score).toBe(92);
	});

	it("flags context pressure when peak > 90% of window", () => {
		const r = computeHealthScore({
			...baseInput,
			peakContextTokens: 195_000,
		});
		expect(r.penalties.context_pressure_high).toBe(10);
		expect(r.score).toBe(90);
	});

	it("yields F for fully degraded sessions", () => {
		const r = computeHealthScore({
			...baseInput,
			outcome: "errored",
			toolFailureSignalCount: 20,
			toolRetryCount: 20,
			editChurnCount: 20,
			consecutiveFailureMax: 5,
		});
		expect(r.score).toBe(0);
		expect(r.grade).toBe("F");
	});

	it("returns null score when only outcome basis with low-confidence unknown", () => {
		const r = computeHealthScore({
			...baseInput,
			hasToolCalls: false,
			hasContextData: false,
			outcome: "unknown",
			outcomeConfidence: "low",
		});
		expect(r.score).toBeNull();
		expect(r.grade).toBeNull();
	});
});

describe("compactions", () => {
	it("uses explicit boundaries when present", () => {
		const messages = [
			assistantMsg(1, { contextTokens: 80_000 }),
			assistantMsg(2, { contextTokens: 120_000, isCompactBoundary: true }),
			assistantMsg(3, { contextTokens: 50_000 }),
		];
		expect(countCompactions(messages)).toBe(1);
	});

	it("falls back to >=30% drop heuristic", () => {
		const messages = [
			assistantMsg(1, { contextTokens: 100_000 }),
			assistantMsg(2, { contextTokens: 110_000 }),
			assistantMsg(3, { contextTokens: 30_000 }),
			assistantMsg(4, { contextTokens: 35_000 }),
		];
		expect(countCompactions(messages)).toBe(1);
	});

	it("counts mid-task compaction when tool-name overlap >= 2", () => {
		const messages = [
			assistantMsg(1, {
				contextTokens: 100_000,
				toolCalls: [
					toolCall(1, "Read", '{"file_path":"/x"}'),
					toolCall(1, "Edit", '{"file_path":"/x"}'),
					toolCall(1, "Bash", '{"command":"a"}'),
				],
			}),
			assistantMsg(2, {
				contextTokens: 30_000,
				isCompactBoundary: true,
			}),
			assistantMsg(3, {
				toolCalls: [
					toolCall(3, "Read", '{"file_path":"/y"}'),
					toolCall(3, "Edit", '{"file_path":"/y"}'),
				],
			}),
		];
		expect(countMidTaskCompactions(messages)).toBe(1);
	});
});

describe("SessionRecorder end-to-end", () => {
	it("records a full conversation and computes signals", () => {
		const recorder = new SessionRecorder();
		recorder.start({ conversationId: "tg:dm:1", backend: "claude" });
		recorder.recordUserInput("tg:dm:1", "hello");
		recorder.recordEvent("tg:dm:1", {
			type: "session_meta",
			model: "claude-opus-4-7",
		});
		recorder.recordEvent("tg:dm:1", { type: "text_delta", content: "Hi! " });
		recorder.recordEvent("tg:dm:1", {
			type: "tool_use",
			toolUseId: "t1",
			toolName: "Read",
			input: '{"file_path":"/foo"}',
		});
		recorder.recordEvent("tg:dm:1", {
			type: "tool_result",
			toolUseId: "t1",
			output: "ok",
			isError: false,
		});
		recorder.recordEvent("tg:dm:1", {
			type: "turn_complete",
			sessionId: "sess-abc",
			outputTokens: 150,
			inputTokens: 5_000,
			contextWindow: 200_000,
			costUsd: 0.02,
		});

		const signals = recorder.compute("tg:dm:1");
		expect(signals).not.toBeNull();
		if (!signals) throw new Error("expected signals");
		expect(signals.sessionId).toBe("sess-abc");
		expect(signals.model).toBe("claude-opus-4-7");
		expect(signals.totalOutputTokens).toBe(150);
		expect(signals.peakContextTokens).toBe(5_000);
		expect(signals.contextWindow).toBe(200_000);
		expect(signals.totalCostUsd).toBeCloseTo(0.02);
		expect(signals.toolCallCount).toBe(1);
		expect(signals.terminationStatus).toBe("awaiting_user");
		expect(signals.userMessageCount).toBe(1);
		expect(signals.healthGrade).toBe("A");
	});

	it("returns null for unknown conversations", () => {
		const recorder = new SessionRecorder();
		expect(recorder.compute("tg:dm:404")).toBeNull();
	});

	it("flags cron conversations as automated", () => {
		const recorder = new SessionRecorder();
		recorder.start({ conversationId: "cron:job-1", backend: "codex" });
		recorder.recordUserInput("cron:job-1", "do thing");
		recorder.recordEvent("cron:job-1", { type: "text_delta", content: "ok" });
		recorder.recordEvent("cron:job-1", {
			type: "turn_complete",
			outputTokens: 10,
			inputTokens: 100,
		});
		const signals = recorder.compute("cron:job-1");
		if (!signals) throw new Error("expected signals");
		expect(signals.isAutomated).toBe(true);
		expect(signals.outcome).toBe("unknown");
	});

	it("ends a session and reports clean termination", () => {
		const recorder = new SessionRecorder();
		recorder.start({ conversationId: "tg:dm:2", backend: "claude" });
		recorder.recordUserInput("tg:dm:2", "go");
		recorder.recordEvent("tg:dm:2", { type: "text_delta", content: "done" });
		recorder.recordEvent("tg:dm:2", {
			type: "turn_complete",
			outputTokens: 5,
			inputTokens: 100,
		});
		recorder.end("tg:dm:2");
		const signals = recorder.compute("tg:dm:2");
		if (!signals) throw new Error("expected signals");
		expect(signals.endedAt).not.toBeNull();
		expect(signals.terminationStatus).toBe("clean");
	});
});
