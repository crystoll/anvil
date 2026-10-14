import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ConnectedServer, connectServer, disconnectServer } from "./client.js";
import { mcpToolsToAnvil } from "./registry.js";

const FIXTURE = new URL("./__fixtures__/fake-mcp-server.mjs", import.meta.url).pathname;

describe("MCP tool adapter", () => {
	const logDir = join(tmpdir(), `anvil-mcp-registry-test-${process.pid}`);
	let server: ConnectedServer | undefined;

	afterEach(async () => {
		if (server) await disconnectServer(server);
		server = undefined;
		rmSync(logDir, { recursive: true, force: true });
	});

	it("passes the tool cancellation signal to the MCP client", async () => {
		const connected = await connectServer(
			"fake",
			{ command: process.execPath, args: [FIXTURE] },
			{ logDir },
		);
		if (typeof connected === "string") throw new Error(connected);
		server = connected;
		const tool = mcpToolsToAnvil(server).find((candidate) => candidate.name === "fake.hang");
		if (!tool) throw new Error("fixture hang tool was not registered");

		const controller = new AbortController();
		const execution = tool.execute({}, { signal: controller.signal, projectRoot: tmpdir() });
		controller.abort();

		await expect(execution).rejects.toThrow();
	});
});
