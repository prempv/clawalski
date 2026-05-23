import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import type { Logger } from "./logger.js";
import type { MessageContext } from "./message-context.js";

const bindingEntrySchema = z
	.object({
		chatId: z.number().int(),
		threadId: z.number().int().positive().optional(),
		workingDir: z.string().min(1).optional(),
		prompt: z.string().min(1).optional(),
	})
	.refine((b) => b.workingDir != null || b.prompt != null, {
		message: "binding must set at least one of workingDir or prompt",
	});

const bindingFileSchema = z.object({
	bindings: z.array(bindingEntrySchema).default([]),
});

export type BindingEntry = z.infer<typeof bindingEntrySchema>;

export interface BindingConfig {
	bindings: BindingEntry[];
}

export interface ResolvedBinding {
	workingDir: string | null;
	prompt: string | null;
}

const EMPTY_CONFIG: BindingConfig = { bindings: [] };

function validateWorkingDir(dir: string, log?: Logger): boolean {
	try {
		const s = statSync(dir);
		if (!s.isDirectory()) {
			log?.warn({ workingDir: dir }, "binding workingDir is not a directory");
			return false;
		}
		return true;
	} catch {
		log?.warn({ workingDir: dir }, "binding workingDir does not exist");
		return false;
	}
}

export function parseBindingConfig(raw: unknown, log?: Logger): BindingConfig {
	const parsed = bindingFileSchema.parse(raw);
	const bindings = parsed.bindings.filter((b) => {
		if (b.workingDir != null && !validateWorkingDir(b.workingDir, log)) {
			return false;
		}
		return true;
	});
	return { bindings };
}

export function loadBindingConfig(
	filePath: string,
	log?: Logger,
): BindingConfig {
	try {
		const content = readFileSync(filePath, "utf-8");
		const config = parseBindingConfig(JSON.parse(content), log);
		log?.info(
			{ count: config.bindings.length, filePath },
			"binding config loaded",
		);
		return config;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			log?.info(
				{ filePath },
				"binding config not found, no bindings configured",
			);
			return EMPTY_CONFIG;
		}
		throw err;
	}
}

export function resolveBinding(
	ctx: MessageContext,
	config: BindingConfig,
): ResolvedBinding | null {
	const wantThreadId =
		ctx.isForum && ctx.threadId != null ? ctx.threadId : null;

	for (const b of config.bindings) {
		if (b.chatId !== ctx.chatId) continue;
		const entryThreadId = b.threadId ?? null;
		if (entryThreadId !== wantThreadId) continue;
		return {
			workingDir: b.workingDir ?? null,
			prompt: b.prompt ?? null,
		};
	}
	return null;
}
