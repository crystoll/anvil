import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fetchAndExtract } from "../web/web-fetch.js";
import { searchWeb } from "../web/web-search.js";
import type { Tool } from "./registry.js";

const expandTilde = (p: string): string => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const HISTORY_DIR = ".anvil/file-history";

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

/** Execute a shell command with timeout. */
export const runCmd: Tool = {
	name: "run_cmd",
	description: "Execute a shell command and return stdout/stderr with exit code",
	schema: objSchema(["command"], { command: strProp("Shell command to execute") }),
	needsApproval: true,
	timeout: 300_000,
	execute: (args, projectRoot) =>
		new Promise((res) => {
			const command = String(args.command ?? "");
			execFile(
				"sh",
				["-c", command],
				{ cwd: projectRoot, timeout: 300_000 },
				(error, stdout, stderr) => {
					const exitCode = error && "code" in error ? (error.code as number) : 0;
					const output = (stdout + stderr).slice(0, 8000);
					res(`$ ${command}\nExit code: ${exitCode}\n${output ? `Output:\n${output}` : ""}`);
				},
			);
		}),
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
	execute: async (args, projectRoot) => {
		const path = String(args.path ?? "");
		const offset = Math.max(1, Number(args.offset) || 1);
		const limit = Math.min(500, Math.max(1, Number(args.limit) || 200));
		const fullPath = resolve(projectRoot, expandTilde(path));

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
	execute: async (args, projectRoot) => {
		const path = String(args.path ?? "");
		const content = String(args.content ?? "");
		const fullPath = resolve(projectRoot, path);

		await backupFile(fullPath, projectRoot);
		await mkdir(join(fullPath, ".."), { recursive: true });
		await writeFile(fullPath, content, "utf-8");
		return `Wrote ${content.split("\n").length} lines to ${path}`;
	},
};

/** Search and replace in a file. */
export const editFileTool: Tool = {
	name: "edit_file",
	description: "Search and replace text in a file",
	schema: objSchema(["path", "search", "replace"], {
		path: strProp("Project-relative file path"),
		search: strProp("Exact text to find"),
		replace: strProp("Replacement text"),
	}),
	needsApproval: true,
	timeout: 5000,
	execute: async (args, projectRoot) => {
		const path = String(args.path ?? "");
		const search = String(args.search ?? "");
		const replace = String(args.replace ?? "");
		const fullPath = resolve(projectRoot, path);

		const content = await readFile(fullPath, "utf-8");
		if (!content.includes(search)) {
			throw new Error(`Search string not found in ${path}`);
		}
		await backupFile(fullPath, projectRoot);
		const updated = content.replace(search, replace);
		await writeFile(fullPath, updated, "utf-8");
		return `Edited ${path}: replaced ${search.split("\n").length} lines`;
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
	execute: async (args, projectRoot) => {
		const path = String(args.path ?? ".");
		const fullPath = resolve(projectRoot, path);
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
	execute: async (args, projectRoot) => {
		const pattern = String(args.pattern ?? "");
		return new Promise<string>((res) => {
			execFile(
				"find",
				[projectRoot, "-path", `*/${pattern}`.replace("**/", ""), "-type", "f"],
				{ timeout: 10_000 },
				(_, stdout) => {
					const files = stdout
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((f) => relative(projectRoot, f))
						.slice(0, 100);
					res(files.length > 0 ? files.join("\n") : "No files found");
				},
			);
		});
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
	execute: async (args, projectRoot) => {
		const query = String(args.query ?? "");
		const path = String(args.path ?? ".");
		const searchDir = resolve(projectRoot, path);

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
						.map((f) => relative(projectRoot, f))
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
export const projectContext: Tool = {
	name: "project_context",
	description: "Get project overview: package.json info, file tree, git status, and recent commits",
	schema: objSchema([], {}),
	needsApproval: false,
	timeout: 10_000,
	execute: async (_, projectRoot) => {
		const parts: string[] = [];

		try {
			const pkg = await readFile(join(projectRoot, "package.json"), "utf-8");
			const { name, version, description, scripts, dependencies, devDependencies } =
				JSON.parse(pkg);
			const deps = Object.keys(dependencies ?? {});
			const devDeps = Object.keys(devDependencies ?? {});
			parts.push(
				`## package.json\nname: ${name}  version: ${version}${description ? `\n${description}` : ""}${scripts ? `\nscripts: ${Object.keys(scripts).join(", ")}` : ""}${deps.length ? `\ndependencies: ${deps.join(", ")}` : ""}${devDeps.length ? `\ndevDependencies: ${devDeps.join(", ")}` : ""}`,
			);
		} catch {}

		try {
			const tsconfig = await readFile(join(projectRoot, "tsconfig.json"), "utf-8");
			const { compilerOptions } = JSON.parse(tsconfig);
			if (compilerOptions) {
				const fields = ["target", "module", "moduleResolution", "strict"]
					.filter((k) => compilerOptions[k] !== undefined)
					.map((k) => `${k}: ${compilerOptions[k]}`);
				if (fields.length) parts.push(`## tsconfig.json\n${fields.join(", ")}`);
			}
		} catch {}

		const tree = await new Promise<string>((res) => {
			execFile(
				"find",
				[
					projectRoot,
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
				],
				{ timeout: 5000 },
				(_, stdout) => {
					const files = stdout
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((f) => relative(projectRoot, f))
						.sort();
					res(
						`## Files (${files.length})\n${files.slice(0, 60).join("\n")}${files.length > 60 ? `\n... and ${files.length - 60} more` : ""}`,
					);
				},
			);
		});
		parts.push(tree);

		const status = await gitExec(["status", "--short", "--branch"], projectRoot);
		parts.push(`## Git\n${status}`);

		const log = await gitExec(["log", "--oneline", "-5"], projectRoot);
		if (log.trim()) parts.push(`## Recent commits\n${log}`);

		return parts.join("\n\n");
	},
};

/** Git status. */
export const gitStatus: Tool = {
	name: "git_status",
	description: "Show git working tree status (modified, staged, untracked files)",
	schema: objSchema([], {}),
	needsApproval: false,
	timeout: 5000,
	execute: async (_, projectRoot) => gitExec(["status", "--short", "--branch"], projectRoot),
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
	execute: async (args, projectRoot) => {
		const cmd = ["diff"];
		if (args.staged) cmd.push("--cached");
		if (args.ref) cmd.push(String(args.ref));
		return gitExec(cmd, projectRoot);
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
	execute: async (args, projectRoot) => {
		const count = Math.min(50, Math.max(1, Number(args.count) || 10));
		const cmd = ["log", "--oneline", `-${count}`];
		if (args.ref) cmd.push(String(args.ref));
		return gitExec(cmd, projectRoot);
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
	execute: async (args) => {
		const query = String(args.query ?? "");
		const max = Number(args.max_results ?? 5);
		const result = await searchWeb(query, max);
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
	execute: async (args) => {
		const url = String(args.url ?? "");
		const maxLength = Number(args.max_length ?? 8000);
		const result = await fetchAndExtract(url, maxLength);
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
