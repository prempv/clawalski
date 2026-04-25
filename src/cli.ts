import { initCommand } from "./cli/commands/init.js";
import { listCommand } from "./cli/commands/list.js";
import { runCommand } from "./cli/commands/run.js";
import { serviceCommand } from "./cli/commands/service.js";
import { updateCommand } from "./cli/commands/update.js";
import { printTopHelp } from "./cli/help.js";
import { printVersion } from "./cli/version.js";

async function main(argv: string[]): Promise<number> {
	if (
		argv.length === 0 ||
		argv[0] === "-h" ||
		argv[0] === "--help" ||
		argv[0] === "help"
	) {
		printTopHelp();
		return 0;
	}
	if (argv[0] === "-v" || argv[0] === "--version" || argv[0] === "version") {
		printVersion();
		return 0;
	}

	const [cmd, ...rest] = argv;
	switch (cmd) {
		case "init":
			return initCommand(rest);
		case "run":
			return runCommand(rest);
		case "service":
			return serviceCommand(rest);
		case "list":
			return listCommand(rest);
		case "update":
			return updateCommand(rest);
		default:
			console.error(`Unknown command: ${cmd}\n`);
			printTopHelp();
			return 1;
	}
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err) => {
		console.error(err?.stack ?? err);
		process.exit(1);
	},
);
