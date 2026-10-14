import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
	Client,
	type Tool as McpTool,
	StreamableHTTPClientTransport,
	type Transport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "./config.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export type McpClientOptions = {
	logDir?: string;
};

export type ConnectedServer = {
	name: string;
	client: Client;
	tools: McpTool[];
	autoApprove: Set<string>;
	toolTimeoutMs: number;
	stderrLog?: WriteStream;
	stderrLogFinished?: Promise<void>;
};

/** Connect to a single MCP server. Returns the connected server or an error message. */
export const connectServer = async (
	name: string,
	config: McpServerConfig,
	options: McpClientOptions = {},
): Promise<ConnectedServer | string> => {
	const client = new Client({ name: "anvil", version: "0.0.1" });
	let transport: Transport | undefined;
	let stderrLog: WriteStream | undefined;
	let stderrLogFinished: Promise<void> | undefined;
	try {
		const created = createTransport(name, config, options.logDir);
		transport = created.transport;
		stderrLog = created.stderrLog;
		stderrLogFinished = created.stderrLogFinished;
		const connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
		const { tools } = await connectAndListTools(client, transport, connectTimeoutMs);
		return {
			name,
			client,
			tools: tools ?? [],
			autoApprove: new Set(config.autoApprove ?? []),
			toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
			...(stderrLog ? { stderrLog } : {}),
			...(stderrLogFinished ? { stderrLogFinished } : {}),
		};
	} catch (error) {
		const cleanupErrors = await cleanupFailedConnection(
			client,
			transport,
			stderrLog,
			stderrLogFinished,
		);
		return `MCP server "${name}" failed to connect: ${[errorText(error), ...cleanupErrors].join(
			"; ",
		)}`;
	}
};

const connectAndListTools = async (
	client: Client,
	transport: Transport,
	timeout: number,
): Promise<{ tools: McpTool[] }> => {
	await client.connect(transport, { timeout });
	return client.listTools(undefined, { timeout });
};

const cleanupFailedConnection = async (
	client: Client,
	transport: Transport | undefined,
	stderrLog: WriteStream | undefined,
	stderrLogFinished: Promise<void> | undefined,
): Promise<string[]> => {
	const errors: string[] = [];
	if (transport) {
		try {
			await client.close();
		} catch (error) {
			errors.push(`cleanup failed: ${errorText(error)}`);
		}
	}
	if (stderrLog && !stderrLog.destroyed) stderrLog.end();
	try {
		await stderrLogFinished;
	} catch (error) {
		errors.push(`stderr logging failed: ${errorText(error)}`);
	}
	return errors;
};

const createTransport = (
	name: string,
	config: McpServerConfig,
	logDir = join(homedir(), ".anvil", "logs"),
): {
	transport: Transport;
	stderrLog?: WriteStream;
	stderrLogFinished?: Promise<void>;
} => {
	if ("url" in config) {
		return { transport: new StreamableHTTPClientTransport(new URL(config.url)) };
	}

	mkdirSync(logDir, { recursive: true, mode: 0o700 });
	const logPath = join(logDir, `mcp-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`);
	const stderrLog = createWriteStream(logPath, { flags: "a", mode: 0o600 });
	const stderrLogFinished = finished(stderrLog);
	void stderrLogFinished.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Failed to write MCP server "${name}" stderr log: ${message}`);
	});

	const transport = new StdioClientTransport({
		command: config.command,
		...(config.args ? { args: config.args } : {}),
		env: { ...getDefaultEnvironment(), ...config.env },
		stderr: "pipe",
	});
	const stderr = transport.stderr;
	if (stderr instanceof Readable) {
		stderr.pipe(stderrLog);
		stderrLog.on("error", () => {
			stderr.unpipe(stderrLog);
			stderr.resume();
		});
	}
	return { transport, stderrLog, stderrLogFinished };
};

/** Call a tool on a connected server. */
export const callServerTool = async (
	server: ConnectedServer,
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> => {
	const result = await server.client.callTool(
		{ name: toolName, arguments: args },
		{
			timeout: server.toolTimeoutMs,
			resetTimeoutOnProgress: true,
			...(signal ? { signal } : {}),
		},
	);
	if (result.isError) {
		const text = extractText(result.content);
		return `Error: ${text || "Tool execution failed"}`;
	}
	return extractText(result.content);
};

/** Disconnect a server gracefully. */
export const disconnectServer = async (server: ConnectedServer): Promise<void> => {
	await server.client.close();
	server.stderrLog?.end();
	await server.stderrLogFinished;
};

const extractText = (content: unknown): string => {
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
};

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
