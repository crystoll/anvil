import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.js";

export type ConnectedServer = {
	name: string;
	client: Client;
	tools: McpTool[];
	autoApprove: Set<string>;
};

/** Connect to a single MCP server. Returns the connected server or an error message. */
export const connectServer = async (
	name: string,
	config: McpServerConfig,
): Promise<ConnectedServer | string> => {
	try {
		const transport = createTransport(config);
		const client = new Client({ name: "anvil", version: "0.0.1" });
		await client.connect(transport);

		const { tools } = await client.listTools();
		const autoApprove = new Set(config.autoApprove ?? []);

		return { name, client, tools: tools ?? [], autoApprove };
	} catch (e) {
		return `MCP server "${name}" failed to connect: ${e instanceof Error ? e.message : String(e)}`;
	}
};

const createTransport = (config: McpServerConfig): Transport => {
	if ("url" in config) {
		return new StreamableHTTPClientTransport(new URL(config.url)) as unknown as Transport;
	}
	const params: Record<string, unknown> = { command: config.command };
	if (config.args) params.args = config.args;
	if (config.env) params.env = { ...process.env, ...config.env };
	return new StdioClientTransport(params as ConstructorParameters<typeof StdioClientTransport>[0]);
};

/** Call a tool on a connected server. */
export const callServerTool = async (
	server: ConnectedServer,
	toolName: string,
	args: Record<string, unknown>,
): Promise<string> => {
	const result = await server.client.callTool({ name: toolName, arguments: args });
	if (result.isError) {
		const text = extractText(result.content);
		return `Error: ${text || "Tool execution failed"}`;
	}
	return extractText(result.content);
};

/** Disconnect a server gracefully. */
export const disconnectServer = async (server: ConnectedServer): Promise<void> => {
	try {
		await server.client.close();
	} catch {
		// ignore close errors
	}
};

const extractText = (content: unknown): string => {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
};
