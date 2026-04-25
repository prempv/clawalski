import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getVersion(): string {
	try {
		const here = fileURLToPath(import.meta.url);
		const pkgPath = join(dirname(here), "../package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
		return typeof pkg.version === "string" ? pkg.version : "dev";
	} catch {
		return "dev";
	}
}

export function printVersion(): void {
	console.log(`clawalski ${getVersion()}`);
}
