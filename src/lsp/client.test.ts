import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createLspClient } from "./client.js";
import type { LspLanguageConfig } from "./config.js";

const fakeServer = fileURLToPath(new URL("../test-support/fake-lsp-server.mjs", import.meta.url));
const rootUri = "file:///tmp/project";
const fastTimeouts = { requestMs: 300, initializeMs: 300, shutdownMs: 300 };

const serverConfig = (command: string, args: string[] = []): LspLanguageConfig => ({
	name: "fake",
	command,
	args,
	fileExtensions: ["ts"],
	projectPatterns: [],
	excludePatterns: [],
});

const fakeServerConfig = (...args: string[]) =>
	serverConfig(process.execPath, [fakeServer, ...args]);

const readPid = (pidFile: string): number => {
	try {
		return Number(readFileSync(pidFile, "utf-8"));
	} catch {
		return 0;
	}
};

const isRunning = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("createLspClient", () => {
	it("initializes against a responsive server", async () => {
		const client = createLspClient(fakeServerConfig("respond"), fastTimeouts);

		await expect(client.initialize(rootUri)).resolves.toBeUndefined();
		await client.shutdown();
	});

	it("F4: rejects initialize when the server binary is missing", async () => {
		const client = createLspClient(serverConfig("anvil-no-such-lsp-server"), fastTimeouts);

		await expect(client.initialize(rootUri)).rejects.toThrow("anvil-no-such-lsp-server not found");
		await client.shutdown();
	});

	it("F4: rejects a request the server never answers", async () => {
		const client = createLspClient(fakeServerConfig("silent"), fastTimeouts);

		await expect(client.initialize(rootUri)).rejects.toThrow("did not answer initialize");
		await client.shutdown();
	});

	it("rejects pending requests when the server exits", async () => {
		const patient = { ...fastTimeouts, initializeMs: 10_000 };
		const client = createLspClient(fakeServerConfig("exit"), patient);

		await expect(client.initialize(rootUri)).rejects.toThrow("exited with code 3");
	});

	it("isn't blocked by a server that floods stderr", async () => {
		const client = createLspClient(fakeServerConfig("noisy"), fastTimeouts);

		await expect(client.initialize(rootUri)).resolves.toBeUndefined();
		await client.shutdown();
	});

	it("F4: kills an unresponsive server on shutdown", async () => {
		const pidFile = join(mkdtempSync(join(tmpdir(), "anvil-lsp-")), "pid");
		const patient = { ...fastTimeouts, initializeMs: 10_000 };
		const client = createLspClient(fakeServerConfig("silent", pidFile), patient);
		const initializing = expect(client.initialize(rootUri)).rejects.toThrow("shut down");
		const pid = await vi.waitUntil(() => readPid(pidFile), { timeout: 5000 });

		const shutdownStart = Date.now();
		await client.shutdown();

		expect(Date.now() - shutdownStart).toBeLessThan(1500);
		await initializing;
		await vi.waitUntil(() => !isRunning(pid), { timeout: 2000 });
	});
});
