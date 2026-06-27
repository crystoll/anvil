import { existsSync, readFileSync } from "node:fs";
import { type Result, err, ok } from "neverthrow";

export type McpServerConfig =
	| {
			type?: "stdio";
			command: string;
			args?: string[];
			env?: Record<string, string>;
			autoApprove?: string[];
	  }
	| { type: "http"; url: string; autoApprove?: string[] };

export type McpConfig = Record<string, McpServerConfig>;

/** Load and merge MCP config from multiple paths (first found wins per server). */
export const loadMcpConfig = (paths: string[]): Result<McpConfig, string> => {
	const merged: McpConfig = {};

	for (const path of paths) {
		if (!existsSync(path)) continue;
		const result = parseMcpFile(path);
		if (result.isErr()) return err(result.error);
		for (const [name, config] of Object.entries(result.value)) {
			if (!(name in merged)) merged[name] = config;
		}
	}

	return ok(merged);
};

const parseMcpFile = (path: string): Result<McpConfig, string> => {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		const servers = raw.mcpServers ?? raw;
		if (typeof servers !== "object" || servers === null) {
			return err(`Invalid MCP config in ${path}: expected object`);
		}
		const config: McpConfig = {};
		for (const [name, entry] of Object.entries(servers)) {
			const server = parseServerEntry(entry);
			if (server) config[name] = server;
		}
		return ok(config);
	} catch (e) {
		return err(`Failed to parse MCP config ${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
};

const parseServerEntry = (entry: unknown): McpServerConfig | undefined => {
	const s = entry as Record<string, unknown>;
	if (s.type === "http" || (typeof s.url === "string" && typeof s.command !== "string")) {
		if (typeof s.url !== "string") return undefined;
		const server: McpServerConfig = { type: "http", url: s.url };
		if (Array.isArray(s.autoApprove)) server.autoApprove = s.autoApprove;
		return server;
	}
	if (typeof s.command !== "string") return undefined;
	const server: McpServerConfig = { command: s.command };
	if (Array.isArray(s.args)) server.args = s.args;
	if (typeof s.env === "object" && s.env !== null) server.env = s.env as Record<string, string>;
	if (Array.isArray(s.autoApprove)) server.autoApprove = s.autoApprove;
	return server;
};
