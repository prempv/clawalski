import type { MessageRecord } from "./types.js";

const COMPACTION_DROP_RATIO = 0.7;
const BEFORE_WINDOW = 10;
const AFTER_WINDOW = 5;

export function findCompactionBoundaries(messages: MessageRecord[]): number[] {
	const explicit: number[] = [];
	for (const m of messages) {
		if (m.isCompactBoundary) explicit.push(m.ordinal);
	}
	if (explicit.length > 0) return explicit;

	const heuristic: number[] = [];
	let prev: number | null = null;
	for (const m of messages) {
		if (m.role !== "assistant" || m.contextTokens === null) continue;
		if (prev !== null && m.contextTokens < prev * COMPACTION_DROP_RATIO) {
			heuristic.push(m.ordinal);
		}
		prev = m.contextTokens;
	}
	return heuristic;
}

export function countCompactions(messages: MessageRecord[]): number {
	return findCompactionBoundaries(messages).length;
}

export function countMidTaskCompactions(messages: MessageRecord[]): number {
	const boundaries = findCompactionBoundaries(messages);
	if (boundaries.length === 0) return 0;

	const calls: { name: string; ordinal: number }[] = [];
	for (const m of messages) {
		for (const c of m.toolCalls) {
			calls.push({ name: c.toolName, ordinal: m.ordinal });
		}
	}
	if (calls.length === 0) return 0;

	let mid = 0;
	for (const b of boundaries) {
		const before = calls.filter((c) => c.ordinal < b).slice(-BEFORE_WINDOW);
		const after = calls.filter((c) => c.ordinal > b).slice(0, AFTER_WINDOW);
		const beforeNames = new Set(before.map((c) => c.name));
		let overlap = 0;
		const seen = new Set<string>();
		for (const c of after) {
			if (seen.has(c.name)) continue;
			seen.add(c.name);
			if (beforeNames.has(c.name)) overlap++;
		}
		if (overlap >= 2) mid++;
	}
	return mid;
}
