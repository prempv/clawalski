import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	notifyReady,
	notifyStopping,
	startWatchdog,
} from "../systemd-notify.js";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => ({ on: vi.fn() })),
}));

const spawnMock = vi.mocked(spawn);

function mockLogger() {
	return {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		child: vi.fn().mockReturnThis(),
		// biome-ignore lint/suspicious/noExplicitAny: test stub
	} as any;
}

describe("systemd-notify", () => {
	const origEnv = { ...process.env };

	beforeEach(() => {
		vi.useFakeTimers();
		spawnMock.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		process.env = { ...origEnv };
	});

	it("notifyReady is a no-op when NOTIFY_SOCKET is unset", () => {
		process.env.NOTIFY_SOCKET = "";
		notifyReady();
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("notifyReady spawns systemd-notify READY=1 when NOTIFY_SOCKET is set", () => {
		process.env.NOTIFY_SOCKET = "/run/systemd/notify";
		notifyReady();
		expect(spawnMock).toHaveBeenCalledWith(
			"systemd-notify",
			["READY=1"],
			expect.any(Object),
		);
	});

	it("notifyStopping spawns systemd-notify STOPPING=1", () => {
		process.env.NOTIFY_SOCKET = "/run/systemd/notify";
		notifyStopping();
		expect(spawnMock).toHaveBeenCalledWith(
			"systemd-notify",
			["STOPPING=1"],
			expect.any(Object),
		);
	});

	it("startWatchdog returns a no-op when NOTIFY_SOCKET is unset", () => {
		process.env.NOTIFY_SOCKET = "";
		process.env.WATCHDOG_USEC = "60000000";
		const stop = startWatchdog(mockLogger());
		stop();
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("startWatchdog returns a no-op when WATCHDOG_USEC is unset", () => {
		process.env.NOTIFY_SOCKET = "/run/systemd/notify";
		process.env.WATCHDOG_USEC = "";
		const stop = startWatchdog(mockLogger());
		stop();
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("startWatchdog pings immediately and at half the timeout", () => {
		process.env.NOTIFY_SOCKET = "/run/systemd/notify";
		process.env.WATCHDOG_USEC = "120000000"; // 120s
		const stop = startWatchdog(mockLogger());

		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(spawnMock).toHaveBeenLastCalledWith(
			"systemd-notify",
			["WATCHDOG=1"],
			expect.any(Object),
		);

		vi.advanceTimersByTime(60_000);
		expect(spawnMock).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(60_000);
		expect(spawnMock).toHaveBeenCalledTimes(3);

		stop();
		vi.advanceTimersByTime(60_000);
		expect(spawnMock).toHaveBeenCalledTimes(3);
	});

	it("startWatchdog enforces a 5s minimum interval", () => {
		process.env.NOTIFY_SOCKET = "/run/systemd/notify";
		process.env.WATCHDOG_USEC = "1000000"; // 1s, half would be 500ms
		const stop = startWatchdog(mockLogger());

		expect(spawnMock).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(500);
		expect(spawnMock).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(4_500);
		expect(spawnMock).toHaveBeenCalledTimes(2);

		stop();
	});

	it("startWatchdog ignores invalid WATCHDOG_USEC", () => {
		process.env.NOTIFY_SOCKET = "/run/systemd/notify";
		process.env.WATCHDOG_USEC = "not-a-number";
		const stop = startWatchdog(mockLogger());
		stop();
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
