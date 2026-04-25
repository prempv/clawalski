import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const LANDRUN = "landrun";
const TEST_DIR = join(tmpdir(), "landrun-sandbox-test");

function landrunAvailable(): boolean {
	try {
		execFileSync(LANDRUN, ["--version"], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function run(
	landrunArgs: string[],
	cmd: string[],
): { status: number | null; stdout: string; stderr: string } {
	const envArgs = Object.entries(process.env)
		.filter(([, v]) => v !== undefined)
		.flatMap(([k, v]) => ["--env", `${k}=${v}`]);

	const result = spawnSync(
		LANDRUN,
		[...landrunArgs, ...envArgs, "--", ...cmd],
		{
			timeout: 10_000,
			stdio: "pipe",
		},
	);
	return {
		status: result.status,
		stdout: result.stdout?.toString() ?? "",
		stderr: result.stderr?.toString() ?? "",
	};
}

describe.skipIf(!landrunAvailable())("landrun sandbox", () => {
	beforeAll(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterAll(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("allows writes to permitted directory", () => {
		const testFile = join(TEST_DIR, "allowed.txt");
		const result = run(
			["--rox", "/", "--rw", TEST_DIR, "--unrestricted-network"],
			["bash", "-c", `echo hello > ${testFile}`],
		);
		expect(result.status).toBe(0);
		expect(existsSync(testFile)).toBe(true);
	});

	it("blocks writes outside permitted directory", () => {
		const testFile = join(tmpdir(), "landrun-blocked-write.txt");
		const result = run(
			["--rox", "/", "--rw", TEST_DIR, "--unrestricted-network"],
			["bash", "-c", `echo hello > ${testFile}`],
		);
		expect(result.status).not.toBe(0);
		expect(existsSync(testFile)).toBe(false);
	});

	it("allows reads from the filesystem", () => {
		const result = run(
			["--rox", "/", "--rw", TEST_DIR, "--unrestricted-network"],
			["cat", "/etc/hostname"],
		);
		expect(result.status).toBe(0);
		expect(result.stdout.trim().length).toBeGreaterThan(0);
	});

	it("allows network access with --unrestricted-network", () => {
		const result = run(
			["--rox", "/", "--rw", TEST_DIR, "--unrestricted-network"],
			[
				"node",
				"-e",
				`
				fetch("https://api.github.com/", { signal: AbortSignal.timeout(5000) })
					.then(r => { console.log(r.status); process.exit(0); })
					.catch(() => process.exit(1));
			`,
			],
		);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("200");
	});

	it("executes system binaries", () => {
		const result = run(
			["--rox", "/", "--rw", TEST_DIR, "--unrestricted-network"],
			["node", "-e", "console.log(JSON.stringify({ok:true}))"],
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true });
	});
});
