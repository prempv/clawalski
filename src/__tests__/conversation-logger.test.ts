import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ConversationLogEntry,
	conversationIdToDir,
	createConversationLogger,
	migrateConversationLogs,
} from "../conversation-logger.js";

function makeEntry(
	overrides: Partial<ConversationLogEntry> = {},
): ConversationLogEntry {
	return {
		timestamp: "2026-04-04T12:00:00.000Z",
		conversationId: "tg:dm:123",
		sessionId: "session-abc",
		sender: { id: 123, name: "alice", username: "alice" },
		input: "hello",
		output: "hi there",
		tools: [],
		durationMs: 1234,
		timings: {
			handler_start: 0,
			claude_spawn: 5,
			first_token: 500,
			total: 1234,
		},
		error: null,
		...overrides,
	};
}

describe("ConversationLogger", () => {
	let logDir: string;

	beforeEach(() => {
		logDir = join(tmpdir(), `convo-log-test-${Date.now()}`);
	});

	afterEach(() => {
		rmSync(logDir, { recursive: true, force: true });
	});

	it("creates subdirectory and file on first log entry", () => {
		const logger = createConversationLogger(logDir);
		logger.log(makeEntry());

		const convDir = join(logDir, "tg-dm-123");
		const files = readdirSync(convDir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/\.jsonl$/);
		expect(files[0]).toContain("session-abc");
	});

	it("appends to existing file for same session", () => {
		const logger = createConversationLogger(logDir);
		logger.log(makeEntry({ input: "first" }));
		logger.log(makeEntry({ input: "second" }));

		const convDir = join(logDir, "tg-dm-123");
		const files = readdirSync(convDir);
		expect(files).toHaveLength(1);

		const [filename] = files;
		const content = readFileSync(join(convDir, filename as string), "utf-8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] as string).input).toBe("first");
		expect(JSON.parse(lines[1] as string).input).toBe("second");
	});

	it("creates separate files for different sessions", () => {
		const logger = createConversationLogger(logDir);
		logger.log(makeEntry({ sessionId: "session-1" }));
		logger.log(makeEntry({ sessionId: "session-2" }));

		const convDir = join(logDir, "tg-dm-123");
		const files = readdirSync(convDir);
		expect(files).toHaveLength(2);
	});

	it("recovers file mapping after simulated restart", () => {
		const logger1 = createConversationLogger(logDir);
		logger1.log(makeEntry({ input: "before restart" }));

		const logger2 = createConversationLogger(logDir);
		logger2.log(makeEntry({ input: "after restart" }));

		const convDir = join(logDir, "tg-dm-123");
		const files = readdirSync(convDir);
		expect(files).toHaveLength(1);

		const [filename] = files;
		const content = readFileSync(join(convDir, filename as string), "utf-8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1] as string).input).toBe("after restart");
	});

	it("redacts sensitive values before writing durable logs", () => {
		const logger = createConversationLogger(logDir);
		logger.log(
			makeEntry({
				input: "Project Key: abcdefghijklmnopqrstuvwxyz",
				output: "token=abcdefghijklmnopqrstuvwxyz",
			}),
		);

		const convDir = join(logDir, "tg-dm-123");
		const [filename] = readdirSync(convDir);
		const content = readFileSync(join(convDir, filename as string), "utf-8");
		const row = JSON.parse(content.trim());
		expect(row.input).toBe("Project Key: [REDACTED]");
		expect(row.output).toBe("token=[REDACTED]");
	});

	it("filename format matches expected pattern", () => {
		const logger = createConversationLogger(logDir);
		logger.log(makeEntry());

		const convDir = join(logDir, "tg-dm-123");
		const files = readdirSync(convDir);
		// New pattern: YYYYMMDDTHHmmss_sessionId.jsonl (no channel in filename)
		expect(files[0]).toMatch(/^\d{8}T\d{6}_session-abc\.jsonl$/);
	});
});

describe("conversationIdToDir", () => {
	it("replaces colons with hyphens", () => {
		expect(conversationIdToDir("tg:dm:123")).toBe("tg-dm-123");
		expect(conversationIdToDir("tg:group:-1003839916091")).toBe(
			"tg-group--1003839916091",
		);
		expect(conversationIdToDir("tg:group:-100:topic:52")).toBe(
			"tg-group--100-topic-52",
		);
	});
});

describe("migrateConversationLogs", () => {
	let logDir: string;

	beforeEach(() => {
		logDir = join(tmpdir(), `convo-migrate-test-${Date.now()}`);
	});

	afterEach(() => {
		rmSync(logDir, { recursive: true, force: true });
	});

	it("migrates flat files into subdirectories", () => {
		const { mkdirSync, writeFileSync } = require("node:fs");
		mkdirSync(logDir, { recursive: true });

		// Create old-format flat files
		writeFileSync(
			join(
				logDir,
				"20260404T043530_tg-dm-123_f94bceb3-dd8d-4df5-add3-a15d95dbc449.jsonl",
			),
			'{"test":"data"}\n',
		);
		writeFileSync(
			join(
				logDir,
				"20260405T000747_tg-group--100_54118717-e5dc-4670-9cbe-bb788e9e6673.jsonl",
			),
			'{"test":"data2"}\n',
		);

		const migrated = migrateConversationLogs(logDir);
		expect(migrated).toBe(2);

		// Flat files should be gone
		const topLevel = readdirSync(logDir);
		expect(topLevel).toContain("tg-dm-123");
		expect(topLevel).toContain("tg-group--100");
		expect(topLevel.filter((f) => f.endsWith(".jsonl"))).toHaveLength(0);

		// Files should exist in subdirectories
		const dmFiles = readdirSync(join(logDir, "tg-dm-123"));
		expect(dmFiles).toHaveLength(1);
		expect(dmFiles[0]).toBe(
			"20260404T043530_f94bceb3-dd8d-4df5-add3-a15d95dbc449.jsonl",
		);

		const groupFiles = readdirSync(join(logDir, "tg-group--100"));
		expect(groupFiles).toHaveLength(1);
	});

	it("returns 0 when no flat files exist", () => {
		const migrated = migrateConversationLogs(logDir);
		expect(migrated).toBe(0);
	});

	it("ignores non-jsonl files", () => {
		const { mkdirSync, writeFileSync } = require("node:fs");
		mkdirSync(logDir, { recursive: true });
		writeFileSync(join(logDir, "README.md"), "ignore me");

		const migrated = migrateConversationLogs(logDir);
		expect(migrated).toBe(0);
	});
});
