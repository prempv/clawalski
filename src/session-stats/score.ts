import type {
	HealthGrade,
	HealthScoreBasis,
	Outcome,
	OutcomeConfidence,
} from "./types.js";

export interface ScoreInput {
	outcome: Outcome;
	outcomeConfidence: OutcomeConfidence;
	hasToolCalls: boolean;
	hasContextData: boolean;
	toolFailureSignalCount: number;
	toolRetryCount: number;
	editChurnCount: number;
	consecutiveFailureMax: number;
	compactionCount: number;
	midTaskCompactionCount: number;
	peakContextTokens: number;
	contextWindow: number | null;
}

export interface ScoreResult {
	score: number | null;
	grade: HealthGrade | null;
	basis: HealthScoreBasis[];
	penalties: Record<string, number>;
}

export function computeHealthScore(input: ScoreInput): ScoreResult {
	const basis: HealthScoreBasis[] = ["outcome"];
	if (input.hasToolCalls) basis.push("tool_health");
	if (input.hasContextData) basis.push("context_pressure");

	if (
		input.outcome === "unknown" &&
		input.outcomeConfidence === "low" &&
		basis.length === 1
	) {
		return { score: null, grade: null, basis, penalties: {} };
	}

	let score = 100;
	const penalties: Record<string, number> = {};

	if (input.outcome === "errored") {
		penalties.outcome_errored = 30;
		score -= 30;
	} else if (input.outcome === "abandoned") {
		penalties.outcome_abandoned = 15;
		score -= 15;
	}

	const failurePenalty = Math.min(input.toolFailureSignalCount * 3, 30);
	if (failurePenalty > 0) {
		penalties.tool_failures = failurePenalty;
		score -= failurePenalty;
	}
	const retryPenalty = Math.min(input.toolRetryCount * 5, 25);
	if (retryPenalty > 0) {
		penalties.tool_retries = retryPenalty;
		score -= retryPenalty;
	}
	const churnPenalty = Math.min(input.editChurnCount * 4, 20);
	if (churnPenalty > 0) {
		penalties.edit_churn = churnPenalty;
		score -= churnPenalty;
	}
	if (input.consecutiveFailureMax >= 3) {
		penalties.consecutive_failures = 10;
		score -= 10;
	}
	if (input.compactionCount >= 2) {
		const p = Math.min((input.compactionCount - 1) * 5, 15);
		penalties.compactions = p;
		score -= p;
	}
	if (input.midTaskCompactionCount > 0) {
		const p = Math.min(input.midTaskCompactionCount * 8, 18);
		penalties.mid_task_compactions = p;
		score -= p;
	}
	if (
		input.contextWindow !== null &&
		input.contextWindow > 0 &&
		input.peakContextTokens / input.contextWindow > 0.9
	) {
		penalties.context_pressure_high = 10;
		score -= 10;
	}

	if (score < 0) score = 0;

	const grade: HealthGrade =
		score >= 90
			? "A"
			: score >= 75
				? "B"
				: score >= 60
					? "C"
					: score >= 40
						? "D"
						: "F";

	return { score, grade, basis, penalties };
}
