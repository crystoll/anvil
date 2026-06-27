import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { backupFile } from "../tools/builtins.js";
import type { Tool } from "../tools/registry.js";
import type { TextEdit } from "./client.js";
import { formatDiagnostics, type LspManager } from "./manager.js";

/** Create the lsp_diagnostics tool backed by the manager. */
export const createLspDiagnosticsTool = (manager: LspManager): Tool => ({
	name: "lsp_diagnostics",
	description: "Get TypeScript/JavaScript errors and warnings for a file from the language server",
	schema: {
		type: "object",
		required: ["path"],
		properties: {
			path: { type: "string", description: "Project-relative file path to check" },
		},
	},
	needsApproval: false,
	timeout: 10000,
	execute: async (args, projectRoot) => {
		const path = String(args.path ?? "");
		const fullPath = resolve(projectRoot, path);

		if (!manager.supports(fullPath)) {
			return `No language server configured for ${path}`;
		}

		const diags = await manager.diagnosticsFor(fullPath);
		if (diags.length === 0) return `${path}: no errors or warnings`;

		const formatted = formatDiagnostics(diags);
		return `${path}:${formatted}`;
	},
});

/** Create the lsp_definition tool. */
export const createLspDefinitionTool = (manager: LspManager): Tool => ({
	name: "lsp_definition",
	description: "Go to definition of symbol at a file position (line and column, 1-based)",
	schema: {
		type: "object",
		required: ["path", "line", "character"],
		properties: {
			path: { type: "string", description: "Project-relative file path" },
			line: { type: "number", description: "Line number (1-based)" },
			character: { type: "number", description: "Column number (1-based)" },
		},
	},
	needsApproval: false,
	timeout: 10000,
	execute: async (args, projectRoot) => {
		const path = String(args.path ?? "");
		const fullPath = resolve(projectRoot, path);
		const locs = await manager.definition(fullPath, Number(args.line), Number(args.character));
		if (locs.length === 0) return "No definition found";
		return locs
			.map((l) => `${fileFromUri(l.uri, projectRoot)}:${l.line}:${l.character}`)
			.join("\n");
	},
});

/** Create the lsp_references tool. */
export const createLspReferencesTool = (manager: LspManager): Tool => ({
	name: "lsp_references",
	description: "Find all references/usages of symbol at a file position (line and column, 1-based)",
	schema: {
		type: "object",
		required: ["path", "line", "character"],
		properties: {
			path: { type: "string", description: "Project-relative file path" },
			line: { type: "number", description: "Line number (1-based)" },
			character: { type: "number", description: "Column number (1-based)" },
		},
	},
	needsApproval: false,
	timeout: 10000,
	execute: async (args, projectRoot) => {
		const path = String(args.path ?? "");
		const fullPath = resolve(projectRoot, path);
		const locs = await manager.references(fullPath, Number(args.line), Number(args.character));
		if (locs.length === 0) return "No references found";
		return `${locs.length} reference(s):\n${locs.map((l) => `  ${fileFromUri(l.uri, projectRoot)}:${l.line}:${l.character}`).join("\n")}`;
	},
});

/** Create the lsp_hover tool. */
export const createLspHoverTool = (manager: LspManager): Tool => ({
	name: "lsp_hover",
	description:
		"Get type info and documentation for symbol at a file position (line and column, 1-based)",
	schema: {
		type: "object",
		required: ["path", "line", "character"],
		properties: {
			path: { type: "string", description: "Project-relative file path" },
			line: { type: "number", description: "Line number (1-based)" },
			character: { type: "number", description: "Column number (1-based)" },
		},
	},
	needsApproval: false,
	timeout: 10000,
	execute: async (args, projectRoot) => {
		const path = String(args.path ?? "");
		const fullPath = resolve(projectRoot, path);
		const info = await manager.hover(fullPath, Number(args.line), Number(args.character));
		return info ?? "No hover information available";
	},
});

/** Create the lsp_symbols tool. */
export const createLspSymbolsTool = (manager: LspManager): Tool => ({
	name: "lsp_symbols",
	description: "List all symbols (functions, classes, variables, types) in a file",
	schema: {
		type: "object",
		required: ["path"],
		properties: {
			path: { type: "string", description: "Project-relative file path" },
		},
	},
	needsApproval: false,
	timeout: 10000,
	execute: async (args, projectRoot) => {
		const path = String(args.path ?? "");
		const fullPath = resolve(projectRoot, path);
		const symbols = await manager.documentSymbols(fullPath);
		if (symbols.length === 0) return `${path}: no symbols found`;
		return symbols
			.map((s) => `  ${s.kind} ${s.name}${s.detail ? ` — ${s.detail}` : ""} (line ${s.line})`)
			.join("\n");
	},
});

const fileFromUri = (uri: string, projectRoot: string): string => {
	try {
		const path = new URL(uri).pathname;
		return path.startsWith(projectRoot) ? path.slice(projectRoot.length + 1) : path;
	} catch {
		return uri;
	}
};

/** Create the lsp_rename tool (approval-gated — modifies files). */
export const createLspRenameTool = (manager: LspManager): Tool => ({
	name: "lsp_rename",
	description: "Rename a symbol across all files (1-based line/character position)",
	schema: {
		type: "object",
		required: ["path", "line", "character", "newName"],
		properties: {
			path: { type: "string", description: "Project-relative file path containing the symbol" },
			line: { type: "number", description: "Line number (1-based)" },
			character: { type: "number", description: "Column number (1-based)" },
			newName: { type: "string", description: "New name for the symbol" },
		},
	},
	needsApproval: true,
	timeout: 15000,
	execute: async (args, projectRoot) => {
		const path = String(args.path ?? "");
		const fullPath = resolve(projectRoot, path);
		const edits = await manager.rename(
			fullPath,
			Number(args.line),
			Number(args.character),
			String(args.newName),
		);

		if (edits.length === 0)
			return "No rename edits returned — symbol may not be renameable at this position.";

		const results: string[] = [];
		for (const { uri, edits: fileEdits } of edits) {
			const filePath = fileFromUri(uri, projectRoot);
			const absPath = resolve(projectRoot, filePath);
			await backupFile(absPath, projectRoot);
			const content = applyEdits(readFileSync(absPath, "utf-8"), fileEdits);
			writeFileSync(absPath, content, "utf-8");
			results.push(`  ${filePath} (${fileEdits.length} edit${fileEdits.length === 1 ? "" : "s"})`);
		}

		return `Renamed across ${edits.length} file${edits.length === 1 ? "" : "s"}:\n${results.join("\n")}`;
	},
});

/** Apply text edits to file content (edits are 1-indexed from parseWorkspaceEdit). */
const applyEdits = (content: string, edits: TextEdit[]): string => {
	const lines = content.split("\n");
	// Apply edits in reverse order to preserve positions
	const sorted = [...edits].sort((a, b) =>
		b.startLine !== a.startLine ? b.startLine - a.startLine : b.startChar - a.startChar,
	);
	for (const edit of sorted) {
		const startLine = edit.startLine - 1;
		const endLine = edit.endLine - 1;
		const before = lines[startLine]?.slice(0, edit.startChar - 1) ?? "";
		const after = lines[endLine]?.slice(edit.endChar - 1) ?? "";
		const newLines = (before + edit.newText + after).split("\n");
		lines.splice(startLine, endLine - startLine + 1, ...newLines);
	}
	return lines.join("\n");
};
