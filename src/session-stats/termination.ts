import type { MessageRecord, TerminationStatus } from "./types.js";

export function classifyTermination(
	messages: MessageRecord[],
	isAlive: boolean,
): TerminationStatus {
	if (messages.length === 0) {
		return isAlive ? "unknown" : "clean";
	}

	for (const m of messages) {
		for (const c of m.toolCalls) {
			if (c.status === "in_progress") return "tool_call_pending";
		}
	}

	const last = messages[messages.length - 1];
	if (!last) return "unknown";
	if (!isAlive) return "clean";
	if (last.role === "assistant") return "awaiting_user";
	return "unknown";
}
