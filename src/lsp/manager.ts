import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createLspClient,
	type Diagnostic,
	type Location,
	type LspClient,
	type LspTimeouts,
	type SymbolInfo,
	type WorkspaceEdit,
	waitForDiagnostics,
} from "./client.js";
import { detectLanguages, type LspConfig, type LspLanguageConfig } from "./config.js";

export type LspManager = {
	/** Get diagnostics for a file (starts server lazily if needed). */
	diagnosticsFor: (filePath: string) => Promise<Diagnostic[]>;
	/** Notify that a file was changed (call after write_file/edit_file). */
	fileChanged: (filePath: string) => Promise<Diagnostic[]>;
	/** Go to definition of symbol at position. */
	definition: (filePath: string, line: number, character: number) => Promise<Location[]>;
	/** Find all references to symbol at position. */
	references: (filePath: string, line: number, character: number) => Promise<Location[]>;
	/** Get hover info (type/docs) at position. */
	hover: (filePath: string, line: number, character: number) => Promise<string | undefined>;
	/** List all symbols in a file. */
	documentSymbols: (filePath: string) => Promise<SymbolInfo[]>;
	/** Rename symbol at position across files. */
	rename: (
		filePath: string,
		line: number,
		character: number,
		newName: string,
	) => Promise<WorkspaceEdit>;
	/** Check if a file is in a language we support. */
	supports: (filePath: string) => boolean;
	/** Shutdown all running servers. */
	shutdown: () => Promise<void>;
};

export type LspManagerOptions = {
	/** Told once per language whose server can't start, so the user knows why diagnostics are missing. */
	onUnavailable?: (message: string) => void;
	timeouts?: LspTimeouts;
};

/** Create the LSP manager. Starts servers lazily on first relevant file operation. */
export const createLspManager = (
	config: LspConfig,
	projectRoot: string,
	options: LspManagerOptions = {},
): LspManager => {
	const detected = detectLanguages(config, projectRoot);
	const rootUri = pathToFileURL(projectRoot).href;

	// Map file extension → language name
	const extToLang = new Map<string, string>();
	for (const lang of detected) {
		const lc = config[lang];
		if (!lc) continue;
		for (const ext of lc.fileExtensions) extToLang.set(ext, lang);
	}

	const clients = new Map<string, LspClient>();
	// One start per language for the whole session, so a failed server isn't respawned on every edit.
	const starts = new Map<string, Promise<LspClient>>();
	const openFiles = new Set<string>();
	let closing = false;

	const startClient = (lang: string, lc: LspLanguageConfig): Promise<LspClient> => {
		const client = createLspClient(lc, options.timeouts);
		clients.set(lang, client);
		return client.initialize(rootUri).then(
			() => client,
			async (error: Error) => {
				if (!closing) options.onUnavailable?.(`LSP unavailable: ${error.message}`);
				await client.shutdown();
				throw error;
			},
		);
	};

	const getClient = (lang: string): Promise<LspClient | undefined> => {
		const lc = config[lang];
		if (!lc) return Promise.resolve(undefined);
		const started = starts.get(lang) ?? startClient(lang, lc);
		starts.set(lang, started);
		return started;
	};

	const langFor = (filePath: string): string | undefined => {
		const ext = extname(filePath).slice(1); // remove leading dot
		return extToLang.get(ext);
	};

	const ensureOpen = async (client: LspClient, filePath: string, lang: string) => {
		const uri = pathToFileURL(filePath).href;
		const text = readFileSync(filePath, "utf-8");
		if (!openFiles.has(filePath)) {
			await client.didOpen(uri, text, lang);
			openFiles.add(filePath);
			// Brief pause for server to index on first open
			await new Promise((r) => setTimeout(r, 500));
		} else {
			await client.didChange(uri, text);
		}
	};

	return {
		supports: (filePath) => langFor(filePath) !== undefined,

		diagnosticsFor: async (filePath) => {
			const lang = langFor(filePath);
			if (!lang) return [];
			const client = await getClient(lang);
			if (!client) return [];
			await ensureOpen(client, filePath, lang);
			return waitForDiagnostics(client);
		},

		fileChanged: async (filePath) => {
			const lang = langFor(filePath);
			if (!lang) return [];
			const client = await getClient(lang);
			if (!client) return [];
			await ensureOpen(client, filePath, lang);
			return waitForDiagnostics(client);
		},

		definition: async (filePath, line, character) => {
			const lang = langFor(filePath);
			if (!lang) return [];
			const client = await getClient(lang);
			if (!client) return [];
			await ensureOpen(client, filePath, lang);
			return client.definition(pathToFileURL(filePath).href, line - 1, character - 1);
		},

		references: async (filePath, line, character) => {
			const lang = langFor(filePath);
			if (!lang) return [];
			const client = await getClient(lang);
			if (!client) return [];
			await ensureOpen(client, filePath, lang);
			return client.references(pathToFileURL(filePath).href, line - 1, character - 1);
		},

		hover: async (filePath, line, character) => {
			const lang = langFor(filePath);
			if (!lang) return undefined;
			const client = await getClient(lang);
			if (!client) return undefined;
			await ensureOpen(client, filePath, lang);
			return client.hover(pathToFileURL(filePath).href, line - 1, character - 1);
		},

		documentSymbols: async (filePath) => {
			const lang = langFor(filePath);
			if (!lang) return [];
			const client = await getClient(lang);
			if (!client) return [];
			await ensureOpen(client, filePath, lang);
			return client.documentSymbols(pathToFileURL(filePath).href);
		},

		rename: async (filePath, line, character, newName) => {
			const lang = langFor(filePath);
			if (!lang) return [];
			const client = await getClient(lang);
			if (!client) return [];
			await ensureOpen(client, filePath, lang);
			return client.rename(pathToFileURL(filePath).href, line - 1, character - 1, newName);
		},

		shutdown: async () => {
			closing = true;
			await Promise.all([...clients.values()].map((c) => c.shutdown()));
			clients.clear();
			starts.clear();
			openFiles.clear();
		},
	};
};

/** Format diagnostics as a readable string for the model. */
export const formatDiagnostics = (diags: Diagnostic[]): string => {
	const errors = diags.filter((d) => d.severity === "error");
	const warnings = diags.filter((d) => d.severity === "warning");
	if (errors.length === 0 && warnings.length === 0) return "";

	const lines = diags
		.filter((d) => d.severity === "error" || d.severity === "warning")
		.map((d) => `  line ${d.line}: ${d.severity} ${d.source ? `${d.source}: ` : ""}${d.message}`);

	const count = errors.length + warnings.length;
	return `\n⚠ ${count} diagnostic${count === 1 ? "" : "s"}:\n${lines.join("\n")}`;
};
