import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "../config.js";

const INSTANCE = "/tmp/cw-test-instance";

describe("loadConfig", () => {
	beforeEach(() => {
		vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token-123");
		vi.stubEnv("MODE", "polling");
		vi.stubEnv("LOG_LEVEL", "info");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("loads valid config from env", () => {
		const config = loadConfig({ instancePath: INSTANCE });
		expect(config.telegramBotToken).toBe("test-token-123");
		expect(config.mode).toBe("polling");
		expect(config.logLevel).toBe("info");
		expect(config.webhookPort).toBe(8787);
	});

	it("derives instance-rooted paths by default", () => {
		const config = loadConfig({ instancePath: INSTANCE });
		expect(config.instancePath).toBe(INSTANCE);
		expect(config.accessFile).toBe(`${INSTANCE}/config/access.json`);
		expect(config.cronFile).toBe(`${INSTANCE}/config/crons.json`);
		expect(config.sessionDbPath).toBe(`${INSTANCE}/data/sessions.db`);
		expect(config.logDir).toBe(`${INSTANCE}/data/logs`);
		expect(config.conversationLogDir).toBe(`${INSTANCE}/data/conversations`);
		expect(config.claudeWorkingDir).toBe(`${INSTANCE}/workspace`);
		expect(config.promptsDir).toBe(`${INSTANCE}/config/prompts`);
	});

	it("env vars override instance-derived paths", () => {
		vi.stubEnv("ACCESS_FILE", "/etc/clawalski/access.json");
		vi.stubEnv("CLAUDE_WORKING_DIR", "/srv/work");
		const config = loadConfig({ instancePath: INSTANCE });
		expect(config.accessFile).toBe("/etc/clawalski/access.json");
		expect(config.claudeWorkingDir).toBe("/srv/work");
	});

	it("applies defaults for optional fields", () => {
		vi.stubEnv("MODE", "");
		const config = loadConfig({ instancePath: INSTANCE });
		expect(config.mode).toBe("polling");
		expect(config.webhookPath).toBe("/telegram-webhook");
	});

	it("accepts claude-v2 as the default backend", () => {
		vi.stubEnv("DEFAULT_BACKEND", "claude-v2");
		const config = loadConfig({ instancePath: INSTANCE });
		expect(config.defaultBackend).toBe("claude-v2");
	});

	it("throws on missing token", () => {
		vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
		expect(() => loadConfig({ instancePath: INSTANCE })).toThrow(ConfigError);
	});

	it("throws when webhook mode lacks WEBHOOK_URL", () => {
		vi.stubEnv("MODE", "webhook");
		expect(() => loadConfig({ instancePath: INSTANCE })).toThrow(
			"WEBHOOK_URL is required",
		);
	});

	it("accepts webhook mode with WEBHOOK_URL", () => {
		vi.stubEnv("MODE", "webhook");
		vi.stubEnv("WEBHOOK_URL", "https://example.com");
		const config = loadConfig({ instancePath: INSTANCE });
		expect(config.mode).toBe("webhook");
		expect(config.webhookUrl).toBe("https://example.com");
	});
});
