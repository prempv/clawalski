import type { BackendId } from "../backend.js";

export interface ToolCallRecord {
	toolUseId: string;
	toolName: string;
	inputJson: string;
	output: string;
	isError: boolean;
	status: "in_progress" | "completed";
	messageOrdinal: number;
}

export interface MessageRecord {
	ordinal: number;
	role: "user" | "assistant";
	timestamp: number;
	textContent: string;
	outputTokens: number | null;
	contextTokens: number | null;
	costUsd: number | null;
	toolCalls: ToolCallRecord[];
	isCompactBoundary: boolean;
	stopReason: string | null;
}

export type TerminationStatus =
	| "awaiting_user"
	| "tool_call_pending"
	| "clean"
	| "truncated"
	| "unknown";

export type Outcome = "completed" | "abandoned" | "errored" | "unknown";
export type OutcomeConfidence = "low" | "medium" | "high";
export type HealthGrade = "A" | "B" | "C" | "D" | "F";
export type HealthScoreBasis = "outcome" | "tool_health" | "context_pressure";

export interface ComputedSignals {
	conversationId: string;
	backend: BackendId;
	sessionId: string | null;
	model: string | null;
	startedAt: number;
	lastActivityAt: number;
	endedAt: number | null;
	messageCount: number;
	userMessageCount: number;
	turns: number;
	totalOutputTokens: number;
	hasTotalOutputTokens: boolean;
	peakContextTokens: number;
	hasPeakContextTokens: boolean;
	totalCostUsd: number | null;
	contextWindow: number | null;
	toolCallCount: number;
	toolFailureSignalCount: number;
	toolRetryCount: number;
	consecutiveFailureMax: number;
	finalFailureStreak: number;
	editChurnCount: number;
	compactionCount: number;
	midTaskCompactionCount: number;
	terminationStatus: TerminationStatus;
	outcome: Outcome;
	outcomeConfidence: OutcomeConfidence;
	endedWithRole: "user" | "assistant" | null;
	healthScore: number | null;
	healthGrade: HealthGrade | null;
	healthScoreBasis: HealthScoreBasis[];
	healthPenalties: Record<string, number>;
	isAutomated: boolean;
}
