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

	write(data: string): boolean {
		const today = todayStr();
		if (today !== this.currentDate) {
			this.dest.flushSync?.();
			(this.dest as { end?: () => void }).end?.();
			this.currentDate = today;
			this.dest = pino.destination(join(this.logDir, `${today}.log`));
		}
		this.dest.write(data);
		return true;
	}

	flushSync(): void {
		this.dest.flushSync?.();
	}

	end(): void {
		this.dest.flushSync?.();
		(this.dest as { end?: () => void }).end?.();
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
