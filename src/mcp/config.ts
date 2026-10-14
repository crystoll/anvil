import { existsSync, readFileSync } from "node:fs";
import { err, ok, type Result } from "neverthrow";

export type McpServerConfig =
	| {
			type?: "stdio";
			command: string;
			args?: string[];
			env?: Record<string, string>;
			autoApprove?: string[];
			connectTimeoutMs?: number;
			toolTimeoutMs?: number;
	  }
	| {
			type: "http";
			url: string;
			autoApprove?: string[];
			connectTimeoutMs?: number;
			toolTimeoutMs?: number;
	  };

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
			if (server.isErr()) return err(`Invalid MCP server "${name}" in ${path}: ${server.error}`);
			if (server.value) config[name] = server.value;
		}
		return ok(config);
	} catch (e) {
		return err(`Failed to parse MCP config ${path}: ${e instanceof Error ? e.message : String(e)}`);
	}
};

const parseServerEntry = (entry: unknown): Result<McpServerConfig | undefined, string> => {
	const s = entry as Record<string, unknown>;
	const timeouts = parseTimeouts(s);
	if (timeouts.isErr()) return err(timeouts.error);
	if (s.type === "http" || (typeof s.url === "string" && typeof s.command !== "string")) {
		if (typeof s.url !== "string") return ok(undefined);
		const server: McpServerConfig = { type: "http", url: s.url, ...timeouts.value };
		if (Array.isArray(s.autoApprove)) server.autoApprove = s.autoApprove;
		return ok(server);
	}
	if (typeof s.command !== "string") return ok(undefined);
	const server: McpServerConfig = { command: s.command, ...timeouts.value };
	if (Array.isArray(s.args)) server.args = s.args;
	if (typeof s.env === "object" && s.env !== null) server.env = s.env as Record<string, string>;
	if (Array.isArray(s.autoApprove)) server.autoApprove = s.autoApprove;
	return ok(server);
};

const parseTimeouts = (
	entry: Record<string, unknown>,
): Result<Pick<McpServerConfig, "connectTimeoutMs" | "toolTimeoutMs">, string> => {
	const timeouts: Pick<McpServerConfig, "connectTimeoutMs" | "toolTimeoutMs"> = {};
	for (const key of ["connectTimeoutMs", "toolTimeoutMs"] as const) {
		const value = entry[key];
		if (value === undefined) continue;
		if (
			typeof value !== "number" ||
			!Number.isSafeInteger(value) ||
			value <= 0 ||
			value > 2_147_483_647
		) {
			return err(`${key} must be an integer from 1 to 2147483647 milliseconds`);
		}
		timeouts[key] = value;
	}
	return ok(timeouts);
};
