import { readFileSync } from "node:fs";
import { join } from "node:path";

export type PromptTier = "dm" | "group" | "cron";

function readPromptFile(dir: string, filename: string): string {
	try {
		return readFileSync(join(dir, filename), "utf-8").trim();
	} catch {
		return "";
	}
}

/**
 * Build a system prompt by concatenating markdown files from the prompts directory.
 *
 * Composition: base.md + {tier}.md + jobSystemPrompt (cron only)
 *
 * Returns undefined if all sections are empty/missing, letting the caller
 * fall back to its default system prompt.
 */
export function buildSystemPrompt(
	promptsDir: string,
	tier: PromptTier,
	jobSystemPrompt?: string | null,
): string | undefined {
	const base = readPromptFile(promptsDir, "base.md");
	const tierContent = readPromptFile(promptsDir, `${tier}.md`);

	const parts: string[] = [];
	if (base) parts.push(base);
	if (tierContent) parts.push(tierContent);
	if (jobSystemPrompt) parts.push(jobSystemPrompt);

	if (parts.length === 0) return undefined;
	return parts.join("\n\n");
}
