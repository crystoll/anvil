import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import { type Registry, type Tool, createRegistry } from "../tools/registry.js";

export type ToolSettings = {
	read_file?: { deniedPaths?: string[] };
	write_file?: { allowedPaths?: string[]; deniedPaths?: string[] };
	edit_file?: { allowedPaths?: string[]; deniedPaths?: string[] };
	run_cmd?: { allowedCommands?: string[]; deniedCommands?: string[] };
};

export type HookDef = {
	command: string;
	timeout?: number;
	matcher?: string;
	async?: boolean;
};

export type HookEvent = "sessionStart" | "preToolUse" | "postToolUse" | "stop";

export type AgentHooks = Partial<Record<HookEvent, HookDef[]>>;

export type AgentDef = {
	name: string;
	description?: string;
	model?: string;
	prompt?: string;
	tools: string[];
	allowedTools?: string[];
	toolSettings?: ToolSettings;
	hooks?: AgentHooks;
};

export const loadAgentConfig = (filePath: string): Result<AgentDef, string> => {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return err(`Cannot read ${filePath}`);
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch {
		return err(`Invalid YAML in ${filePath}`);
	}

	if (!parsed || typeof parsed !== "object") return err(`Empty or invalid config in ${filePath}`);
	const obj = parsed as Record<string, unknown>;

	if (typeof obj.name !== "string" || !obj.name) return err("Agent config missing 'name'");
	if (!Array.isArray(obj.tools)) return err("Agent config missing 'tools' array");

	const def: AgentDef = {
		name: obj.name,
		tools: obj.tools as string[],
	};
	if (typeof obj.description === "string") def.description = obj.description;
	if (typeof obj.model === "string") def.model = obj.model;
	if (typeof obj.prompt === "string") def.prompt = obj.prompt;
	if (Array.isArray(obj.allowedTools)) def.allowedTools = obj.allowedTools as string[];
	if (obj.toolSettings && typeof obj.toolSettings === "object") {
		def.toolSettings = obj.toolSettings as ToolSettings;
	}
	if (obj.hooks && typeof obj.hooks === "object") {
		def.hooks = obj.hooks as AgentHooks;
	}
	return ok(def);
};

export const discoverAgents = (dirs: string[]): AgentDef[] => {
	const seen = new Set<string>();
	const agents: AgentDef[] = [];

	for (const dir of dirs) {
		let files: string[];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
		} catch {
			continue;
		}
		for (const file of files) {
			const result = loadAgentConfig(join(dir, file));
			if (result.isErr()) continue;
			const agent = result.value;
			if (seen.has(agent.name)) continue;
			seen.add(agent.name);
			agents.push(agent);
		}
	}
	return agents;
};

/** Create a filtered registry based on agent config. */
export const applyAgentToRegistry = (source: Registry, agent: AgentDef): Registry => {
	const allowedSet = new Set(agent.allowedTools ?? []);
	const useAll = agent.tools.includes("*");
	const toolSet = new Set(agent.tools);
	const filtered = createRegistry();

	for (const tool of source.all()) {
		if (!useAll && !toolSet.has(tool.name)) continue;
		const wrapped = wrapWithGuards(tool, agent.toolSettings);
		const override = allowedSet.has(wrapped.name) ? { ...wrapped, needsApproval: false } : wrapped;
		filtered.register(override);
	}
	return filtered;
};

const wrapWithGuards = (tool: Tool, settings: ToolSettings | undefined): Tool => {
	if (!settings) return tool;

	if (tool.name === "run_cmd" && settings.run_cmd) {
		const cmdSettings = settings.run_cmd;
		return {
			...tool,
			execute: async (args, root) => {
				const denial = checkCommand(String(args.command ?? ""), cmdSettings);
				return denial ?? tool.execute(args, root);
			},
		};
	}

	const pathSettings = settings[tool.name as keyof ToolSettings] as
		| { deniedPaths?: string[]; allowedPaths?: string[] }
		| undefined;
	if (pathSettings && (pathSettings.deniedPaths || pathSettings.allowedPaths)) {
		return {
			...tool,
			execute: async (args, root) => {
				const denial = checkPath(String(args.path ?? ""), pathSettings);
				return denial ?? tool.execute(args, root);
			},
		};
	}

	return tool;
};

type CmdSettings = { allowedCommands?: string[]; deniedCommands?: string[] };

/** Check command against allow/deny regex lists. Returns denial reason or undefined if allowed. */
export const checkCommand = (command: string, settings: CmdSettings): string | undefined => {
	for (const pattern of settings.deniedCommands ?? []) {
		if (new RegExp(`^${pattern}$`).test(command)) {
			return `DENIED: command matches deny pattern: ${pattern}`;
		}
	}
	return undefined;
};

type PathSettings = { allowedPaths?: string[]; deniedPaths?: string[] };

const globToRegex = (glob: string): RegExp => {
	const home = process.env.HOME ?? "/tmp";
	const expanded = glob.replace(/^~/, home);
	const escaped = expanded
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "⟨STAR⟩")
		.replace(/\*/g, "[^/]*")
		.replace(/⟨STAR⟩/g, ".*");
	return new RegExp(`^${escaped}$`);
};

/** Check path against allow/deny glob lists. Returns denial reason or undefined if allowed. */
export const checkPath = (filePath: string, settings: PathSettings): string | undefined => {
	for (const pattern of settings.deniedPaths ?? []) {
		if (globToRegex(pattern).test(filePath)) {
			return `DENIED: path matches deny pattern: ${pattern}`;
		}
	}
	if (settings.allowedPaths && settings.allowedPaths.length > 0) {
		const allowed = settings.allowedPaths.some((p) => globToRegex(p).test(filePath));
		if (!allowed) return "DENIED: path not in allowedPaths";
	}
	return undefined;
};
