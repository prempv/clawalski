import { runInstance } from "../../index.js";
import {
	assertInstanceReady,
	assertNodeVersion,
	resolveInstancePaths,
} from "../instance.js";

export async function runCommand(argv: string[]): Promise<number> {
	assertNodeVersion();

	const path = argv.find((a) => !a.startsWith("-"));
	if (!path) {
		console.error("Path is required: clawalski run <path>");
		return 2;
	}

	const paths = resolveInstancePaths(path);
	assertInstanceReady(paths);

	process.loadEnvFile(paths.envFile);

	if (!process.env.TELEGRAM_BOT_TOKEN) {
		console.error(`TELEGRAM_BOT_TOKEN is empty in ${paths.envFile}`);
		console.error("Set the token in that file and try again.");
		return 1;
	}

	await runInstance({ instancePath: paths.root });
	return 0;
}
