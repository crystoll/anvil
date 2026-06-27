import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/main.ts", "src/cli.ts", "src/tui/app.tsx"],
	format: ["esm"],
	target: "node22",
	splitting: true,
	clean: true,
	dts: false,
});
