import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ConnectedServer, callServerTool, connectServer, disconnectServer } from "./client.js";

const FIXTURE = new URL("./__fixtures__/fake-mcp-server.mjs", import.meta.url).pathname;

describe("MCP client", () => {
	const testDir = join(tmpdir(), `anvil-mcp-client-test-${process.pid}`);
	let servers: ConnectedServer[] = [];

	beforeEach(() => {
		servers = [];
	});

	afterEach(async () => {
		await Promise.all(servers.map(disconnectServer));
		rmSync(testDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	const connectFixture = async (
		options: {
			args?: string[];
			connectTimeoutMs?: number;
			env?: Record<string, string>;
			toolTimeoutMs?: number;
		} = {},
	) => {
		const connected = await connectServer(
			"fake",
			{
				command: process.execPath,
				args: options.args ?? [FIXTURE],
				...options,
			},
			{ logDir: testDir },
		);
		if (typeof connected === "string") throw new Error(connected);
		servers.push(connected);
		return connected;
	};

	it("connects and lists tools from a stdio server", async () => {
		const server = await connectFixture();

		expect(server.tools.map(({ name }) => name)).toEqual([
			"echo",
			"fail",
			"hang",
			"crash",
			"environment",
		]);
	});

	it("returns text from a successful tool call", async () => {
		const server = await connectFixture();

		await expect(callServerTool(server, "echo", { text: "hello" })).resolves.toBe("hello");
	});

	it("formats an MCP tool error", async () => {
		const server = await connectFixture();

		await expect(callServerTool(server, "fail", {})).resolves.toBe("Error: fixture failure");
	});

	it("times out a tool call within its configured deadline", async () => {
		const server = await connectFixture({ toolTimeoutMs: 100 });
		const startedAt = Date.now();

		await expect(callServerTool(server, "hang", {})).rejects.toThrow();
		expect(Date.now() - startedAt).toBeLessThan(2000);
	});

	it("times out a server that never completes initialization", async () => {
		const startedAt = Date.now();
		const result = await connectServer(
			"silent",
			{
				command: process.execPath,
				args: [FIXTURE, "--silent"],
				connectTimeoutMs: 100,
			},
			{ logDir: testDir },
		);

		expect(result).toContain('MCP server "silent" failed to connect:');
		expect(Date.now() - startedAt).toBeLessThan(2000);
	});

	it("cancels a tool call when its abort signal fires", async () => {
		const server = await connectFixture();
		const controller = new AbortController();
		const pending = callServerTool(server, "hang", {}, controller.signal);

		controller.abort();

		await expect(pending).rejects.toThrow();
	});

	it("returns promptly when the server crashes during a call", async () => {
		const server = await connectFixture();
		const pending = callServerTool(server, "crash", {});

		await expect(pending).rejects.toThrow();
	});

	it("uses the safe default environment and only adds configured variables", async () => {
		vi.stubEnv("ANVIL_MCP_TEST_SECRET", "host-secret");
		const server = await connectFixture({ env: { ANVIL_MCP_TEST_VALUE: "configured-value" } });
		const result = await callServerTool(server, "environment", {});

		expect(JSON.parse(result)).toEqual({ configured: "configured-value" });
	});

	it("reports a missing server command without hanging", async () => {
		const result = await connectServer(
			"missing",
			{ command: "anvil-no-such-mcp-command", connectTimeoutMs: 100 },
			{ logDir: testDir },
		);

		expect(result).toContain('MCP server "missing" failed to connect:');
	});

	it("captures server stderr without writing it to the terminal", async () => {
		const stderrWrite = vi.spyOn(process.stderr, "write");
		const server = await connectFixture();

		await disconnectServer(server);
		servers = servers.filter((connected) => connected !== server);

		expect(stderrWrite).not.toHaveBeenCalledWith(
			expect.stringContaining("fake MCP server started"),
			expect.anything(),
		);
		expect(readFileSync(join(testDir, "mcp-fake.log"), "utf-8")).toContain(
			"fake MCP server started",
		);
	});
});
