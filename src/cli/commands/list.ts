import { spawnSync } from "node:child_process";

export async function listCommand(_argv: string[]): Promise<number> {
	const r = spawnSync(
		"systemctl",
		[
			"--user",
			"list-units",
			"--all",
			"--type=service",
			"--no-pager",
			"--no-legend",
			"clawalski-*.service",
		],
		{ encoding: "utf-8" },
	);
	if (r.status !== 0) {
		process.stderr.write(r.stderr ?? "");
		return r.status ?? 1;
	}

	const lines = (r.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) {
		console.log("No clawalski services registered.");
		return 0;
	}

	console.log(
		`${"NAME".padEnd(40)} ${"LOAD".padEnd(10)} ${"ACTIVE".padEnd(10)} SUB`,
	);
	for (const line of lines) {
		const cols = line.trim().split(/\s+/);
		const [unit, load, active, sub] = cols;
		console.log(
			`${(unit ?? "").padEnd(40)} ${(load ?? "").padEnd(10)} ${(active ?? "").padEnd(10)} ${sub ?? ""}`,
		);
	}
	return 0;
}
