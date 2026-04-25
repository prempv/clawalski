import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/cli.ts"],
	format: "esm",
	target: "node22",
	clean: true,
	sourcemap: true,
	external: ["better-sqlite3"],
	outputOptions: {
		banner: "#!/usr/bin/env node",
	},
});
