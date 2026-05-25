import { describe, expect, it } from "vitest";
import { redactSensitiveText, redactedPreview } from "../redaction.js";

describe("redactSensitiveText", () => {
	it("redacts labelled secret values", () => {
		expect(redactSensitiveText("api key: abcdefghijklmnopqrstuvwxyz")).toBe(
			"api key: [REDACTED]",
		);
		expect(redactSensitiveText("Project Key: abcdefghijklmnopqrstuvwxyz")).toBe(
			"Project Key: [REDACTED]",
		);
		expect(redactSensitiveText("token=abcdefghijklmnopqrstuvwxyz")).toBe(
			"token=[REDACTED]",
		);
		expect(redactSensitiveText("password=correcthorsebatterystaple")).toBe(
			"password=[REDACTED]",
		);
	});
});

describe("redactedPreview", () => {
	it("redacts before truncating", () => {
		expect(
			redactedPreview("secret=abcdefghijklmnopqrstuvwxyz trailing", 30),
		).toBe("secret=[REDACTED] trailing");
	});
});
