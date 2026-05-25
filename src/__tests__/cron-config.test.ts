import { describe, expect, it } from "vitest";
import { parseCronConfig } from "../cron-config.js";

describe("parseCronConfig", () => {
	it("accepts claude-v2 as a cron backend", () => {
		const config = parseCronConfig({
			jobs: [
				{
					id: "daily-check",
					name: "daily-check",
					enabled: true,
					schedule: "0 9 * * *",
					prompt: "Run the daily check.",
					backend: "claude-v2",
				},
			],
		});

		expect(config.jobs[0]?.backend).toBe("claude-v2");
	});
});
