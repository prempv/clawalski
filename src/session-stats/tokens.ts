import type { MessageRecord } from "./types.js";

export interface TokenAccumulation {
	totalOutputTokens: number;
	hasTotalOutputTokens: boolean;
	peakContextTokens: number;
	hasPeakContextTokens: boolean;
	totalCostUsd: number | null;
}

export function accumulateTokens(messages: MessageRecord[]): TokenAccumulation {
	let totalOutput = 0;
	let hasOutput = false;
	let peakContext = 0;
	let hasContext = false;
	let totalCost: number | null = null;

	for (const m of messages) {
		if (m.outputTokens !== null) {
			totalOutput += m.outputTokens;
			hasOutput = true;
		}
		if (m.contextTokens !== null) {
			if (m.contextTokens > peakContext) peakContext = m.contextTokens;
			hasContext = true;
		}
		// Claude reports `total_cost_usd` as a cumulative session total, so the
		// latest non-null value already represents the running session cost.
		// Codex emits no cost — stays null.
		if (m.costUsd !== null) totalCost = m.costUsd;
	}

	return {
		totalOutputTokens: totalOutput,
		hasTotalOutputTokens: hasOutput,
		peakContextTokens: peakContext,
		hasPeakContextTokens: hasContext,
		totalCostUsd: totalCost,
	};
}
