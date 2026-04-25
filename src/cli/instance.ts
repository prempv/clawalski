import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface InstancePaths {
	root: string;
	configDir: string;
	dataDir: string;
	workspaceDir: string;
	envFile: string;
	accessFile: string;
	cronFile: string;
	promptsDir: string;
	serviceFile: string;
	sessionDb: string;
	logDir: string;
	conversationLogDir: string;
}

export function resolveInstancePaths(input: string): InstancePaths {
	const root = resolve(input);
	return {
		root,
		configDir: join(root, "config"),
		dataDir: join(root, "data"),
		workspaceDir: join(root, "workspace"),
		envFile: join(root, "config/.env"),
		accessFile: join(root, "config/access.json"),
		cronFile: join(root, "config/crons.json"),
		promptsDir: join(root, "config/prompts"),
		serviceFile: join(root, "config/service.json"),
		sessionDb: join(root, "data/sessions.db"),
		logDir: join(root, "data/logs"),
		conversationLogDir: join(root, "data/conversations"),
	};
}

export function readServiceName(paths: InstancePaths): string | null {
	if (!existsSync(paths.serviceFile)) return null;
	try {
		const data = JSON.parse(readFileSync(paths.serviceFile, "utf-8"));
		return typeof data?.name === "string" ? data.name : null;
	} catch {
		return null;
	}
}

export function writeServiceName(paths: InstancePaths, name: string): void {
	writeFileSync(paths.serviceFile, `${JSON.stringify({ name }, null, 2)}\n`);
}

export function deleteServiceFile(paths: InstancePaths): void {
	if (existsSync(paths.serviceFile)) rmSync(paths.serviceFile);
}

export function assertNodeVersion(min = 22): void {
	const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
	if (Number.isNaN(major) || major < min) {
		console.error(
			`clawalski requires Node ${min}+. Current: ${process.version}.`,
		);
		process.exit(1);
	}
}

export function assertInstanceReady(paths: InstancePaths): void {
	if (!existsSync(paths.envFile)) {
		console.error(`No clawalski instance found at ${paths.root}.`);
		console.error(`Run: clawalski init ${paths.root}`);
		process.exit(1);
	}
}
