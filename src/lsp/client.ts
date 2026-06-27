import { type ChildProcess, spawn } from "node:child_process";
import type { LspLanguageConfig } from "./config.js";

export type Diagnostic = {
	line: number;
	character: number;
	severity: "error" | "warning" | "info" | "hint";
	message: string;
	source?: string;
};

export type LspClient = {
	initialize: (rootUri: string) => Promise<void>;
	didOpen: (uri: string, text: string, languageId: string) => Promise<void>;
	didChange: (uri: string, text: string) => Promise<void>;
	getDiagnostics: () => Diagnostic[];
	definition: (uri: string, line: number, character: number) => Promise<Location[]>;
	references: (uri: string, line: number, character: number) => Promise<Location[]>;
	hover: (uri: string, line: number, character: number) => Promise<string | undefined>;
	documentSymbols: (uri: string) => Promise<SymbolInfo[]>;
	rename: (uri: string, line: number, character: number, newName: string) => Promise<WorkspaceEdit>;
	shutdown: () => Promise<void>;
};

export type Location = { uri: string; line: number; character: number };
export type SymbolInfo = { name: string; kind: string; line: number; detail?: string };
export type TextEdit = {
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
	newText: string;
};
export type WorkspaceEdit = { uri: string; edits: TextEdit[] }[];

/** Create an LSP client that spawns a language server and communicates via JSON-RPC over stdio. */
export const createLspClient = (config: LspLanguageConfig): LspClient => {
	let proc: ChildProcess | undefined;
	let nextId = 1;
	let buffer = "";
	let diagnostics: Diagnostic[] = [];
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	const diagnosticListeners: Array<() => void> = [];

	const send = (msg: object) => {
		const json = JSON.stringify(msg);
		const frame = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
		proc?.stdin?.write(frame);
	};

	const request = (method: string, params: object): Promise<unknown> => {
		const id = nextId++;
		send({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
		});
	};

	const notify = (method: string, params: object) => {
		send({ jsonrpc: "2.0", method, params });
	};

	const handleMessage = (msg: Record<string, unknown>) => {
		// Response to a request
		if (typeof msg.id === "number") {
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			if (msg.error) p.reject(new Error(String((msg.error as Record<string, unknown>).message)));
			else p.resolve(msg.result);
			return;
		}
		// Server notification
		if (msg.method === "textDocument/publishDiagnostics") {
			const params = msg.params as { diagnostics: Array<Record<string, unknown>> };
			diagnostics = (params.diagnostics ?? []).map(parseDiagnostic);
			for (const listener of diagnosticListeners) listener();
		}
	};

	const parseFrames = () => {
		while (true) {
			const headerEnd = buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;
			const header = buffer.slice(0, headerEnd);
			const match = header.match(/Content-Length:\s*(\d+)/i);
			if (!match) {
				buffer = buffer.slice(headerEnd + 4);
				continue;
			}
			const len = Number.parseInt(match[1] ?? "0", 10);
			const bodyStart = headerEnd + 4;
			if (buffer.length < bodyStart + len) break;
			const body = buffer.slice(bodyStart, bodyStart + len);
			buffer = buffer.slice(bodyStart + len);
			try {
				handleMessage(JSON.parse(body));
			} catch {
				/* ignore */
			}
		}
	};

	const startProcess = () => {
		proc = spawn(config.command, config.args, { stdio: ["pipe", "pipe", "pipe"] });
		proc.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			parseFrames();
		});
		proc.on("error", () => {
			/* server crashed */
		});
	};

	return {
		initialize: async (rootUri) => {
			startProcess();
			await request("initialize", {
				processId: process.pid,
				rootUri,
				capabilities: {
					textDocument: {
						publishDiagnostics: { relatedInformation: true },
						synchronization: { didSave: true, dynamicRegistration: false },
					},
				},
				...(config.initializationOptions
					? { initializationOptions: config.initializationOptions }
					: {}),
			});
			notify("initialized", {});
		},

		didOpen: async (uri, text, languageId) => {
			diagnostics = [];
			notify("textDocument/didOpen", {
				textDocument: { uri, languageId, version: 1, text },
			});
		},

		didChange: async (uri, text) => {
			diagnostics = [];
			notify("textDocument/didChange", {
				textDocument: { uri, version: Date.now() },
				contentChanges: [{ text }],
			});
		},

		getDiagnostics: () => diagnostics,

		definition: async (uri, line, character) => {
			const result = await request("textDocument/definition", {
				textDocument: { uri },
				position: { line, character },
			});
			return parseLocations(result);
		},

		references: async (uri, line, character) => {
			const result = await request("textDocument/references", {
				textDocument: { uri },
				position: { line, character },
				context: { includeDeclaration: true },
			});
			return parseLocations(result);
		},

		hover: async (uri, line, character) => {
			const result = await request("textDocument/hover", {
				textDocument: { uri },
				position: { line, character },
			});
			return parseHover(result);
		},

		documentSymbols: async (uri) => {
			const result = await request("textDocument/documentSymbol", {
				textDocument: { uri },
			});
			return parseSymbols(result);
		},

		rename: async (uri, line, character, newName) => {
			const result = await request("textDocument/rename", {
				textDocument: { uri },
				position: { line, character },
				newName,
			});
			return parseWorkspaceEdit(result);
		},

		shutdown: async () => {
			if (!proc) return;
			try {
				await request("shutdown", {});
				notify("exit", {});
			} catch {
				/* ignore */
			}
			proc.kill();
			proc = undefined;
		},
	};
};

/** Wait for diagnostics to arrive (server pushes them async after changes). */
export const waitForDiagnostics = (client: LspClient, timeoutMs = 2000): Promise<Diagnostic[]> =>
	new Promise((resolve) => {
		// Check immediately — might already have diagnostics
		const current = client.getDiagnostics();
		if (current.length > 0) {
			resolve(current);
			return;
		}

		const timer = setTimeout(() => resolve(client.getDiagnostics()), timeoutMs);

		// Monkey-patch: watch for diagnostics to arrive
		const orig = client.getDiagnostics;
		const check = () => {
			const diags = orig();
			if (diags.length > 0) {
				clearTimeout(timer);
				resolve(diags);
			}
		};

		// Poll briefly (diagnostics arrive via notification handler)
		const interval = setInterval(() => {
			check();
		}, 100);
		setTimeout(() => clearInterval(interval), timeoutMs);
	});

const SEVERITY_MAP = ["error", "warning", "info", "hint"] as const;

const parseDiagnostic = (d: Record<string, unknown>): Diagnostic => {
	const range = d.range as { start: { line: number; character: number } } | undefined;
	const severity =
		typeof d.severity === "number" ? (SEVERITY_MAP[d.severity - 1] ?? "info") : "info";
	return {
		line: (range?.start.line ?? 0) + 1,
		character: (range?.start.character ?? 0) + 1,
		severity,
		message: String(d.message ?? ""),
		...(typeof d.source === "string" ? { source: d.source } : {}),
	};
};

const parseLocations = (result: unknown): Location[] => {
	if (!result) return [];
	const items = Array.isArray(result) ? result : [result];
	return items.map((loc: Record<string, unknown>) => {
		const range = (loc.range ?? loc.targetRange) as
			| { start: { line: number; character: number } }
			| undefined;
		const uri = String(loc.uri ?? loc.targetUri ?? "");
		return {
			uri,
			line: (range?.start.line ?? 0) + 1,
			character: (range?.start.character ?? 0) + 1,
		};
	});
};

const parseHover = (result: unknown): string | undefined => {
	if (!result || typeof result !== "object") return undefined;
	const r = result as Record<string, unknown>;
	const contents = r.contents;
	if (typeof contents === "string") return contents;
	if (typeof contents === "object" && contents !== null) {
		const c = contents as Record<string, unknown>;
		if (typeof c.value === "string") return c.value;
		if (Array.isArray(contents))
			return contents
				.map((x) =>
					typeof x === "string" ? x : String((x as Record<string, unknown>).value ?? ""),
				)
				.join("\n");
	}
	return undefined;
};

const SYMBOL_KINDS: Record<number, string> = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enum_member",
	23: "struct",
	24: "event",
	25: "operator",
	26: "type_parameter",
};

const parseSymbols = (result: unknown): SymbolInfo[] => {
	if (!Array.isArray(result)) return [];
	return result.map((s: Record<string, unknown>) => {
		const range = s.range as { start: { line: number } } | undefined;
		const selRange = s.selectionRange as { start: { line: number } } | undefined;
		return {
			name: String(s.name ?? ""),
			kind: SYMBOL_KINDS[s.kind as number] ?? "unknown",
			line: (selRange?.start.line ?? range?.start.line ?? 0) + 1,
			...(typeof s.detail === "string" ? { detail: s.detail } : {}),
		};
	});
};

const parseWorkspaceEdit = (result: unknown): WorkspaceEdit => {
	if (!result || typeof result !== "object") return [];
	const r = result as Record<string, unknown>;
	const changes = r.changes as Record<string, Array<Record<string, unknown>>> | undefined;
	if (!changes) return [];
	return Object.entries(changes).map(([uri, edits]) => ({
		uri,
		edits: edits.map((e) => {
			const range = e.range as {
				start: { line: number; character: number };
				end: { line: number; character: number };
			};
			return {
				startLine: range.start.line + 1,
				startChar: range.start.character + 1,
				endLine: range.end.line + 1,
				endChar: range.end.character + 1,
				newText: String(e.newText ?? ""),
			};
		}),
	}));
};
