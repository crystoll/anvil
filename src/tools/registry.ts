import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import type { ToolSchema } from "../provider/types.js";

/** Error from tool execution. */
export type ToolError = { kind: "execution"; message: string; cause?: unknown };

/** A tool the agent can invoke. */
export type Tool = {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	needsApproval: boolean;
	timeout: number;
	execute: (args: Record<string, unknown>, projectRoot: string) => Promise<string>;
};

/** Tool registry — lookup and schema generation for providers. */
export type Registry = {
	register: (tool: Tool) => void;
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

/** Safely parse JSON tool arguments. */
export const parseToolArgs = (raw: string): Result<Record<string, unknown>, ToolError> => {
	try {
		const parsed = JSON.parse(raw || "{}");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return err({ kind: "execution", message: "Tool arguments must be a JSON object" });
		}
		return ok(parsed as Record<string, unknown>);
	} catch (e) {
		return err({
			kind: "execution",
			message: `Invalid JSON arguments: ${e instanceof Error ? e.message : String(e)}`,
			cause: e,
		});
	}
};
