import { describe, expect, it } from "vitest";
import { createRegistry, parseToolArgs } from "./registry.js";
import type { Tool } from "./registry.js";

const dummyTool: Tool = {
	name: "test_tool",
	description: "a test tool",
	schema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
	needsApproval: false,
	timeout: 5000,
	execute: async (args) => `got: ${args.msg}`,
};

describe("tool registry", () => {
	it("registers and retrieves tools", () => {
		const registry = createRegistry();
		registry.register(dummyTool);

		expect(registry.get("test_tool")).toBe(dummyTool);
		expect(registry.get("nonexistent")).toBeUndefined();
	});

	it("lists all tools", () => {
		const registry = createRegistry();
		registry.register(dummyTool);
		registry.register({ ...dummyTool, name: "other" });

		expect(registry.all()).toHaveLength(2);
	});

	it("generates provider-compatible schemas", () => {
		const registry = createRegistry();
		registry.register(dummyTool);

		const schemas = registry.schemas();
		expect(schemas).toHaveLength(1);
		expect(schemas[0]).toEqual({
			name: "test_tool",
			description: "a test tool",
			parameters: dummyTool.schema,
		});
	});
});

describe("parseToolArgs", () => {
	it("parses valid JSON object", () => {
		const result = parseToolArgs('{"path": "src/index.ts"}');
		expect(result.isOk()).toBe(true);
		expect(result._unsafeUnwrap()).toEqual({ path: "src/index.ts" });
	});

	it("returns err for invalid JSON", () => {
		const result = parseToolArgs("{broken");
		expect(result.isErr()).toBe(true);
	});

	it("returns err for non-object JSON", () => {
		const result = parseToolArgs('"just a string"');
		expect(result.isErr()).toBe(true);
	});

	it("handles empty string as empty object", () => {
		const result = parseToolArgs("");
		expect(result.isOk()).toBe(true);
		expect(result._unsafeUnwrap()).toEqual({});
	});
});

describe("filteredSchemas", () => {
	const makeTool = (name: string) => ({
		name,
		description: "d".repeat(80),
		schema: { type: "object", properties: { x: { type: "string" } } } as Record<string, unknown>,
		needsApproval: false,
		timeout: 5000,
		execute: async () => "",
	});

	it("returns all tools when budget is large", () => {
		const reg = createRegistry();
		reg.register(makeTool("list_dir"));
		reg.register(makeTool("web_search"));
		reg.register(makeTool("lsp_hover"));
		expect(reg.filteredSchemas(131072)).toHaveLength(3);
	});

	it("prioritizes core tools over MCP when budget is tight", () => {
		const reg = createRegistry();
		reg.register(makeTool("list_dir"));
		reg.register(makeTool("read_file"));
		reg.register(makeTool("done"));
		reg.register(makeTool("mcp.sometool"));
		// Tight budget — should keep high-priority tools first
		const all = reg.filteredSchemas(131072);
		const filtered = reg.filteredSchemas(1000);
		expect(filtered.length).toBeLessThan(all.length);
		// Meta (done) and core (list_dir) are higher priority than MCP
		const names = filtered.map((t) => t.name);
		expect(names.indexOf("done")).toBeLessThan(
			names.indexOf("mcp.sometool") === -1 ? names.length : names.indexOf("mcp.sometool"),
		);
	});
});
