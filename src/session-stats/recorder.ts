import type { BackendId, BackendStreamEvent } from "../backend.js";
import { computeAllSignals } from "./compute.js";
import type { ComputedSignals, MessageRecord } from "./types.js";

interface ConversationRecord {
	conversationId: string;
	backend: BackendId;
	sessionId: string | null;
	model: string | null;
	contextWindow: number | null;
	startedAt: number;
	lastActivityAt: number;
	endedAt: number | null;
	messages: MessageRecord[];
	currentMessage: MessageRecord | null;
}

export interface StartArgs {
	conversationId: string;
	backend: BackendId;
	model?: string | null;
	contextWindow?: number | null;
}

export class SessionRecorder {
	private records = new Map<string, ConversationRecord>();

	start(args: StartArgs): void {
		const now = Date.now();
		const existing = this.records.get(args.conversationId);
		if (existing) {
			// Live recorder being re-armed (e.g. backend switch). Preserve prior
			// messages so /stats remains useful across the transition; reset the
			// active partial message and bump activity.
			existing.backend = args.backend;
			if (args.model !== undefined) existing.model = args.model;
			if (args.contextWindow !== undefined) {
				existing.contextWindow = args.contextWindow;
			}
			existing.lastActivityAt = now;
			existing.endedAt = null;
			existing.currentMessage = null;
			return;
		}
		this.records.set(args.conversationId, {
			conversationId: args.conversationId,
			backend: args.backend,
			sessionId: null,
			model: args.model ?? null,
			contextWindow: args.contextWindow ?? null,
			startedAt: now,
			lastActivityAt: now,
			endedAt: null,
			messages: [],
			currentMessage: null,
		});
	}

	recordUserInput(conversationId: string, text: string): void {
		const r = this.records.get(conversationId);
		if (!r) return;
		this.flushCurrent(r);
		const now = Date.now();
		r.lastActivityAt = now;
		r.messages.push({
			ordinal: r.messages.length,
			role: "user",
			timestamp: now,
			textContent: text,
			outputTokens: null,
			contextTokens: null,
			costUsd: null,
			toolCalls: [],
			isCompactBoundary: false,
			stopReason: null,
		});
	}

	recordEvent(conversationId: string, event: BackendStreamEvent): void {
		const r = this.records.get(conversationId);
		if (!r) return;
		r.lastActivityAt = Date.now();

		switch (event.type) {
			case "session_meta":
				r.model = event.model;
				return;
			case "text_delta":
				this.ensureCurrent(r).textContent += event.content;
				return;
			case "tool_use": {
				const cur = this.ensureCurrent(r);
				cur.toolCalls.push({
					toolUseId: event.toolUseId,
					toolName: event.toolName,
					inputJson: event.input,
					output: "",
					isError: false,
					status: "in_progress",
					messageOrdinal: cur.ordinal,
				});
				return;
			}
			case "tool_result": {
				if (this.attachToolResult(r.currentMessage, event)) return;
				for (let i = r.messages.length - 1; i >= 0; i--) {
					const msg = r.messages[i];
					if (!msg) continue;
					if (this.attachToolResult(msg, event)) return;
				}
				return;
			}
			case "turn_complete": {
				if (event.sessionId) r.sessionId = event.sessionId;
				if (event.contextWindow != null) r.contextWindow = event.contextWindow;
				const cur = r.currentMessage;
				if (cur) {
					cur.outputTokens = event.outputTokens ?? null;
					cur.contextTokens = event.inputTokens ?? null;
					cur.costUsd = event.costUsd ?? null;
					r.messages.push(cur);
					r.currentMessage = null;
				}
				return;
			}
			case "error": {
				if (event.sessionId) r.sessionId = event.sessionId;
				this.flushCurrent(r);
				return;
			}
			case "thinking_delta":
				return;
		}
	}

	end(conversationId: string): void {
		const r = this.records.get(conversationId);
		if (!r) return;
		this.flushCurrent(r);
		r.endedAt = Date.now();
	}

	delete(conversationId: string): void {
		this.records.delete(conversationId);
	}

	has(conversationId: string): boolean {
		return this.records.has(conversationId);
	}

	compute(conversationId: string): ComputedSignals | null {
		const r = this.records.get(conversationId);
		if (!r) return null;
		return computeAllSignals({
			conversationId: r.conversationId,
			backend: r.backend,
			sessionId: r.sessionId,
			model: r.model,
			contextWindow: r.contextWindow,
			startedAt: r.startedAt,
			lastActivityAt: r.lastActivityAt,
			endedAt: r.endedAt,
			messages: r.messages,
			currentMessage: r.currentMessage,
		});
	}

	private ensureCurrent(r: ConversationRecord): MessageRecord {
		if (r.currentMessage) return r.currentMessage;
		const cur: MessageRecord = {
			ordinal: r.messages.length,
			role: "assistant",
			timestamp: Date.now(),
			textContent: "",
			outputTokens: null,
			contextTokens: null,
			costUsd: null,
			toolCalls: [],
			isCompactBoundary: false,
			stopReason: null,
		};
		r.currentMessage = cur;
		return cur;
	}

	private flushCurrent(r: ConversationRecord): void {
		if (!r.currentMessage) return;
		r.messages.push(r.currentMessage);
		r.currentMessage = null;
	}

	private attachToolResult(
		msg: MessageRecord | null,
		event: { toolUseId: string; output: string; isError: boolean },
	): boolean {
		if (!msg) return false;
		const idx = msg.toolCalls.findIndex((c) => c.toolUseId === event.toolUseId);
		if (idx === -1) return false;
		const call = msg.toolCalls[idx];
		if (!call) return false;
		call.output = event.output;
		call.isError = event.isError;
		call.status = "completed";
		return true;
	}
}

export interface RecorderSnapshot {
	conversationId: string;
	backend: BackendId;
	sessionId: string | null;
	model: string | null;
	contextWindow: number | null;
	startedAt: number;
	lastActivityAt: number;
	endedAt: number | null;
	messages: MessageRecord[];
	currentMessage: MessageRecord | null;
}
