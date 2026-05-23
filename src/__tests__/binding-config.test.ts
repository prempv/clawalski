import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type BindingConfig,
	loadBindingConfig,
	parseBindingConfig,
	resolveBinding,
} from "../binding-config.js";
import type { MessageContext } from "../message-context.js";

function makeCtx(overrides: Partial<MessageContext> = {}): MessageContext {
	return {
		conversationId: "tg:dm:100",
		chatType: "private",
		chatId: 100,
		chatTitle: null,
		senderId: 100,
		senderName: "Alice",
		senderUsername: "alice",
		threadId: null,
		isForum: false,
		...overrides,
	};
}

describe("parseBindingConfig", () => {
	it("rejects entries with neither workingDir nor prompt", () => {
		expect(() => parseBindingConfig({ bindings: [{ chatId: 1 }] })).toThrow();
	});

	it("accepts entries with only a prompt", () => {
		const cfg = parseBindingConfig({
			bindings: [{ chatId: 1, prompt: "be nice" }],
		});
		expect(cfg.bindings).toHaveLength(1);
	});

	it("drops entries whose workingDir does not exist", () => {
		const cfg = parseBindingConfig({
			bindings: [
				{ chatId: 1, workingDir: "/this/path/definitely/does/not/exist/xyz" },
				{ chatId: 2, prompt: "ok" },
			],
		});
		expect(cfg.bindings).toHaveLength(1);
		expect(cfg.bindings[0]?.chatId).toBe(2);
	});
});

describe("loadBindingConfig", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "binding-test-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns empty config when file is missing", () => {
		const cfg = loadBindingConfig(join(dir, "nope.json"));
		expect(cfg.bindings).toEqual([]);
	});

	it("loads bindings from disk", async () => {
		const file = join(dir, "bindings.json");
		await writeFile(
			file,
			JSON.stringify({
				bindings: [{ chatId: 42, prompt: "hello" }],
			}),
		);
		const cfg = loadBindingConfig(file);
		expect(cfg.bindings).toEqual([{ chatId: 42, prompt: "hello" }]);
	});
});

describe("resolveBinding", () => {
	const cfg: BindingConfig = {
		bindings: [
			{ chatId: 100, prompt: "dm prompt" },
			{ chatId: -200, prompt: "group general" },
			{ chatId: -300, threadId: 7, prompt: "topic seven" },
		],
	};

	it("matches a DM by chatId", () => {
		const ctx = makeCtx({ chatId: 100, chatType: "private" });
		expect(resolveBinding(ctx, cfg)?.prompt).toBe("dm prompt");
	});

	it("matches a non-forum group by chatId", () => {
		const ctx = makeCtx({
			chatId: -200,
			chatType: "group",
			isForum: false,
			threadId: null,
		});
		expect(resolveBinding(ctx, cfg)?.prompt).toBe("group general");
	});

	it("matches a forum topic by chatId + threadId", () => {
		const ctx = makeCtx({
			chatId: -300,
			chatType: "supergroup",
			isForum: true,
			threadId: 7,
		});
		expect(resolveBinding(ctx, cfg)?.prompt).toBe("topic seven");
	});

	it("does not match a topic message against a threadless binding", () => {
		const ctx = makeCtx({
			chatId: -200,
			chatType: "supergroup",
			isForum: true,
			threadId: 99,
		});
		expect(resolveBinding(ctx, cfg)).toBeNull();
	});

	it("does not match a general message against a topic-scoped binding", () => {
		const ctx = makeCtx({
			chatId: -300,
			chatType: "supergroup",
			isForum: false,
			threadId: null,
		});
		expect(resolveBinding(ctx, cfg)).toBeNull();
	});

	it("returns null when no entry matches", () => {
		const ctx = makeCtx({ chatId: 999 });
		expect(resolveBinding(ctx, cfg)).toBeNull();
	});
});
