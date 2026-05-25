import { describe, expect, it } from "vitest";
import {
	isIdlePromptNotification,
	translateTranscriptRecord,
} from "../claude-interactive-bridge.js";

describe("translateTranscriptRecord", () => {
	it("maps assistant text and tool_use blocks to backend events", () => {
		const events = translateTranscriptRecord({
			type: "assistant",
			uuid: "assistant-1",
			sessionId: "session-1",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Looking now." },
					{
						type: "tool_use",
						id: "toolu_1",
						name: "Read",
						input: { file_path: "/tmp/a.txt" },
					},
				],
			},
		});

		expect(events).toEqual([
			{ type: "text_delta", content: "Looking now." },
			{
				type: "tool_use",
				toolUseId: "toolu_1",
				toolName: "Read",
				input: '{"file_path":"/tmp/a.txt"}',
			},
		]);
	});

	it("maps user tool_result blocks to backend events", () => {
		const events = translateTranscriptRecord({
			type: "user",
			uuid: "tool-result-1",
			sessionId: "session-1",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: "file contents",
						is_error: false,
					},
				],
			},
		});

		expect(events).toEqual([
			{
				type: "tool_result",
				toolUseId: "toolu_1",
				output: "file contents",
				isError: false,
			},
		]);
	});
});

describe("isIdlePromptNotification", () => {
	it("recognizes Claude idle prompt notifications", () => {
		expect(
			isIdlePromptNotification({
				notification_type: "idle_prompt",
				message: "Claude is waiting for your input",
			}),
		).toBe(true);
	});

	it("recognizes waiting-for-input notification text", () => {
		expect(
			isIdlePromptNotification({
				message: "Claude is waiting for your input",
			}),
		).toBe(true);
	});

	it("ignores unrelated notifications", () => {
		expect(
			isIdlePromptNotification({
				notification_type: "other",
				message: "Background task completed",
			}),
		).toBe(false);
	});
});
