import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, opendir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fetchAndExtract } from "../web/web-fetch.js";
import { searchWeb } from "../web/web-search.js";
import {
	isGlobOutsideProject,
	isPathOutsideProject,
	resolveGlobPattern,
	resolveRealPath,
} from "./path-policy.js";
import type { Tool } from "./registry.js";

const HISTORY_DIR = ".anvil/file-history";
const RUN_CMD_TIMEOUT_MS = 300_000;
const PROCESS_KILL_GRACE_MS = 2000;
const MAX_RUN_CMD_HEAD_LENGTH = 2000;
const MAX_RUN_CMD_TAIL_LENGTH = 6000;
const MAX_RUN_CMD_OUTPUT_LENGTH = MAX_RUN_CMD_HEAD_LENGTH + MAX_RUN_CMD_TAIL_LENGTH;
const SEARCH_TIMEOUT_MS = 15_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_ERROR_LENGTH = 4000;
const MAX_READ_FILE_LINES = 2000;
const MAX_READ_FILE_OUTPUT_BYTES = 100 * 1024;
const MAX_DIRECTORY_RESULTS = 100;
const MAX_GIT_DIFF_OUTPUT_LENGTH = 20_000;

/** Save a backup of a file before overwriting it. */
export const backupFile = async (fullPath: string, projectRoot: string): Promise<void> => {
	if (!existsSync(fullPath)) return;
	const root = await realpath(projectRoot);
	const rel = relative(root, fullPath);
	const isExternal = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	const historyPath = isExternal
		? join("_external", createHash("sha256").update(fullPath).digest("hex"))
		: rel;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const dest = join(root, HISTORY_DIR, historyPath, ts);
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
			env: {
				...process.env,
				CI: "1",
				PAGER: "cat",
				GIT_PAGER: "cat",
				GIT_TERMINAL_PROMPT: "0",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let outputHead = "";
		let outputTail = "";
		let outputLength = 0;
		let termination: "cancelled" | "timeout" | undefined;
		let processError: Error | undefined;
		let terminationError: Error | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

		const appendOutput = (chunk: string): void => {
			outputLength += chunk.length;
			const headCapacity = MAX_RUN_CMD_HEAD_LENGTH - outputHead.length;
			outputHead += chunk.slice(0, headCapacity);
			const remainder = chunk.slice(headCapacity);
			if (remainder) outputTail = (outputTail + remainder).slice(-MAX_RUN_CMD_TAIL_LENGTH);
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
				output: outputHead + outputTail,
				omittedOutputLength: Math.max(0, outputLength - MAX_RUN_CMD_OUTPUT_LENGTH),
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
	omittedOutputLength: number;
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
		outcome.omittedOutputLength > 0
			? `${outcome.output.slice(0, MAX_RUN_CMD_HEAD_LENGTH)}\n… ${outcome.omittedOutputLength} chars omitted …\n${outcome.output.slice(MAX_RUN_CMD_HEAD_LENGTH)}`
			: outcome.output,
		outcome.terminationError ? `Termination error: ${outcome.terminationError.message}` : "",
	]
		.filter(Boolean)
		.join("\n");

const commandOutcome = (command: string, outcome: CommandOutcome): string => {
	const output = commandOutput(outcome);
	return `$ ${command}\n${commandStatus(outcome)}\n${output ? `Output:\n${output}` : ""}`;
};

const truncateUtf8 = (text: string, maxBytes: number): string => {
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	const end =
		low > 0 && text.charCodeAt(low - 1) >= 0xd800 && text.charCodeAt(low - 1) <= 0xdbff
			? low - 1
			: low;
	return text.slice(0, end);
};

const formatReadFile = (path: string, content: Buffer, offset: number, limit: number): string => {
	const lines = content.toString("utf8").split("\n");
	const totalLines = lines.length;
	const pageLines = lines.slice(offset - 1, offset - 1 + Math.min(limit, MAX_READ_FILE_LINES));
	const fileHeader = `File: ${path} (${totalLines} lines)\n`;
	const fileHeaderBytes = Buffer.byteLength(fileHeader, "utf8");
	const outputLines: string[] = [];
	let outputLineBytes = 0;
	let clippedLine = false;

	for (const [index, line] of pageLines.entries()) {
		const lineNumber = offset + index;
		const formattedLine = `${lineNumber}: ${line}`;
		const separatorBytes = outputLines.length > 0 ? 1 : 0;
		const formattedLineBytes = Buffer.byteLength(formattedLine, "utf8");
		if (
			fileHeaderBytes + outputLineBytes + separatorBytes + formattedLineBytes + 160 <=
			MAX_READ_FILE_OUTPUT_BYTES
		) {
			outputLines.push(formattedLine);
			outputLineBytes += separatorBytes + formattedLineBytes;
			continue;
		}

		const prefix = `${lineNumber}: `;
		const suffix = "… [line clipped]";
		const availableBytes =
			MAX_READ_FILE_OUTPUT_BYTES -
			fileHeaderBytes -
			outputLineBytes -
			separatorBytes -
			160 -
			Buffer.byteLength(prefix + suffix, "utf8");
		if (availableBytes >= 0) {
			outputLines.push(`${prefix}${truncateUtf8(line, availableBytes)}${suffix}`);
			clippedLine = true;
		}
		break;
	}

	const nextOffset = offset + outputLines.length;
	const hasMoreLines = offset - 1 + outputLines.length < totalLines;
	const isTruncated = hasMoreLines || clippedLine;
	const showing =
		offset > 1 || isTruncated
			? outputLines.length > 0
				? `Showing lines ${offset}-${nextOffset - 1} of ${totalLines}\n`
				: `No lines at offset ${offset} (file has ${totalLines} lines)\n`
			: "";
	const output = outputLines.length > 0 ? outputLines.join("\n") : "";
	const note = isTruncated ? `\n\nTruncated; continue with offset=${nextOffset}` : "";

	return `${fileHeader}${showing}\n${output}${note}`;
};

/** Read a file with pagination. */
export const readFileTool: Tool = {
	name: "read_file",
	description: "Read a text file with pagination; output is limited to 2,000 lines or 100 KB",
	schema: objSchema(["path"], {
		path: strProp("Project-relative file path"),
		offset: intProp("1-based start line (default 1)"),
		limit: intProp("Max lines to return (default 200; maximum 2,000)"),
	}),
	needsApproval: false,
	requiresApproval: async (args, context) =>
		isPathOutsideProject(String(args.path ?? ""), context.projectRoot, true),
	timeout: 5000,
	execute: async (args, context) => {
		const path = String(args.path ?? "");
		const requestedOffset = Number(args.offset);
		const requestedLimit = Number(args.limit);
		const offset =
			Number.isSafeInteger(requestedOffset) && requestedOffset > 0 ? requestedOffset : 1;
		const limit =
			Number.isSafeInteger(requestedLimit) && requestedLimit > 0
				? Math.min(requestedLimit, MAX_READ_FILE_LINES)
				: 200;
		const fullPath = await resolveRealPath(path, context.projectRoot, true);

		const content = await readFile(fullPath);
		if (content.includes(0)) throw new Error(`Refusing to read binary file: ${path}`);
		return formatReadFile(path, content, offset, limit);
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
	requiresApproval: async (args, context) =>
		isPathOutsideProject(String(args.path ?? ""), context.projectRoot, true),
	timeout: 5000,
	execute: async (args, context) => {
		const path = String(args.path ?? "");
		const content = String(args.content ?? "");
		const fullPath = await resolveRealPath(path, context.projectRoot, true);

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
	requiresApproval: async (args, context) =>
		isPathOutsideProject(String(args.path ?? ""), context.projectRoot, true),
	timeout: 5000,
	execute: async (args, context) => {
		const path = String(args.path ?? "");
		const search = normalizeLineEndings(String(args.search ?? ""));
		const replace = normalizeLineEndings(String(args.replace ?? ""));
		const fullPath = await resolveRealPath(path, context.projectRoot, true);
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
	description: "List up to 100 files and subdirectories in a project folder",
	schema: objSchema(["path"], {
		path: strProp("Project-relative directory path (use '.' for root)"),
	}),
	needsApproval: false,
	requiresApproval: async (args, context) =>
		isPathOutsideProject(String(args.path ?? "."), context.projectRoot, true),
	timeout: 5000,
	execute: async (args, context) => {
		const path = String(args.path ?? ".");
		const fullPath = await resolveRealPath(path, context.projectRoot, true);
		const directory = await opendir(fullPath);
		const entries: string[] = [];
		let truncated = false;
		for await (const entry of directory) {
			if (entries.length >= MAX_DIRECTORY_RESULTS) {
				truncated = true;
				break;
			}
			entries.push(`${entry.isDirectory() ? "📁" : "📄"} ${entry.name}`);
		}
		return [
			entries.join("\n"),
			truncated ? `Directory listing truncated after ${MAX_DIRECTORY_RESULTS} entries` : "",
		]
			.filter(Boolean)
			.join("\n");
	},
};

/** Glob search for files. */
export const glob: Tool = {
	name: "glob",
	description: "Find up to 100 files matching a glob pattern",
	schema: objSchema(["pattern"], { pattern: strProp("Glob pattern (e.g. '**/*.ts')") }),
	needsApproval: false,
	requiresApproval: async (args, context) =>
		isGlobOutsideProject(String(args.pattern ?? ""), context.projectRoot),
	timeout: 10_000,
	execute: async (args, context) => {
		const pattern = String(args.pattern ?? "");
		const { glob: fsGlob } = await import("node:fs/promises");
		const resolvedGlob = await resolveGlobPattern(pattern, context.projectRoot);
		const excluded = new Set(["node_modules", ".git", "dist", "build", ".anvil"]);
		const files: string[] = [];
		let skippedExternal = 0;
		let checked = 0;
		let truncated = false;
		for await (const f of fsGlob(resolvedGlob.pattern, {
			cwd: resolvedGlob.cwd,
			exclude: (p) => excluded.has(p),
		})) {
			if (checked >= MAX_DIRECTORY_RESULTS) {
				truncated = true;
				break;
			}
			checked++;
			if (await isPathOutsideProject(f, resolvedGlob.cwd)) {
				skippedExternal++;
				continue;
			}
			files.push(f);
		}
		if (files.length === 0 && skippedExternal === 0) return "No files found";
		return [
			files.join("\n"),
			skippedExternal > 0 ? `Skipped ${skippedExternal} results outside the project` : "",
			truncated ? `Glob results truncated after ${MAX_DIRECTORY_RESULTS} results` : "",
		]
			.filter(Boolean)
			.join("\n");
	},
};

/** Search file contents. */
type SearchCommand = {
	label: string;
	command: string;
	args: string[];
};

type SearchCommandOutcome = {
	exitCode: number | null;
	lines: string[];
	truncated: boolean;
	stderr: string;
	error: Error | undefined;
	timedOut: boolean;
};

const formatSearchLine = (line: string): string => {
	const normalized = line.replace(/^\.\//, "");
	const match = normalized.match(/^(.+?):(\d+):(.*)$/);
	return match ? `${match[1]}:${match[2]}: ${match[3]}` : normalized;
};

const runSearchCommand = (
	command: SearchCommand,
	cwd: string,
	signal: AbortSignal,
): Promise<SearchCommandOutcome> =>
	new Promise((resolveOutcome) => {
		const child = spawn(command.command, command.args, {
			cwd,
			signal,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdoutDecoder = new StringDecoder("utf8");
		let stdoutRemainder = "";
		let stderr = "";
		const lines: string[] = [];
		let matchedLineCount = 0;
		let truncated = false;
		let processError: Error | undefined;
		let timedOut = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const appendLine = (line: string): void => {
			matchedLineCount += 1;
			if (matchedLineCount <= MAX_SEARCH_RESULTS) {
				lines.push(formatSearchLine(line));
			} else {
				truncated = true;
			}
		};

		const appendStdout = (chunk: string): void => {
			const parts = (stdoutRemainder + chunk).split("\n");
			stdoutRemainder = parts.pop() ?? "";
			for (const line of parts) appendLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		};

		const appendStderr = (chunk: Buffer): void => {
			stderr = (stderr + chunk.toString("utf8")).slice(-MAX_SEARCH_ERROR_LENGTH);
		};

		timeoutTimer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => child.kill("SIGKILL"), PROCESS_KILL_GRACE_MS);
		}, SEARCH_TIMEOUT_MS);

		child.stdout?.on("data", (chunk: Buffer) => appendStdout(stdoutDecoder.write(chunk)));
		child.stderr?.on("data", appendStderr);
		child.once("error", (error) => {
			processError = error;
		});
		child.once("close", (exitCode) => {
			clearTimeout(timeoutTimer);
			clearTimeout(killTimer);
			appendStdout(stdoutDecoder.end());
			if (stdoutRemainder) appendLine(stdoutRemainder);
			resolveOutcome({
				exitCode,
				lines,
				truncated,
				stderr,
				error: processError,
				timedOut,
			});
		});
	});

const isMissingCommandError = (error: Error | undefined): boolean =>
	error !== undefined && "code" in error && error.code === "ENOENT";

const isGitRepositoryUnavailable = (
	command: SearchCommand,
	outcome: SearchCommandOutcome,
): boolean =>
	command.label === "git grep" &&
	outcome.exitCode !== 0 &&
	outcome.exitCode !== 1 &&
	outcome.stderr.includes("not a git repository");

const searchCommandOutput = (command: SearchCommand, outcome: SearchCommandOutcome): string => {
	if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
		throw new Error(
			`Search failed (${command.label}): ${outcome.stderr.trim() || `exit code ${outcome.exitCode}`}`,
		);
	}
	if (outcome.lines.length === 0) return "No matches found";
	return [
		outcome.lines.join("\n"),
		outcome.truncated ? `Results truncated after ${MAX_SEARCH_RESULTS} lines` : "",
	]
		.filter(Boolean)
		.join("\n");
};

const searchCommands = (query: string, path: string, regex: boolean): SearchCommand[] => {
	const exclusions = ["node_modules", ".git", "dist"];
	const rgArgs = [
		"--line-number",
		"--no-heading",
		"--color",
		"never",
		"--ignore-case",
		"--hidden",
		...exclusions.flatMap((directory) => ["--glob", `!**/${directory}/**`]),
		...(regex ? [] : ["--fixed-strings"]),
		"--",
		query,
		path,
	];
	const gitArgs = [
		"grep",
		"-n",
		"-I",
		"-i",
		"--untracked",
		regex ? "-E" : "-F",
		"-e",
		query,
		"--",
		path,
		...exclusions.map((directory) => `:(exclude,glob)**/${directory}/**`),
	];
	const grepArgs = [
		"-rn",
		"-i",
		regex ? "-E" : "-F",
		...exclusions.map((directory) => `--exclude-dir=${directory}`),
		"--",
		query,
		path,
	];

	return [
		{ label: "rg", command: "rg", args: rgArgs },
		{ label: "git grep", command: "git", args: gitArgs },
		{ label: "grep", command: "grep", args: grepArgs },
	];
};

const searchFiles = async (
	query: string,
	searchPath: string,
	regex: boolean,
	context: Parameters<Tool["execute"]>[1],
): Promise<string> => {
	for (const command of searchCommands(query, searchPath, regex)) {
		const outcome = await runSearchCommand(command, context.projectRoot, context.signal);
		if (isMissingCommandError(outcome.error)) continue;
		if (context.signal.aborted) throw new Error("Search cancelled by user");
		if (outcome.timedOut) throw new Error(`Search failed (${command.label}): timed out`);
		if (outcome.error)
			throw new Error(`Search failed (${command.label}): ${outcome.error.message}`);
		if (isGitRepositoryUnavailable(command, outcome)) continue;
		return searchCommandOutput(command, outcome);
	}
	throw new Error("Search failed: rg, git grep, and grep are unavailable");
};

export const search: Tool = {
	name: "search",
	description:
		"Search file contents case-insensitively using fixed strings by default; set regex to use a regular expression",
	schema: objSchema(["query"], {
		query: strProp("Text to search for"),
		path: strProp("Project-relative directory to search (default '.')"),
		regex: { type: "boolean", description: "Treat query as a regular expression" },
	}),
	needsApproval: false,
	requiresApproval: async (args, context) =>
		isPathOutsideProject(String(args.path ?? "."), context.projectRoot, true),
	timeout: SEARCH_TIMEOUT_MS + PROCESS_KILL_GRACE_MS + 1000,
	execute: async (args, context) => {
		const query = String(args.query ?? "");
		if (!query) throw new Error("Search query must not be empty");
		const path = String(args.path ?? ".");
		const fullPath = await resolveRealPath(path, context.projectRoot, true);
		const root = await realpath(context.projectRoot);
		const searchPath = relative(root, fullPath) || ".";
		return searchFiles(query, searchPath, args.regex === true, context);
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
	description:
		"Show git diff of working changes or between refs (output capped at 20,000 characters)",
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
		const output = await gitExec(cmd, context.projectRoot);
		if (output.length <= MAX_GIT_DIFF_OUTPUT_LENGTH) return output;
		const truncationNote = `\n… git diff truncated at ${MAX_GIT_DIFF_OUTPUT_LENGTH} characters`;
		return `${output.slice(0, MAX_GIT_DIFF_OUTPUT_LENGTH - truncationNote.length)}${truncationNote}`;
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
