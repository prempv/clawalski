import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionStore } from "../session-store.js";
import type { SessionStore } from "../session-store.js";

describe("session-store", () => {
	let tmpDir: string;
	let store: SessionStore;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "session-test-"));
		store = createSessionStore(join(tmpDir, "test.db"));
	});

	afterEach(async () => {
		store.close();
		await rm(tmpDir, { recursive: true });
	});

	it("returns null for unknown conversation", () => {
		expect(store.getSession("tg:dm:999")).toBeNull();
	});

	it("stores and retrieves a session with backend", () => {
		store.setSession("tg:dm:100", "session-abc", "claude");
		expect(store.getSession("tg:dm:100")).toEqual({
			sessionId: "session-abc",
			backend: "claude",
		});
	});

	it("stores codex sessions with the codex backend", () => {
		store.setSession("tg:dm:101", "thread-uuid", "codex");
		expect(store.getSession("tg:dm:101")).toEqual({
			sessionId: "thread-uuid",
			backend: "codex",
		});
	});

	it("upserts existing session", () => {
		store.setSession("tg:dm:100", "session-abc", "claude");
		store.setSession("tg:dm:100", "session-xyz", "claude");
		expect(store.getSession("tg:dm:100")?.sessionId).toBe("session-xyz");
	});

	it("setSession can switch backends on the same conversation", () => {
		store.setSession("tg:dm:100", "claude-id", "claude");
		store.setSession("tg:dm:100", "codex-id", "codex");
		expect(store.getSession("tg:dm:100")).toEqual({
			sessionId: "codex-id",
			backend: "codex",
		});
	});

	it("deletes a session", () => {
		store.setSession("tg:dm:100", "session-abc", "claude");
		store.deleteSession("tg:dm:100");
		expect(store.getSession("tg:dm:100")).toBeNull();
	});

	it("handles multiple conversations independently", () => {
		store.setSession("tg:dm:100", "session-a", "claude");
		store.setSession("tg:group:-200", "session-b", "claude");
		store.setSession("tg:group:-300:topic:5", "session-c", "codex");

		expect(store.getSession("tg:dm:100")?.sessionId).toBe("session-a");
		expect(store.getSession("tg:group:-200")?.sessionId).toBe("session-b");
		expect(store.getSession("tg:group:-300:topic:5")).toEqual({
			sessionId: "session-c",
			backend: "codex",
		});
	});

	it("delete is a no-op for missing conversation", () => {
		expect(() => store.deleteSession("tg:dm:999")).not.toThrow();
	});

	it("creates nested directories for db path", async () => {
		const nestedPath = join(tmpDir, "a", "b", "nested.db");
		const nested = createSessionStore(nestedPath);
		nested.setSession("tg:dm:1", "s1", "claude");
		expect(nested.getSession("tg:dm:1")?.sessionId).toBe("s1");
		nested.close();
	});
});
