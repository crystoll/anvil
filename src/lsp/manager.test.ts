import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LspConfig } from "./config.js";
import { createLspManager } from "./manager.js";

const fakeServer = fileURLToPath(new URL("../test-support/fake-lsp-server.mjs", import.meta.url));

const typescriptConfig = (command: string, args: string[] = []): LspConfig => ({
	typescript: {
		name: "typescript",
		command,
		args,
		fileExtensions: ["ts"],
		projectPatterns: ["tsconfig.json"],
		excludePatterns: [],
	},
});

const typescriptProject = (): string => {
	const root = mkdtempSync(join(tmpdir(), "anvil-lsp-"));
	writeFileSync(join(root, "tsconfig.json"), "{}");
	writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
	return root;
};

describe("createLspManager", () => {
	it("reports a missing server once and fails fast afterwards", async () => {
		const root = typescriptProject();
		const file = join(root, "a.ts");
		const notices: string[] = [];
		const manager = createLspManager(typescriptConfig("anvil-no-such-lsp-server"), root, {
			onUnavailable: (message) => notices.push(message),
		});

		const firstWrites = await Promise.allSettled([
			manager.fileChanged(file),
			manager.fileChanged(file),
		]);
		await expect(manager.documentSymbols(file)).rejects.toThrow(
			"anvil-no-such-lsp-server not found",
		);

		expect(firstWrites.map((write) => write.status)).toEqual(["rejected", "rejected"]);
		expect(notices).toEqual(["LSP unavailable: anvil-no-such-lsp-server not found"]);
	});

	it("stops a server that is still starting without reporting it unavailable", async () => {
		const root = typescriptProject();
		const notices: string[] = [];
		const silentServer = typescriptConfig(process.execPath, [fakeServer, "silent"]);
		const manager = createLspManager(silentServer, root, {
			onUnavailable: (message) => notices.push(message),
			timeouts: { requestMs: 300, initializeMs: 10_000, shutdownMs: 300 },
		});

		const starting = expect(manager.fileChanged(join(root, "a.ts"))).rejects.toThrow("shut down");
		await manager.shutdown();

		await starting;
		expect(notices).toEqual([]);
	});
});
