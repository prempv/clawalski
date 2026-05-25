import { readFileSync, watch } from "node:fs";
import { z } from "zod";
import type { BackendId } from "./backend.js";
import type { Logger } from "./logger.js";
import type { MessageContext } from "./message-context.js";

const backendIdSchema = z.enum(["claude", "claude-v2", "codex"]);

const accessFileSchema = z.object({
	dmPolicy: z.enum(["open", "allowlist"]).default("open"),
	groupPolicy: z.enum(["open", "allowlist"]).default("open"),
	allowedUsers: z.array(z.union([z.number(), z.literal("*")])).default([]),
	allowedGroups: z.array(z.union([z.number(), z.literal("*")])).default([]),
	adminChatId: z.number().optional(),
	dmDefaultBackend: backendIdSchema.optional(),
	groupDefaultBackend: backendIdSchema.optional(),
});

export interface AccessConfig {
	dmPolicy: "open" | "allowlist";
	groupPolicy: "open" | "allowlist";
	allowedUsers: Set<number>;
	allowedGroups: Set<number>;
	allowAllUsers: boolean;
	allowAllGroups: boolean;
	adminChatId: number | null;
	dmDefaultBackend: BackendId | null;
	groupDefaultBackend: BackendId | null;
}

function parseAccessConfig(raw: unknown): AccessConfig {
	const parsed = accessFileSchema.parse(raw);
	return {
		dmPolicy: parsed.dmPolicy,
		groupPolicy: parsed.groupPolicy,
		allowedUsers: new Set(
			parsed.allowedUsers.filter((v): v is number => v !== "*"),
		),
		allowedGroups: new Set(
			parsed.allowedGroups.filter((v): v is number => v !== "*"),
		),
		allowAllUsers: parsed.allowedUsers.includes("*"),
		allowAllGroups: parsed.allowedGroups.includes("*"),
		adminChatId: parsed.adminChatId ?? null,
		dmDefaultBackend: parsed.dmDefaultBackend ?? null,
		groupDefaultBackend: parsed.groupDefaultBackend ?? null,
	};
}

const OPEN_ACCESS: AccessConfig = {
	dmPolicy: "open",
	groupPolicy: "open",
	allowedUsers: new Set(),
	allowedGroups: new Set(),
	allowAllUsers: false,
	allowAllGroups: false,
	adminChatId: null,
	dmDefaultBackend: null,
	groupDefaultBackend: null,
};

export function loadAccessConfig(filePath: string, log?: Logger): AccessConfig {
	try {
		const content = readFileSync(filePath, "utf-8");
		const config = parseAccessConfig(JSON.parse(content));
		log?.info(
			{
				dmPolicy: config.dmPolicy,
				groupPolicy: config.groupPolicy,
				users: config.allowAllUsers ? "*" : config.allowedUsers.size,
				groups: config.allowAllGroups ? "*" : config.allowedGroups.size,
				adminChatId: config.adminChatId,
			},
			"access config loaded",
		);
		return config;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			log?.warn(
				{ filePath },
				"access config not found, defaulting to open access",
			);
			return OPEN_ACCESS;
		}
		throw err;
	}
}

export function watchAccessConfig(
	filePath: string,
	onChange: (config: AccessConfig) => void,
	log: Logger,
): () => void {
	let debounce: ReturnType<typeof setTimeout> | null = null;

	try {
		const watcher = watch(filePath, () => {
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(() => {
				try {
					const config = loadAccessConfig(filePath, log);
					onChange(config);
					log.info("access config reloaded");
				} catch (err) {
					log.error({ err }, "failed to reload access config");
				}
			}, 300);
		});
		log.info({ filePath }, "watching access config for changes");
		return () => {
			if (debounce) clearTimeout(debounce);
			watcher.close();
		};
	} catch {
		log.warn({ filePath }, "could not watch access config file");
		return () => {
			if (debounce) clearTimeout(debounce);
		};
	}
}

export function isAllowed(ctx: MessageContext, access: AccessConfig): boolean {
	if (ctx.chatType === "channel") return false;

	if (ctx.chatType === "private") {
		if (access.dmPolicy === "open") return true;
		return isUserAllowed(ctx.senderId, access);
	}

	// Group or supergroup
	if (access.groupPolicy === "open") return true;
	return (
		isGroupAllowed(ctx.chatId, access) && isUserAllowed(ctx.senderId, access)
	);
}

function isUserAllowed(senderId: number | null, access: AccessConfig): boolean {
	if (access.allowAllUsers) return true;
	if (senderId == null) return false;
	return access.allowedUsers.has(senderId);
}

function isGroupAllowed(chatId: number, access: AccessConfig): boolean {
	if (access.allowAllGroups) return true;
	return access.allowedGroups.has(chatId);
}

// --- Admin notifications for unknown contacts ---

const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes per sender/chat combo
const notifiedRecently = new Map<string, number>();

export function formatAdminNotification(ctx: MessageContext): string {
	const lines = ["New contact attempt"];

	const from = ctx.senderUsername
		? `${ctx.senderName} (@${ctx.senderUsername})`
		: ctx.senderName;
	lines.push(`From: ${from}`);

	if (ctx.senderId) lines.push(`User ID: ${ctx.senderId}`);

	if (ctx.chatType === "private") {
		lines.push("Context: DM");
	} else {
		const chatLabel = ctx.chatTitle
			? `${ctx.chatTitle} (${ctx.chatId})`
			: String(ctx.chatId);
		lines.push(`Context: ${ctx.chatType} ${chatLabel}`);
		if (ctx.isForum && ctx.threadId != null) {
			lines.push(`Topic: ${ctx.threadId}`);
		}
	}

	return lines.join("\n");
}

export function shouldNotifyAdmin(ctx: MessageContext): boolean {
	const key = `${ctx.senderId ?? "unknown"}:${ctx.chatId}`;
	const now = Date.now();
	const lastNotified = notifiedRecently.get(key);

	if (lastNotified && now - lastNotified < NOTIFY_COOLDOWN_MS) {
		return false;
	}

	notifiedRecently.set(key, now);

	// Prune stale entries periodically
	if (notifiedRecently.size > 500) {
		for (const [k, t] of notifiedRecently) {
			if (now - t > NOTIFY_COOLDOWN_MS) notifiedRecently.delete(k);
		}
	}

	return true;
}
