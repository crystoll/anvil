import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.ts"],
		coverage: {
			provider: "v8",
			include: ["src/{agent,engine,provider,session,lsp,tools}/**"],
		},
	},
});
