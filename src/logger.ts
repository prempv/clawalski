import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { Config } from "./config.js";

export type Logger = pino.Logger;

interface LoggerResult {
	logger: Logger;
	close: () => void;
}

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

class DailyFileStream {
	private currentDate: string;
	private dest: pino.DestinationStream & { flushSync?: () => void };
	private logDir: string;

	constructor(logDir: string) {
		mkdirSync(logDir, { recursive: true });
		this.logDir = logDir;
		this.currentDate = todayStr();
		this.dest = pino.destination(join(logDir, `${this.currentDate}.log`));
	}

	private flushCurrent(): void {
		try {
			this.dest.flushSync?.();
		} catch {
			// SonicBoom can still be opening while systemd is stopping us.
		}
	}

	private closeCurrent(): void {
		this.flushCurrent();
		try {
			(this.dest as { end?: () => void }).end?.();
		} catch {
			// Best effort on shutdown.
		}
	}

	write(data: string): boolean {
		const today = todayStr();
		if (today !== this.currentDate) {
			this.closeCurrent();
			this.currentDate = today;
			this.dest = pino.destination(join(this.logDir, `${today}.log`));
		}
		try {
			this.dest.write(data);
			return true;
		} catch {
			return false;
		}
	}

	flushSync(): void {
		this.flushCurrent();
	}

	end(): void {
		this.closeCurrent();
	}
}

export function createLogger(
	config: Pick<Config, "logLevel" | "logDir">,
): LoggerResult {
	const daily = new DailyFileStream(config.logDir);

	const stream = pino.multistream([
		{ stream: process.stdout },
		{ stream: daily },
	]);

	const logger = pino({ level: config.logLevel }, stream);

	return {
		logger,
		close: () => daily.end(),
	};
}
