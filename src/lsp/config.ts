import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LspLanguageConfig = {
	name: string;
	command: string;
	args: string[];
	fileExtensions: string[];
	projectPatterns: string[];
	excludePatterns: string[];
	initializationOptions?: Record<string, unknown>;
};

export type LspConfig = Record<string, LspLanguageConfig>;

/** Load LSP config from project → global → .kiro fallback. First found wins. */
export const loadLspConfig = (projectRoot: string): LspConfig | undefined => {
	const paths = [
		join(projectRoot, ".anvil", "lsp.json"),
		join(homedir(), ".anvil", "lsp.json"),
		join(projectRoot, ".kiro", "settings", "lsp.json"),
		join(homedir(), ".kiro", "settings", "lsp.json"),
	];

	for (const path of paths) {
		if (!existsSync(path)) continue;
		const config = parseLspFile(path);
		if (config) return config;
	}
	return undefined;
};

/** Detect which languages from config are relevant for this project. */
export const detectLanguages = (config: LspConfig, projectRoot: string): string[] =>
	Object.entries(config)
		.filter(([_, lang]) => lang.projectPatterns.some((p) => existsSync(join(projectRoot, p))))
		.map(([name]) => name);

const parseLspFile = (path: string): LspConfig | undefined => {
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		const languages = raw.languages;
		if (typeof languages !== "object" || languages === null) return undefined;

		const config: LspConfig = {};
		for (const [name, entry] of Object.entries(languages)) {
			const lang = parseLangEntry(entry);
			if (lang) config[name] = lang;
		}
		return Object.keys(config).length > 0 ? config : undefined;
	} catch {
		return undefined;
	}
};

const parseLangEntry = (entry: unknown): LspLanguageConfig | undefined => {
	const e = entry as Record<string, unknown>;
	if (typeof e.command !== "string") return undefined;
	return {
		name: typeof e.name === "string" ? e.name : e.command,
		command: e.command,
		args: Array.isArray(e.args) ? e.args.map(String) : [],
		fileExtensions: Array.isArray(e.file_extensions) ? e.file_extensions.map(String) : [],
		projectPatterns: Array.isArray(e.project_patterns) ? e.project_patterns.map(String) : [],
		excludePatterns: Array.isArray(e.exclude_patterns) ? e.exclude_patterns.map(String) : [],
		...(typeof e.initialization_options === "object" && e.initialization_options !== null
			? { initializationOptions: e.initialization_options as Record<string, unknown> }
			: {}),
	};
};
