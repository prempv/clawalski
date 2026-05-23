import type { Outcome, OutcomeConfidence } from "./types.js";

const RECENCY_WINDOW_MS = 10 * 60 * 1000;

const GIVE_UP_PATTERNS: RegExp[] = [
	/i'm unable to/i,
	/i can't proceed/i,
	/i don't have access/i,
	/i cannot proceed/i,
	/i am unable to/i,
];

export interface OutcomeInput {
	isAutomated: boolean;
	messageCount: number;
	endedWithRole: "user" | "assistant" | null;
	finalFailureStreak: number;
	lastAssistantText: string;
	lastActivity: number;
	now: number;
}

export interface OutcomeResult {
	outcome: Outcome;
	confidence: OutcomeConfidence;
	isRecent: boolean;
}

export function classifyOutcome(input: OutcomeInput): OutcomeResult {
	if (input.isAutomated) {
		return { outcome: "unknown", confidence: "low", isRecent: false };
	}
	if (input.messageCount === 2 && input.endedWithRole === "assistant") {
		return { outcome: "completed", confidence: "medium", isRecent: false };
	}
	if (input.messageCount < 3) {
		return { outcome: "unknown", confidence: "low", isRecent: false };
	}
	if (input.now - input.lastActivity < RECENCY_WINDOW_MS) {
		return { outcome: "unknown", confidence: "low", isRecent: true };
	}
	if (input.endedWithRole === "user") {
		const conf: OutcomeConfidence =
			input.messageCount >= 10 ? "high" : "medium";
		return { outcome: "abandoned", confidence: conf, isRecent: false };
	}
	if (input.finalFailureStreak >= 3) {
		return { outcome: "errored", confidence: "medium", isRecent: false };
	}
	if (input.endedWithRole === "assistant") {
		const giveUp = GIVE_UP_PATTERNS.some((re) =>
			re.test(input.lastAssistantText),
		);
		return {
			outcome: "completed",
			confidence: giveUp ? "low" : "medium",
			isRecent: false,
		};
	}
	return { outcome: "unknown", confidence: "low", isRecent: false };
}
