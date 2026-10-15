import { jsonrepair } from "jsonrepair";
import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import type { ToolSchema } from "../provider/types.js";
import type { FileHistory } from "./file-history.js";

/** Error from tool execution. */
export type ToolError = { kind: "execution"; message: string; cause?: unknown };

/** Context shared with a tool for project access, undo history, and turn cancellation. */
export type ToolExecutionContext = {
	signal: AbortSignal;
	projectRoot: string;
	sessionId?: string;
	fileHistory?: FileHistory;
};

/** A tool the agent can invoke. */
export type Tool = {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	needsApproval: boolean;
	requiresApproval?: (
		args: Record<string, unknown>,
		context: ToolExecutionContext,
	) => Promise<boolean>;
	timeout: number;
	execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<string>;
};

/** Tool registry — lookup and schema generation for providers. */
export type Registry = {
	register: (tool: Tool) => void;
	unregister: (name: string) => void;
	get: (name: string) => Tool | undefined;
	all: () => readonly Tool[];
	schemas: () => ToolSchema[];
	filteredSchemas: (contextSize: number) => ToolSchema[];
};

/** Tool priority groups — lower number = higher priority (always included first). */
const toolPriority = (name: string): number => {
	if (name === "done" || name === "stuck") return 0;
	if (
		["list_dir", "glob", "search", "read_file", "write_file", "edit_file", "run_cmd"].includes(name)
	)
		return 1;
	if (name.startsWith("lsp_")) return 2;
	if (name.startsWith("git_") || name === "project_context") return 3;
	if (name.startsWith("web_")) return 4;
	// MCP tools (lowest priority for budget)
	return 5;
};

/** Estimate token cost of a tool schema (~4 chars per token). */
const estimateTokens = (schema: ToolSchema): number =>
	Math.round(JSON.stringify(schema).length / 4);

/** Create an empty tool registry. */
export const createRegistry = (): Registry => {
	const tools = new Map<string, Tool>();

	const allSchemas = () =>
		[...tools.values()].map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.schema,
		}));

	return {
		register: (tool) => {
			tools.set(tool.name, tool);
		},
		unregister: (name) => {
			tools.delete(name);
		},
		get: (name) => tools.get(name),
		all: () => [...tools.values()],
		schemas: allSchemas,
		filteredSchemas: (contextSize) => {
			const schemas = allSchemas();
			// If context is large enough, send everything
			const budget = Math.round(contextSize * 0.1); // max 10% of context for tools
			const totalCost = schemas.reduce((a, s) => a + estimateTokens(s), 0);
			if (totalCost <= budget) return schemas;

			// Budget constrained — include by priority until budget exhausted
			const sorted = [...schemas].sort((a, b) => toolPriority(a.name) - toolPriority(b.name));
			const result: ToolSchema[] = [];
			let used = 0;
			for (const s of sorted) {
				const cost = estimateTokens(s);
				if (used + cost > budget) break;
				result.push(s);
				used += cost;
			}
			return result;
		},
	};
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const exampleValue = (schema: unknown): unknown => {
	if (!isObject(schema)) return "...";
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
	if (schema.type === "object") return {};
	if (schema.type === "array") return [];
	if (schema.type === "boolean") return true;
	if (schema.type === "number" || schema.type === "integer") return 0;
	return "...";
};

const exampleArguments = (schema: Record<string, unknown>): Record<string, unknown> => {
	const properties = isObject(schema.properties) ? schema.properties : {};
	const required = Array.isArray(schema.required)
		? schema.required.filter((name): name is string => typeof name === "string")
		: [];
	return Object.fromEntries(required.map((name) => [name, exampleValue(properties[name])]));
};

const invalidArguments = (
	message: string,
	schema: Record<string, unknown>,
	cause?: unknown,
): ToolError => ({
	kind: "execution",
	message: [
		message,
		`Expected schema: ${JSON.stringify(schema)}`,
		`Example: ${JSON.stringify(exampleArguments(schema))}`,
	].join("\n"),
	...(cause !== undefined ? { cause } : {}),
});

const parseJson = (raw: string): unknown => {
	try {
		return JSON.parse(raw || "{}");
	} catch {
		return JSON.parse(jsonrepair(raw));
	}
};

/** Parse tool arguments, repairing common malformed JSON from local models. */
export const parseToolArgs = (
	raw: string,
	schema: Record<string, unknown> = { type: "object" },
): Result<Record<string, unknown>, ToolError> => {
	try {
		const parsed = parseJson(raw);
		return isObject(parsed)
			? ok(parsed)
			: err(invalidArguments("Tool arguments must be a JSON object", schema));
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		return err(invalidArguments(`Invalid JSON arguments: ${detail}`, schema, cause));
	}
};
