import type { Registry } from "../tools/registry.js";
import { type ConnectedServer, connectServer } from "./client.js";
import type { McpConfig } from "./config.js";
import { mcpToolsToAnvil } from "./registry.js";

export type McpSetupResult = {
	servers: ConnectedServer[];
	warnings: string[];
};

type McpConnector = (name: string, config: McpConfig[string]) => Promise<ConnectedServer | string>;

/** Connect configured servers concurrently and preserve per-server startup failures. */
export const connectMcpServers = async (
	config: McpConfig,
	registry: Registry,
	connect: McpConnector = connectServer,
): Promise<McpSetupResult> => {
	const entries = Object.entries(config);
	const results = await Promise.allSettled(
		entries.map(([name, serverConfig]) => connect(name, serverConfig)),
	);
	const servers: ConnectedServer[] = [];
	const warnings: string[] = [];

	results.forEach((result, index) => {
		const name = entries[index]?.[0] ?? "unknown";
		if (result.status === "rejected") {
			warnings.push(`MCP server "${name}" failed to connect: ${errorText(result.reason)}`);
			return;
		}
		if (typeof result.value === "string") {
			warnings.push(result.value);
			return;
		}
		for (const tool of mcpToolsToAnvil(result.value)) registry.register(tool);
		servers.push(result.value);
	});

	return { servers, warnings };
};

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
