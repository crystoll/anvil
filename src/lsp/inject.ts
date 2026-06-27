import { resolve } from "node:path";
import { formatDiagnostics, type LspManager } from "./manager.js";

/**
 * Create a post-execution hook that appends LSP diagnostics to write_file/edit_file results.
 * Takes projectRoot at creation time, returns a (toolName, args, result) → result function.
 */
export const createDiagnosticInjector =
	(manager: LspManager, projectRoot: string) =>
	async (toolName: string, args: Record<string, unknown>, result: string): Promise<string> => {
		if (toolName !== "write_file" && toolName !== "edit_file") return result;

		const path = String(args.path ?? "");
		if (!path) return result;

		const fullPath = resolve(projectRoot, path);
		if (!manager.supports(fullPath)) return result;

		const diags = await manager.fileChanged(fullPath);
		const formatted = formatDiagnostics(diags);
		return formatted ? `${result}${formatted}` : result;
	};
