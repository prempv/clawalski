import { spawn } from "node:child_process";
import type { Logger } from "./logger.js";

function send(state: string): void {
	if (!process.env.NOTIFY_SOCKET) return;
	const child = spawn("systemd-notify", [state], {
		stdio: "ignore",
		detached: false,
	});
	child.on("error", () => {
		// systemd-notify missing, NOTIFY_SOCKET stale — silent no-op
	});
}

export function notifyReady(): void {
	send("READY=1");
}

export function notifyStopping(): void {
	send("STOPPING=1");
}

export function startWatchdog(log: Logger): () => void {
	const usec = process.env.WATCHDOG_USEC;
	if (!process.env.NOTIFY_SOCKET || !usec) return () => {};

	const timeoutMs = Number(usec) / 1000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return () => {};

	const intervalMs = Math.max(5_000, Math.floor(timeoutMs / 2));
	log.info(
		{ timeoutMs, intervalMs },
		"systemd watchdog enabled — sending periodic WATCHDOG=1",
	);

	send("WATCHDOG=1");
	const id = setInterval(() => send("WATCHDOG=1"), intervalMs);
	id.unref?.();
	return () => clearInterval(id);
}
