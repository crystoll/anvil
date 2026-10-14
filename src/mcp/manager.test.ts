import { describe, expect, it, vi } from "vitest";
import { createRegistry } from "../tools/registry.js";
import type { ConnectedServer } from "./client.js";
import { connectMcpServers } from "./manager.js";

const config = {
	first: { command: "first" },
	second: { command: "second" },
};

const connectedServer = (name: string): ConnectedServer => ({
	name,
	client: {} as ConnectedServer["client"],
	tools: [],
	autoApprove: new Set(),
	toolTimeoutMs: 60_000,
});

describe("connectMcpServers", () => {
	it("connects configured servers concurrently", async () => {
		let activeConnections = 0;
		let maximumConnections = 0;
		const connect = vi.fn(async (name: string) => {
			activeConnections += 1;
			maximumConnections = Math.max(maximumConnections, activeConnections);
			await new Promise((resolve) => setTimeout(resolve, 10));
			activeConnections -= 1;
			return connectedServer(name);
		});

		const result = await connectMcpServers(config, createRegistry(), connect);

		expect(maximumConnections).toBe(2);
		expect(result.servers.map(({ name }) => name)).toEqual(["first", "second"]);
		expect(result.warnings).toEqual([]);
	});

	it("reports returned and thrown failures while keeping healthy servers", async () => {
		const connect = async (name: string) => {
			if (name === "returned") return `MCP server "${name}" failed to connect: unavailable`;
			if (name === "thrown") throw new Error("process exited");
			return connectedServer(name);
		};
		const servers = {
			healthy: { command: "healthy" },
			returned: { command: "returned" },
			thrown: { command: "thrown" },
		};

		const result = await connectMcpServers(servers, createRegistry(), connect);

		expect(result.servers.map(({ name }) => name)).toEqual(["healthy"]);
		expect(result.warnings).toEqual([
			'MCP server "returned" failed to connect: unavailable',
			'MCP server "thrown" failed to connect: process exited',
		]);
	});
});
