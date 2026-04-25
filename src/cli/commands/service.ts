import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type InstancePaths,
	assertInstanceReady,
	deleteServiceFile,
	readServiceName,
	resolveInstancePaths,
	writeServiceName,
} from "../instance.js";

const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function unitDir(): string {
	return join(homedir(), ".config/systemd/user");
}

function unitFilePath(name: string): string {
	return join(unitDir(), `clawalski-${name}.service`);
}

function unitName(name: string): string {
	return `clawalski-${name}.service`;
}

function which(cmd: string): string | null {
	const r = spawnSync("which", [cmd], { encoding: "utf-8" });
	if (r.status === 0) return r.stdout.trim();
	return null;
}

function systemctl(args: string[]): { code: number; output: string } {
	const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf-8" });
	return { code: r.status ?? 0, output: (r.stdout ?? "") + (r.stderr ?? "") };
}

function unitContent(name: string, root: string, bin: string): string {
	return `[Unit]
Description=Clawalski (${name}) — ${root}
After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart=${bin} run ${root}
WorkingDirectory=${root}
EnvironmentFile=${root}/config/.env
Restart=always
RestartSec=5
WatchdogSec=120
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;
}

function pathArg(argv: string[]): string | { error: string } {
	const p = argv.find((a) => !a.startsWith("-"));
	if (!p) return { error: "Path is required" };
	return p;
}

function requireServiceName(paths: InstancePaths): string | { error: string } {
	const name = readServiceName(paths);
	if (!name) {
		return {
			error: `No service registered at ${paths.root}.\nRun: clawalski service install ${paths.root} --name <name>`,
		};
	}
	return name;
}

interface InstallArgs {
	path: string;
	name: string;
}

function parseInstallArgs(argv: string[]): InstallArgs | { error: string } {
	let path: string | undefined;
	let name: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (a === "--name") {
			name = argv[++i];
		} else if (!path && !a.startsWith("-")) {
			path = a;
		} else {
			return { error: `Unknown argument: ${a}` };
		}
	}
	if (!path)
		return {
			error: "Path is required: clawalski service install <path> --name <name>",
		};
	if (!name) return { error: "--name <name> is required" };
	if (!SERVICE_NAME_RE.test(name)) {
		return {
			error: `Invalid name "${name}". Must match ${SERVICE_NAME_RE.source}.`,
		};
	}
	return { path, name };
}

async function install(argv: string[]): Promise<number> {
	const parsed = parseInstallArgs(argv);
	if ("error" in parsed) {
		console.error(parsed.error);
		return 2;
	}

	const paths = resolveInstancePaths(parsed.path);
	assertInstanceReady(paths);

	const bin = which("clawalski");
	if (!bin) {
		console.error(
			"clawalski not found on PATH. Install globally first:\n  pnpm add -g git+https://github.com/prempv/clawalski",
		);
		return 1;
	}

	const file = unitFilePath(parsed.name);
	if (existsSync(file)) {
		console.error(`Unit already exists: ${file}`);
		return 1;
	}

	mkdirSync(unitDir(), { recursive: true });
	writeFileSync(file, unitContent(parsed.name, paths.root, bin));
	writeServiceName(paths, parsed.name);
	console.log(`Wrote ${file}`);

	const reload = systemctl(["daemon-reload"]);
	if (reload.code !== 0) {
		console.error(reload.output);
		return reload.code;
	}

	const enable = systemctl(["enable", unitName(parsed.name)]);
	if (enable.code !== 0) {
		console.error(enable.output);
		return enable.code;
	}

	const start = systemctl(["start", unitName(parsed.name)]);
	if (start.code !== 0) {
		console.error(start.output);
		return start.code;
	}

	console.log(`Service ${unitName(parsed.name)} enabled and started.`);
	console.log(`Tail logs: clawalski service logs ${paths.root}`);
	return 0;
}

async function uninstall(argv: string[]): Promise<number> {
	const r = pathArg(argv);
	if (typeof r !== "string") {
		console.error(r.error);
		return 2;
	}
	const paths = resolveInstancePaths(r);
	const nameOrErr = requireServiceName(paths);
	if (typeof nameOrErr !== "string") {
		console.error(nameOrErr.error);
		return 1;
	}
	const name = nameOrErr;

	systemctl(["stop", unitName(name)]);
	systemctl(["disable", unitName(name)]);
	const file = unitFilePath(name);
	if (existsSync(file)) rmSync(file);
	systemctl(["daemon-reload"]);
	deleteServiceFile(paths);
	console.log(`Uninstalled ${unitName(name)}.`);
	console.log(`Instance data at ${paths.root} left intact.`);
	return 0;
}

function passthrough(
	action: "start" | "stop" | "restart" | "status",
): (argv: string[]) => Promise<number> {
	return async (argv) => {
		const r = pathArg(argv);
		if (typeof r !== "string") {
			console.error(r.error);
			return 2;
		}
		const paths = resolveInstancePaths(r);
		const nameOrErr = requireServiceName(paths);
		if (typeof nameOrErr !== "string") {
			console.error(nameOrErr.error);
			return 1;
		}
		const result = systemctl([action, unitName(nameOrErr)]);
		if (action === "status") {
			process.stdout.write(result.output);
		} else if (result.code !== 0) {
			process.stderr.write(result.output);
		}
		return result.code;
	};
}

async function logs(argv: string[]): Promise<number> {
	const r = pathArg(argv);
	if (typeof r !== "string") {
		console.error(r.error);
		return 2;
	}
	const paths = resolveInstancePaths(r);
	const nameOrErr = requireServiceName(paths);
	if (typeof nameOrErr !== "string") {
		console.error(nameOrErr.error);
		return 1;
	}
	const proc = spawnSync(
		"journalctl",
		["--user", "-u", unitName(nameOrErr), "-f"],
		{ stdio: "inherit" },
	);
	return proc.status ?? 0;
}

export async function serviceCommand(argv: string[]): Promise<number> {
	const [sub, ...rest] = argv;
	switch (sub) {
		case "install":
			return install(rest);
		case "uninstall":
			return uninstall(rest);
		case "start":
			return passthrough("start")(rest);
		case "stop":
			return passthrough("stop")(rest);
		case "restart":
			return passthrough("restart")(rest);
		case "status":
			return passthrough("status")(rest);
		case "logs":
			return logs(rest);
		default:
			console.error(`Unknown service subcommand: ${sub ?? "(none)"}`);
			console.error(
				"Subcommands: install | uninstall | start | stop | restart | status | logs",
			);
			return 2;
	}
}
