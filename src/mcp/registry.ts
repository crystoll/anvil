import type { Tool } from "../tools/registry.js";
import type { ConnectedServer } from "./client.js";
import { callServerTool } from "./client.js";

/** Convert MCP tools from a connected server into Anvil Tool objects. */
export const mcpToolsToAnvil = (server: ConnectedServer): Tool[] =>
	server.tools.map((mcpTool) => ({
		name: `${server.name}.${mcpTool.name}`,
		description: `(MCP tool from ${server.name}) ${mcpTool.description ?? ""}`,
		schema: (mcpTool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
		needsApproval: !server.autoApprove.has(mcpTool.name),
		timeout: 60_000,
		execute: async (args: Record<string, unknown>) => callServerTool(server, mcpTool.name, args),
	}));
