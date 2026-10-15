import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fetchAndExtract } from "../web/web-fetch.js";
import { searchWeb } from "../web/web-search.js";
import type { Tool } from "./registry.js";

const expandTilde = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const HISTORY_DIR = ".anvil/file-history";
const RUN_CMD_TIMEOUT_MS = 300_000;
const PROCESS_KILL_GRACE_MS = 2000;
const MAX_RUN_CMD_OUTPUT_LENGTH = 8000;

/** Save a backup of a file before overwriting it. */
export const backupFile = async (fullPath: string, projectRoot: string): Promise<void> => {
	if (!existsSync(fullPath)) return;
	const rel = relative(projectRoot, fullPath);
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const dest = join(projectRoot, HISTORY_DIR, rel, ts);
	await mkdir(join(dest, ".."), { recursive: true });
	await copyFile(fullPath, dest);
};

const objSchema = (required: string[], properties: Record<string, unknown>) => ({
	type: "object",
	properties,
	required,
});

const strProp = (description: string) => ({ type: "string", description });
const intProp = (description: string) => ({ type: "integer", description });
const normalizeLineEndings = (text: string): string => text.replace(/\r\n?/g, "\n");

type EditMatch = { start: number; end: number; line: number };

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const addLineNumbers = (
	content: string,
	matches: Array<{ start: number; end: number }>,
): EditMatch[] => {
	let cursor = 0;
	let line = 1;
	return matches.map(({ start, end }) => {
		while (cursor < start) {
			if (content[cursor] === "\n") line++;
			cursor++;
		}
		return { start, end, line };
	});
};

const regexMatches = (text: string, pattern: RegExp): EditMatch[] =>
	addLineNumbers(
		text,
		[...text.matchAll(pattern)].map((match) => ({
			start: match.index,
			end: match.index + match[0].length,
		})),
	);

const exactMatches = (content: string, search: string): EditMatch[] => {
	const matches: Array<{ start: number; end: number }> = [];
	let start = content.indexOf(search);
	while (start >= 0) {
		matches.push({ start, end: start + search.length });
		start = content.indexOf(search, start + search.length);
	}
	return addLineNumbers(content, matches);
};

const lineTrimmedMatches = (content: string, search: string): EditMatch[] => {
	const lines = search.split("\n").map((line) => escapeRegExp(line.trim()));
	const pattern = `^[\\t ]*${lines.join("[\\t ]*\\n[\\t ]*")}[\\t ]*$`;
	return regexMatches(content, new RegExp(pattern, "gm"));
};

const whitespaceNormalizedMatches = (content: string, search: string): EditMatch[] => {
	const pattern = search.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
	return pattern ? regexMatches(content, new RegExp(pattern, "g")) : [];
};

const findEditMatches = (content: string, search: string): EditMatch[] => {
	const exact = exactMatches(content, search);
	if (exact.length || !search.trim()) return exact;
	const lineTrimmed = lineTrimmedMatches(content, search);
	return lineTrimmed.length ? lineTrimmed : whitespaceNormalizedMatches(content, search);
};

const closestRegion = (content: string, search: string): string => {
	const lines = content.split("\n");
	const searchTerms = new Set(search.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
	const closestLine = lines.reduce(
		(best, line, index) => {
			const lineTerms = new Set(line.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
			const score = [...searchTerms].filter((term) => lineTerms.has(term)).length;
			return score > best.score ? { index, score } : best;
		},
		{ index: 0, score: -1 },
	).index;
	const start = Math.max(0, closestLine - 1);
	const end = Math.min(lines.length, Math.max(start + search.split("\n").length, closestLine + 2));
	const excerpt = lines
		.slice(start, end)
		.map((line, index) => `${start + index + 1}: ${line}`)
		.join("\n");
	return `Closest region at lines ${start + 1}-${end}:\n${excerpt}`;
};

const replaceMatches = (content: string, matches: EditMatch[], replace: string): string => {
	let cursor = 0;
	const parts: string[] = [];
	for (const match of matches) {
		parts.push(content.slice(cursor, match.start), replace);
		cursor = match.end;
	}
	parts.push(content.slice(cursor));
	return parts.join("");
};

/** Execute a shell command and terminate its process group on cancellation or timeout. */
export const runCmd: Tool = {
	name: "run_cmd",
	description: "Execute a shell command and return stdout/stderr with exit code",
	schema: objSchema(["command"], { command: strProp("Shell command to execute") }),
	needsApproval: true,
	timeout: RUN_CMD_TIMEOUT_MS + PROCESS_KILL_GRACE_MS + 1000,
	execute: (args, context) => executeCommand(String(args.command ?? ""), context),
};

const executeCommand = (
	command: string,
	context: Parameters<Tool["execute"]>[1],
): Promise<string> => {
	if (context.signal.aborted) return Promise.resolve(`$ ${command}\nCancelled by user`);

	return new Promise((resolveResult) => {
		const child = spawn("sh", ["-c", command], {
			cwd: context.projectRoot,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let output = "";
		let outputTruncated = false;
		let termination: "cancelled" | "timeout" | undefined;
		let processError: Error | undefined;
		let terminationError: Error | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const appendOutput = (chunk: string): void => {
			const available = MAX_RUN_CMD_OUTPUT_LENGTH - output.length;
			if (chunk.length > available) outputTruncated = true;
			if (available > 0) output += chunk.slice(0, available);
		};

		const sendSignal = (signal: NodeJS.Signals): void => {
			const error = signalProcessGroup(child.pid, signal);
			if (error) terminationError = error;
		};

		const scheduleKill = (): void => {
			clearTimeout(killTimer);
			killTimer = setTimeout(() => sendSignal("SIGKILL"), PROCESS_KILL_GRACE_MS);
		};

		const terminate = (reason: "cancelled" | "timeout"): void => {
			if (termination) return;
			termination = reason;
			sendSignal("SIGTERM");
			if (child.pid !== undefined) scheduleKill();
		};

		const abortHandler = (): void => terminate("cancelled");
		context.signal.addEventListener("abort", abortHandler, { once: true });
		timeoutTimer = setTimeout(() => terminate("timeout"), RUN_CMD_TIMEOUT_MS);
		if (context.signal.aborted) abortHandler();

		child.once("spawn", () => {
			if (termination) {
				sendSignal("SIGTERM");
				scheduleKill();
			}
		});
		child.stdout?.on("data", (chunk: Buffer) => appendOutput(stdoutDecoder.write(chunk)));
		child.stderr?.on("data", (chunk: Buffer) => appendOutput(stderrDecoder.write(chunk)));
		child.on("error", (error) => {
			processError = error;
		});
		child.on("close", (exitCode, signal) => {
			clearTimeout(timeoutTimer);
			if (!termination || !isProcessGroupRunning(child.pid)) clearTimeout(killTimer);
			context.signal.removeEventListener("abort", abortHandler);
			appendOutput(stdoutDecoder.end());
			appendOutput(stderrDecoder.end());

			const outcome = commandOutcome(command, {
				exitCode,
				signal,
				termination,
				timeoutMs: RUN_CMD_TIMEOUT_MS,
				processError,
				terminationError,
				output,
				outputTruncated,
			});
			resolveResult(outcome);
		});
	});
};

type CommandOutcome = {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	termination: "cancelled" | "timeout" | undefined;
	timeoutMs: number;
	processError: Error | undefined;
	terminationError: Error | undefined;
	output: string;
	outputTruncated: boolean;
};

const signalProcessGroup = (pid: number | undefined, signal: NodeJS.Signals): Error | undefined => {
	if (pid === undefined) return undefined;
	try {
		process.kill(-pid, signal);
		return undefined;
	} catch (error) {
		if (isMissingProcessError(error)) return undefined;
		return error instanceof Error ? error : new Error(String(error));
	}
};

const isMissingProcessError = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "ESRCH";

const isProcessGroupRunning = (pid: number | undefined): boolean => {
	if (pid === undefined) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return !isMissingProcessError(error);
	}
};

const commandStatus = (outcome: CommandOutcome): string => {
	const signal = outcome.signal ? ` (${outcome.signal})` : "";
	if (outcome.termination === "cancelled") return `Cancelled by user${signal}`;
	if (outcome.termination === "timeout")
		return `Timed out after ${Math.ceil(outcome.timeoutMs / 1000)} s${signal}`;
	if (outcome.processError) return `Error: ${outcome.processError.message}`;
	if (outcome.signal) return `Signal: ${outcome.signal}`;
	return `Exit code: ${outcome.exitCode ?? "unknown"}`;
};

const commandOutput = (outcome: CommandOutcome): string =>
	[
		outcome.output,
		outcome.outputTruncated
			? `[output truncated after ${MAX_RUN_CMD_OUTPUT_LENGTH} characters]`
			: "",
		outcome.terminationError ? `Termination error: ${outcome.terminationError.message}` : "",
	]
		.filter(Boolean)
		.join("\n");

const commandOutcome = (command: string, outcome: CommandOutcome): string => {
	const output = commandOutput(outcome);
	return `$ ${command}\n${commandStatus(outcome)}\n${output ? `Output:\n${output}` : ""}`;
};

/** Read a file with pagination. */
export const readFileTool: Tool = {
	name: "read_file",
	description: "Read a file's contents (paginated with offset/limit for large files)",
	schema: objSchema(["path"], {
		path: strProp("Project-relative file path"),
		offset: intProp("1-based start line (default 1)"),
		limit: intProp("Max lines to return (default 200)"),
	}),
	needsApproval: false,
	timeout: 5000,
	execute: async (args, context) => {
		const path = String(args.path ?? "");
		const offset = Math.max(1, Number(args.offset) || 1);
		const limit = Math.min(500, Math.max(1, Number(args.limit) || 200));
		const fullPath = resolve(context.projectRoot, expandTilde(path));

		const content = await readFile(fullPath, "utf-8");
		const lines = content.split("\n");
		const slice = lines.slice(offset - 1, offset - 1 + limit);
		const totalLines = lines.length;

		let result = `File: ${path} (${totalLines} lines)\n`;
		if (offset > 1 || offset - 1 + limit < totalLines) {
			result += `Showing lines ${offset}-${Math.min(offset - 1 + limit, totalLines)} of ${totalLines}\n`;
		}
		result += `\n${slice.map((l, i) => `${offset + i}: ${l}`).join("\n")}`;
		return result;
	},
};

/** Write/create a file. */
export const writeFileTool: Tool = {
	name: "write_file",
	description: "Create or overwrite a file with the given content",
	schema: objSchema(["path", "content"], {
		path: strProp("Project-relative file path"),
		content: strProp("Full file contents to write"),
	}),
	needsApproval: true,
	timeout: 5000,
	execute: async (args, context) => {
		const path = String(args.path ?? "");
		const content = String(args.content ?? "");
		const fullPath = resolve(context.projectRoot, path);

		await backupFile(fullPath, context.projectRoot);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, content, "utf-8");
		return `Wrote ${content.split("\n").length} lines to ${path}`;
	},
};

/** Search and replace in a file. */
export const editFileTool: Tool = {
	name: "edit_file",
	description: "Search and replace text in a file; multiple matches require replace_all",
	schema: objSchema(["path", "search", "replace"], {
		path: strProp("Project-relative file path"),
		search: strProp("Exact text to find"),
		replace: strProp("Replacement text"),
		replace_all: { type: "boolean", description: "Replace every match (default false)" },
	}),
	needsApproval: true,
	timeout: 5000,
	execute: async (args, context) => {
		const path = String(args.path ?? "");
		const search = normalizeLineEndings(String(args.search ?? ""));
		const replace = normalizeLineEndings(String(args.replace ?? ""));
		const fullPath = resolve(context.projectRoot, path);
		if (search === "") throw new Error("Search string must not be empty");

		const content = normalizeLineEndings(await readFile(fullPath, "utf-8"));
		const matches = findEditMatches(content, search);
		if (!matches.length)
			throw new Error(`Search string not found in ${path}.\n${closestRegion(content, search)}`);
		const replaceAll = args.replace_all === true;
		if (matches.length > 1 && !replaceAll)
			throw new Error(
				`Search has ${matches.length} matches on lines ${matches.map(({ line }) => line).join(", ")}. Set replace_all: true to replace all matches.`,
			);
		const selected = replaceAll ? matches : matches.slice(0, 1);
		await backupFile(fullPath, context.projectRoot);
		const updated = replaceMatches(content, selected, replace);
		await writeFile(fullPath, updated, "utf-8");
		return `Edited ${path}: replaced ${selected.length} match${selected.length === 1 ? "" : "es"}`;
	},
};

/** List directory contents. */
export const listDir: Tool = {
	name: "list_dir",
	description: "List files and subdirectories in a project folder",
	schema: objSchema(["path"], {
		path: strProp("Project-relative directory path (use '.' for root)"),
	}),
	needsApproval: false,
	timeout: 5000,
	execute: async (args, context) => {
		const path = String(args.path ?? ".");
		const fullPath = resolve(context.projectRoot, path);
		const entries = await readdir(fullPath, { withFileTypes: true });
		return entries.map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`).join("\n");
	},
};

/** Glob search for files. */
export const glob: Tool = {
	name: "glob",
	description: "Find files matching a glob pattern",
	schema: objSchema(["pattern"], { pattern: strProp("Glob pattern (e.g. '**/*.ts')") }),
	needsApproval: false,
	timeout: 10_000,
	execute: async (args, context) => {
		const pattern = String(args.pattern ?? "");
		const { glob: fsGlob } = await import("node:fs/promises");
		const excluded = new Set(["node_modules", ".git", "dist", "build", ".anvil"]);
		const files: string[] = [];
		for await (const f of fsGlob(pattern, {
			cwd: context.projectRoot,
			exclude: (p) => excluded.has(p),
		})) {
			files.push(f);
			if (files.length >= 100) break;
		}
		return files.length > 0 ? files.join("\n") : "No files found";
	},
};

/** Search file contents. */
export const search: Tool = {
	name: "search",
	description: "Search file contents for a text pattern (case-insensitive)",
	schema: objSchema(["query"], {
		query: strProp("Text to search for"),
		path: strProp("Project-relative directory to search (default '.')"),
	}),
	needsApproval: false,
	timeout: 15_000,
	execute: async (args, context) => {
		const query = String(args.query ?? "");
		const path = String(args.path ?? ".");
		const searchDir = resolve(context.projectRoot, path);

		return new Promise((res) => {
			execFile(
				"grep",
				["-rn", "--include=*", "-i", "-l", query, searchDir],
				{ timeout: 15_000 },
				(_, stdout) => {
					const files = stdout
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((f) => relative(context.projectRoot, f))
						.slice(0, 50);
					res(files.length > 0 ? `Found in:\n${files.join("\n")}` : "No matches found");
				},
			);
		});
	},
};

/** Signal task completion. */
export const done: Tool = {
	name: "done",
	description: "Signal that the task is complete",
	schema: objSchema(["message"], { message: strProp("Completion summary") }),
	needsApproval: false,
	timeout: 1000,
	execute: async (args) => String(args.message ?? "Done"),
};

/** Signal agent is stuck. */
export const stuck: Tool = {
	name: "stuck",
	description: "Signal that you need user help to proceed",
	schema: objSchema(["message"], { message: strProp("What you need help with") }),
	needsApproval: false,
	timeout: 1000,
	execute: async (args) => String(args.message ?? "Stuck"),
};

/** Search the web via DuckDuckGo. */
/** Project context — quick overview of the project. */
const readPackageInfo = async (root: string): Promise<string | undefined> => {
	try {
		const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8"));
		const lines = [`## package.json`, `name: ${pkg.name}  version: ${pkg.version}`];
		if (pkg.description) lines.push(pkg.description);
		if (pkg.scripts) lines.push(`scripts: ${Object.keys(pkg.scripts).join(", ")}`);
		const deps = Object.keys(pkg.dependencies ?? {});
		if (deps.length) lines.push(`dependencies: ${deps.join(", ")}`);
		const devDeps = Object.keys(pkg.devDependencies ?? {});
		if (devDeps.length) lines.push(`devDependencies: ${devDeps.join(", ")}`);
		return lines.join("\n");
	} catch {
		return undefined;
	}
};

const readTsconfigInfo = async (root: string): Promise<string | undefined> => {
	try {
		const { compilerOptions } = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf-8"));
		if (!compilerOptions) return undefined;
		const fields = ["target", "module", "moduleResolution", "strict"]
			.filter((k) => compilerOptions[k] !== undefined)
			.map((k) => `${k}: ${compilerOptions[k]}`);
		return fields.length ? `## tsconfig.json\n${fields.join(", ")}` : undefined;
	} catch {
		return undefined;
	}
};

const getFileTree = (root: string): Promise<string> =>
	new Promise((res) => {
		const args = [
			root,
			"-type",
			"f",
			"-not",
			"-path",
			"*/node_modules/*",
			"-not",
			"-path",
			"*/.git/*",
			"-not",
			"-path",
			"*/dist/*",
		];
		execFile("find", args, { timeout: 5000 }, (_, stdout) => {
			const files = stdout
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((f) => relative(root, f))
				.sort();
			const truncated = files.length > 60 ? `\n... and ${files.length - 60} more` : "";
			res(`## Files (${files.length})\n${files.slice(0, 60).join("\n")}${truncated}`);
		});
	});

export const projectContext: Tool = {
	name: "project_context",
	description: "Get project overview: package.json info, file tree, git status, and recent commits",
	schema: objSchema([], {}),
	needsApproval: false,
	timeout: 10_000,
	execute: async (_, context) => {
		const sections = await Promise.all([
			readPackageInfo(context.projectRoot),
			readTsconfigInfo(context.projectRoot),
			getFileTree(context.projectRoot),
			gitExec(["status", "--short", "--branch"], context.projectRoot).then((s) => `## Git\n${s}`),
			gitExec(["log", "--oneline", "-5"], context.projectRoot).then((s) =>
				s.trim() ? `## Recent commits\n${s}` : undefined,
			),
		]);
		return sections.filter(Boolean).join("\n\n");
	},
};

/** Git status. */
export const gitStatus: Tool = {
	name: "git_status",
	description: "Show git working tree status (modified, staged, untracked files)",
	schema: objSchema([], {}),
	needsApproval: false,
	timeout: 5000,
	execute: async (_, context) => gitExec(["status", "--short", "--branch"], context.projectRoot),
};

/** Git diff. */
export const gitDiff: Tool = {
	name: "git_diff",
	description: "Show git diff of working changes or between refs",
	schema: objSchema([], {
		ref: strProp("Optional ref/range (e.g. 'HEAD~3', 'main..feature')"),
		staged: { type: "boolean", description: "Show staged changes (default: false)" },
	}),
	needsApproval: false,
	timeout: 10_000,
	execute: async (args, context) => {
		const cmd = ["diff"];
		if (args.staged) cmd.push("--cached");
		if (args.ref) cmd.push(String(args.ref));
		return gitExec(cmd, context.projectRoot);
	},
};

/** Git log. */
export const gitLog: Tool = {
	name: "git_log",
	description: "Show recent git commit history",
	schema: objSchema([], {
		count: intProp("Number of commits to show (default 10)"),
		ref: strProp("Optional branch or ref"),
	}),
	needsApproval: false,
	timeout: 5000,
	execute: async (args, context) => {
		const count = Math.min(50, Math.max(1, Number(args.count) || 10));
		const cmd = ["log", "--oneline", `-${count}`];
		if (args.ref) cmd.push(String(args.ref));
		return gitExec(cmd, context.projectRoot);
	},
};

const gitExec = (args: string[], cwd: string): Promise<string> =>
	new Promise((res) => {
		execFile("git", args, { cwd, timeout: 10_000 }, (error, stdout, stderr) => {
			if (error && !stdout) res(stderr.trim() || `git error: ${error.message}`);
			else res(stdout.trim() || "(empty)");
		});
	});

/** Search the web via DuckDuckGo. */
export const webSearch: Tool = {
	name: "web_search",
	description: "Search the web for information. Returns titles, URLs, and snippets.",
	schema: objSchema(["query"], {
		query: strProp("Search query"),
		max_results: { type: "number", description: "Maximum results to return (default 5)" },
	}),
	needsApproval: false,
	timeout: 15_000,
	execute: async (args, context) => {
		const query = String(args.query ?? "");
		const max = Number(args.max_results ?? 5);
		const result = await searchWeb(query, max, context.signal);
		if (result.isErr()) return `Error: ${result.error}`;
		return result.value
			.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
			.join("\n\n");
	},
};

/** Fetch a URL and extract readable content. */
export const webFetch: Tool = {
	name: "web_fetch",
	description: "Fetch a URL and extract its readable text content (removes navigation, ads, etc).",
	schema: objSchema(["url"], {
		url: strProp("URL to fetch"),
		max_length: { type: "number", description: "Max characters to return (default 8000)" },
	}),
	needsApproval: false,
	timeout: 15_000,
	execute: async (args, context) => {
		const url = String(args.url ?? "");
		const maxLength = Number(args.max_length ?? 8000);
		const result = await fetchAndExtract(url, maxLength, context.signal);
		if (result.isErr()) return `Error: ${result.error}`;
		return result.value;
	},
};

/** All built-in tools. */
export const builtinTools: Tool[] = [
	runCmd,
	readFileTool,
	writeFileTool,
	editFileTool,
	listDir,
	glob,
	search,
	projectContext,
	gitStatus,
	gitDiff,
	gitLog,
	webSearch,
	webFetch,
	done,
	stuck,
];
