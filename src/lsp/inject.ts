import { resolve } from "node:path";
import { settleWithin } from "../shared/settle-within.js";
import { formatDiagnostics, type LspManager } from "./manager.js";

const DIAGNOSTICS_TIMEOUT_MS = 3000;

/**
 * Create a post-execution hook that appends LSP diagnostics to write_file/edit_file results.
 * Takes projectRoot at creation time, returns a (toolName, args, result) → result function.
 * Diagnostics are best-effort: a failing or slow server must never hold up the agent.
 */
export const createDiagnosticInjector =
	(manager: LspManager, projectRoot: string) =>
	async (toolName: string, args: Record<string, unknown>, result: string): Promise<string> => {
		if (toolName !== "write_file" && toolName !== "edit_file") return result;
		if (result.startsWith("Error:")) return result;

		const path = String(args.path ?? "");
		if (!path) return result;

		const fullPath = resolve(projectRoot, path);
		if (!manager.supports(fullPath)) return result;

		const diags = await settleWithin(manager.fileChanged(fullPath), DIAGNOSTICS_TIMEOUT_MS, []);
		const formatted = formatDiagnostics(diags);
		return formatted ? `${result}${formatted}` : result;
	};
