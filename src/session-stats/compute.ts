import { countCompactions, countMidTaskCompactions } from "./compaction.js";
import { classifyOutcome } from "./outcome.js";
import type { RecorderSnapshot } from "./recorder.js";
import { computeHealthScore } from "./score.js";
import { classifyTermination } from "./termination.js";
import { accumulateTokens } from "./tokens.js";
import { computeToolHealth, countEditChurn } from "./tool-health.js";
import type {
	ComputedSignals,
	MessageRecord,
	ToolCallRecord,
} from "./types.js";

export function computeAllSignals(snap: RecorderSnapshot): ComputedSignals {
	const messages = snap.currentMessage
		? [...snap.messages, snap.currentMessage]
		: snap.messages;
	const isAlive = snap.endedAt === null;

	const tokens = accumulateTokens(messages);
	const allCalls = flattenToolCalls(messages);
	const tools = computeToolHealth(allCalls);
	const editChurn = countEditChurn(allCalls);
	const compactionCount = countCompactions(messages);
	const midTaskCompactionCount = countMidTaskCompactions(messages);
	const termination = classifyTermination(messages, isAlive);

	const userMessageCount = messages.filter((m) => m.role === "user").length;
	const isAutomated = detectAutomated(snap.conversationId, userMessageCount);
	const turns = messages.filter(
		(m) => m.role === "assistant" && m.outputTokens !== null,
	).length;

	const last = messages[messages.length - 1];
	const endedWithRole = last?.role ?? null;
	const lastAssistantText = findLastAssistantText(messages);

	const outcome = classifyOutcome({
		isAutomated,
		messageCount: messages.length,
		endedWithRole,
		finalFailureStreak: tools.finalFailureStreak,
		lastAssistantText,
		lastActivity: snap.lastActivityAt,
		now: Date.now(),
	});

	const health = computeHealthScore({
		outcome: outcome.outcome,
		outcomeConfidence: outcome.confidence,
		hasToolCalls: allCalls.length > 0,
		hasContextData: tokens.hasPeakContextTokens,
		toolFailureSignalCount: tools.failureCount,
		toolRetryCount: tools.retryCount,
		editChurnCount: editChurn,
		consecutiveFailureMax: tools.consecutiveMax,
		compactionCount,
		midTaskCompactionCount,
		peakContextTokens: tokens.peakContextTokens,
		contextWindow: snap.contextWindow,
	});

	return {
		conversationId: snap.conversationId,
		backend: snap.backend,
		sessionId: snap.sessionId,
		model: snap.model,
		startedAt: snap.startedAt,
		lastActivityAt: snap.lastActivityAt,
		endedAt: snap.endedAt,
		messageCount: messages.length,
		userMessageCount,
		turns,
		totalOutputTokens: tokens.totalOutputTokens,
		hasTotalOutputTokens: tokens.hasTotalOutputTokens,
		peakContextTokens: tokens.peakContextTokens,
		hasPeakContextTokens: tokens.hasPeakContextTokens,
		totalCostUsd: tokens.totalCostUsd,
		contextWindow: snap.contextWindow,
		toolCallCount: allCalls.length,
		toolFailureSignalCount: tools.failureCount,
		toolRetryCount: tools.retryCount,
		consecutiveFailureMax: tools.consecutiveMax,
		finalFailureStreak: tools.finalFailureStreak,
		editChurnCount: editChurn,
		compactionCount,
		midTaskCompactionCount,
		terminationStatus: termination,
		outcome: outcome.outcome,
		outcomeConfidence: outcome.confidence,
		endedWithRole,
		healthScore: health.score,
		healthGrade: health.grade,
		healthScoreBasis: health.basis,
		healthPenalties: health.penalties,
		isAutomated,
	};
}

function flattenToolCalls(messages: MessageRecord[]): ToolCallRecord[] {
	const out: ToolCallRecord[] = [];
	for (const m of messages) {
		for (const c of m.toolCalls) out.push(c);
	}
	return out;
}

function findLastAssistantText(messages: MessageRecord[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m) continue;
		if (m.role === "assistant" && m.textContent) return m.textContent;
	}
	return "";
}

function detectAutomated(
	conversationId: string,
	userMessageCount: number,
): boolean {
	if (conversationId.startsWith("cron:")) return true;
	if (userMessageCount > 1) return false;
	return false;
}
