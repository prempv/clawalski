import { spawnSync } from "node:child_process";

export async function updateCommand(_argv: string[]): Promise<number> {
	const which = spawnSync("which", ["pnpm"], { encoding: "utf-8" });
	if (which.status !== 0) {
		console.error(
			"pnpm not found on PATH. Install pnpm to use `clawalski update`.",
		);
		return 1;
	}
	console.log(
		"Upgrading via `pnpm add -g git+https://github.com/prempv/clawalski`...",
	);
	const r = spawnSync(
		"pnpm",
		["add", "-g", "git+https://github.com/prempv/clawalski"],
		{ stdio: "inherit" },
	);
	return r.status ?? 0;
}
