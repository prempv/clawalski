import { spawnSync } from "node:child_process";

export async function updateCommand(_argv: string[]): Promise<number> {
	const which = spawnSync("which", ["npm"], { encoding: "utf-8" });
	if (which.status !== 0) {
		console.error(
			"npm not found on PATH. Install Node/npm to use `clawalski update`.",
		);
		return 1;
	}
	console.log(
		"Upgrading via `npm i -g git+https://github.com/prempv/clawalski`...",
	);
	const r = spawnSync(
		"npm",
		["i", "-g", "git+https://github.com/prempv/clawalski"],
		{ stdio: "inherit" },
	);
	return r.status ?? 0;
}
