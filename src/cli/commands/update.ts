import { spawnSync } from "node:child_process";

const LATEST_TARBALL =
	"https://github.com/prempv/clawalski/archive/refs/heads/master.tar.gz";

export async function updateCommand(_argv: string[]): Promise<number> {
	const which = spawnSync("which", ["npm"], { encoding: "utf-8" });
	if (which.status !== 0) {
		console.error(
			"npm not found on PATH. Install Node/npm to use `clawalski update`.",
		);
		return 1;
	}
	console.log(`Upgrading via \`npm i -g ${LATEST_TARBALL}\`...`);
	const r = spawnSync("npm", ["i", "-g", LATEST_TARBALL], { stdio: "inherit" });
	return r.status ?? 0;
}
