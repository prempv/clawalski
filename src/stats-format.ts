import type { ComputedSignals } from "./session-stats/index.js";

const fmt = (n: number): string => n.toLocaleString("en-US");

const TERMINATION_LABELS: Record<ComputedSignals["terminationStatus"], string> =
	{
		awaiting_user: "awaiting user",
		tool_call_pending: "tool call in progress",
		clean: "ended cleanly",
		truncated: "truncated",
		unknown: "unknown",
	};

const OUTCOME_LABELS: Record<ComputedSignals["outcome"], string> = {
	completed: "completed",
	abandoned: "abandoned",
	errored: "errored",
	unknown: "unknown",
};

export function formatStatsMessage(signals: ComputedSignals): string {
	const lines: string[] = ["Session Stats", ""];

	lines.push(`Session: ${signals.sessionId ?? "unknown"}`);
	if (signals.model) lines.push(`Model: ${signals.model}`);

	if (signals.hasPeakContextTokens && signals.contextWindow) {
		const pct = (
			(signals.peakContextTokens / signals.contextWindow) *
			100
		).toFixed(1);
		lines.push(
			`Context peak: ${fmt(signals.peakContextTokens)} / ${fmt(signals.contextWindow)} (${pct}%)`,
		);
	} else if (signals.hasPeakContextTokens) {
		lines.push(`Context peak: ${fmt(signals.peakContextTokens)}`);
	}

	lines.push("");

	if (signals.hasTotalOutputTokens) {
		lines.push(`Output tokens: ${fmt(signals.totalOutputTokens)}`);
	}
	if (signals.totalCostUsd != null) {
		lines.push(`Session cost: $${signals.totalCostUsd.toFixed(4)}`);
	}
	lines.push(`Turns: ${signals.turns}`);
	lines.push(`Messages: ${signals.messageCount}`);
	if (signals.toolCallCount > 0) {
		lines.push(`Tool calls: ${signals.toolCallCount}`);
	}

	const healthLine = formatHealthLine(signals);
	if (healthLine) {
		lines.push("");
		lines.push(healthLine);
	}

	const flags = formatFlagsLine(signals);
	if (flags.length > 0) {
		lines.push(...flags);
	}

	const status = formatStatusLine(signals);
	if (status) {
		lines.push("");
		lines.push(status);
	}

	const ago = Date.now() - signals.startedAt;
	lines.push(`Active since: ${formatDuration(ago)} ago`);

	return lines.join("\n");
}

function formatHealthLine(signals: ComputedSignals): string | null {
	if (signals.healthScore === null || signals.healthGrade === null) return null;
	return `Health: ${signals.healthGrade} (${signals.healthScore}/100)`;
}

function formatFlagsLine(signals: ComputedSignals): string[] {
	const flags: string[] = [];
	if (signals.toolFailureSignalCount > 0) {
		flags.push(`Tool failures: ${signals.toolFailureSignalCount}`);
	}
	if (signals.toolRetryCount > 0) {
		flags.push(`Tool retries: ${signals.toolRetryCount}`);
	}
	if (signals.editChurnCount > 0) {
		flags.push(`Edit churn: ${signals.editChurnCount}`);
	}
	if (signals.compactionCount > 0) {
		const mid =
			signals.midTaskCompactionCount > 0
				? ` (${signals.midTaskCompactionCount} mid-task)`
				: "";
		flags.push(`Compactions: ${signals.compactionCount}${mid}`);
	}
	return flags;
}

function formatStatusLine(signals: ComputedSignals): string | null {
	const parts: string[] = [];
	parts.push(`Status: ${TERMINATION_LABELS[signals.terminationStatus]}`);
	if (signals.outcome !== "unknown" || signals.outcomeConfidence !== "low") {
		parts.push(
			`outcome: ${OUTCOME_LABELS[signals.outcome]} (${signals.outcomeConfidence})`,
		);
	}
	return parts.join(" · ");
}

function formatDuration(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) return `${totalMin}m`;
	const hours = Math.floor(totalMin / 60);
	const mins = totalMin % 60;
	return `${hours}h ${mins}m`;
}
