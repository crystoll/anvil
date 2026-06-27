import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentLoop } from "../agent/index.js";
import { type AgentDef, applyAgentToRegistry, discoverAgents, runHooks } from "../agents/index.js";
import { type AnvilConfig, loadConfig, type ProviderEntry } from "../config/config.js";
import { createEngine } from "../engine/index.js";
import { VERSION } from "../index.js";
import {
	createDiagnosticInjector,
	createLspDefinitionTool,
	createLspDiagnosticsTool,
	createLspHoverTool,
	createLspManager,
	createLspReferencesTool,
	createLspRenameTool,
	createLspSymbolsTool,
	type LspManager,
	loadLspConfig,
} from "../lsp/index.js";
import {
	type ConnectedServer,
	connectServer,
	disconnectServer,
	loadMcpConfig,
	mcpToolsToAnvil,
} from "../mcp/index.js";
import { createProvider, type Provider } from "../provider/index.js";
import { listSessions, loadSession } from "../session/index.js";
import { discoverSkills, type Skill } from "../skills/index.js";
import { builtinTools, createRegistry } from "../tools/index.js";

// === Types ===

export type Flags = {
	model: string | undefined;
	skill: string | undefined;
	agent: string | undefined;
	command: string | undefined;
	path: string | undefined;
	resume: boolean;
	debug: boolean;
};

export type AppContext = {
	config: AnvilConfig;
	projectRoot: string;
	engine: ReturnType<typeof createEngine>;
	registry: ReturnType<typeof createRegistry>;
	agent: ReturnType<typeof createAgentLoop>;
	provider: Provider;
	activeProviderName: string;
	availableSkills: Skill[];
	activeSkill: Skill | undefined;
	availableAgents: AgentDef[];
	activeAgent: AgentDef | undefined;
	mcpServers: ConnectedServer[];
	lspManager: LspManager | undefined;
	sessionId: string | undefined;
	historyDir: string;
	buildPrompt: () => string;
	fireStopHooks: () => Promise<void>;
	setActiveSkill: (s: Skill | undefined) => void;
	setActiveAgent: (a: AgentDef) => void;
	shutdown: () => Promise<void>;
};

// === Paths ===

const home = homedir();

export const paths = (projectRoot: string) => ({
	configPath: join(home, ".anvil", "config.yaml"),
	historyDir: join(home, ".anvil", "history"),
	promptPath: join(projectRoot, ".anvil", "prompt.md"),
	mcpPaths: [
		join(projectRoot, ".anvil", "mcp.json"),
		join(projectRoot, ".mcp.json"),
		join(home, ".anvil", "mcp.json"),
	],
	skillDirs: [
		join(projectRoot, ".anvil", "skills"),
		join(projectRoot, ".kiro", "skills"),
		join(projectRoot, ".claude", "skills"),
		join(home, ".anvil", "skills"),
		join(home, ".kiro", "skills"),
		join(home, ".claude", "skills"),
	],
	agentDirs: [join(projectRoot, ".anvil", "agents"), join(home, ".anvil", "agents")],
});

// === Flags ===

export const parseFlags = (argv: string[]): Flags => {
	const args = argv.slice(2);
	if (args.includes("--version")) {
		console.log(VERSION);
		process.exit(0);
	}
	const flagVal = (flag: string): string | undefined => {
		const i = args.indexOf(flag);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const flagIndices = new Set(
		["--model", "--skill", "--agent", "-c"]
			.map((f) => args.indexOf(f))
			.filter((i) => i >= 0)
			.flatMap((i) => [i, i + 1]),
	);
	const posIdx = args.findIndex((a, i) => !a.startsWith("-") && !flagIndices.has(i));

	return {
		model: flagVal("--model"),
		skill: flagVal("--skill"),
		agent: flagVal("--agent"),
		command: flagVal("-c"),
		path: posIdx >= 0 ? args[posIdx] : undefined,
		resume: args.includes("--resume"),
		debug: args.includes("--debug"),
	};
};

// === Provider helpers ===

export const makeProvider = (
	name: string,
	entry: ProviderEntry,
	timeouts: { streamTimeout: number; connectTimeout: number },
): Provider =>
	createProvider(name, {
		endpoint: entry.endpoint,
		...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
		streamTimeout: timeouts.streamTimeout,
		connectTimeout: timeouts.connectTimeout,
	});

/** Resolve fully-qualified model name to provider + model. */
export const resolveProviderModel = (
	modelStr: string,
	providers: Record<string, ProviderEntry>,
	defaultProvider: string,
): { provider: string; model: string } => {
	const slash = modelStr.indexOf("/");
	if (slash > 0 && providers[modelStr.slice(0, slash)]) {
		return { provider: modelStr.slice(0, slash), model: modelStr.slice(slash + 1) };
	}
	return { provider: defaultProvider, model: modelStr };
};

// === MCP hint ===

export const buildMcpHint = (servers: ConnectedServer[]): string => {
	if (servers.length === 0) return "";
	const groups = servers.map((s) => {
		const names = s.tools.map((t) => `${s.name}.${t.name}`).join(", ");
		return `- "${s.name}" tools (${names}): Use these together as a group.`;
	});
	return `\nYou have access to external tool servers:\n${groups.join("\n")}\nPrefer prefixed tools over general-purpose tools for that resource.`;
};

// === expandFileRefs ===

const MAX_FILE_CHARS = 8000;

export const expandFileRefs = (input: string, root: string): string =>
	input.replace(/(^|[\s])@([\w./-]+)/g, (match, prefix: string, p: string) => {
		const filePath = resolve(root, p);
		if (!existsSync(filePath)) return match;
		try {
			const content = readFileSync(filePath, "utf-8");
			if (content.length > MAX_FILE_CHARS)
				return `${prefix}<file path="${p}">\n${content.slice(0, MAX_FILE_CHARS)}\n[truncated, use read_file for full content]\n</file>`;
			return `${prefix}<file path="${p}">\n${content}\n</file>`;
		} catch {
			return match;
		}
	});

// === Base prompt ===

const BASE_PROMPT = `You are Anvil, a local-first coding assistant running in a terminal.
You have tools for: shell commands, file operations, directory listing, web search, and reading web pages. Use them when you need real data. Call tools silently and base your answers on the results.
When a task requires multiple steps, execute all steps in sequence.
Keep responses concise. Use markdown formatting when it helps readability.
When you don't know something, say so.
Never output raw protocol tokens like <tool_response>, <tool_call>, or similar markup in your responses.`;

// === Bootstrap internals ===

const loadConfigOrExit = (configPath: string) => {
	const result = loadConfig(configPath);
	if (result.isErr()) {
		console.error(`Config error: ${result.error.message}`);
		process.exit(1);
	}
	const config = result.value;
	const entry = config.providers[config.defaultProvider];
	if (!entry) {
		console.error(`Provider "${config.defaultProvider}" not found in config`);
		process.exit(1);
	}
	return { config, defaultEntry: entry };
};

const setupMcp = async (
	mcpPaths: string[],
	registry: ReturnType<typeof createRegistry>,
): Promise<ConnectedServer[]> => {
	const cfg = loadMcpConfig(mcpPaths);
	if (cfg.isErr()) return [];
	const servers: ConnectedServer[] = [];
	for (const [name, conf] of Object.entries(cfg.value)) {
		const result = await connectServer(name, conf);
		if (typeof result === "string") continue;
		for (const tool of mcpToolsToAnvil(result)) registry.register(tool);
		servers.push(result);
	}
	return servers;
};

const setupLsp = (projectRoot: string, registry: ReturnType<typeof createRegistry>) => {
	const cfg = loadLspConfig(projectRoot);
	if (!cfg) return { lspManager: undefined, diagnosticInjector: undefined };
	const manager = createLspManager(cfg, projectRoot);
	registry.register(createLspDiagnosticsTool(manager));
	registry.register(createLspDefinitionTool(manager));
	registry.register(createLspReferencesTool(manager));
	registry.register(createLspHoverTool(manager));
	registry.register(createLspSymbolsTool(manager));
	registry.register(createLspRenameTool(manager));
	return {
		lspManager: manager as LspManager,
		diagnosticInjector: createDiagnosticInjector(manager, projectRoot),
	};
};

const tryResumeSession = (
	historyDir: string,
	engine: ReturnType<typeof createEngine>,
): string | undefined => {
	const sessions = listSessions(historyDir);
	if (!sessions[0]) return undefined;
	const loaded = loadSession(historyDir, sessions[0].id);
	if (loaded.isErr()) return undefined;
	engine.loadMessages(loaded.value.messages);
	return sessions[0].id;
};

// === Bootstrap (public) ===

export const bootstrap = async (flags: Flags): Promise<AppContext> => {
	const projectRoot = flags.path ? resolve(flags.path) : process.cwd();
	const p = paths(projectRoot);
	const { config, defaultEntry } = loadConfigOrExit(p.configPath);
	const timeouts = { streamTimeout: config.streamTimeout, connectTimeout: config.connectTimeout };

	// Provider + engine
	const resolved = resolveProviderModel(
		flags.model ?? config.defaultModel,
		config.providers,
		config.defaultProvider,
	);
	const bootEntry = config.providers[resolved.provider] ?? defaultEntry;
	const provider = makeProvider(resolved.provider, bootEntry, timeouts);
	const activeProviderName = resolved.provider;
	const engine = createEngine(provider, resolved.model);

	// Registry + skills + agents
	const registry = createRegistry();
	for (const tool of builtinTools) registry.register(tool);
	const availableSkills = discoverSkills(p.skillDirs);
	let activeSkill: Skill | undefined = flags.skill
		? availableSkills.find((s) => s.name === flags.skill)
		: undefined;
	const availableAgents = discoverAgents(p.agentDirs);
	let activeAgent: AgentDef | undefined = flags.agent
		? availableAgents.find((a) => a.name === flags.agent)
		: availableAgents.find((a) => a.name === "default");
	if (activeAgent) applyAgentToRegistry(registry, activeAgent);
	if (activeAgent?.model) engine.setModel(activeAgent.model);

	// MCP + LSP
	const mcpServers = await setupMcp(p.mcpPaths, registry);
	const { lspManager, diagnosticInjector } = setupLsp(projectRoot, registry);

	// Prompt
	const projectPrompt = existsSync(p.promptPath)
		? readFileSync(p.promptPath, "utf-8").trim()
		: undefined;
	const buildPrompt = (): string =>
		[projectPrompt, activeAgent?.prompt, activeSkill?.body, BASE_PROMPT]
			.filter(Boolean)
			.join("\n\n") + buildMcpHint(mcpServers);

	// Agent loop
	const agentHooks = activeAgent?.hooks ?? {};
	const hookCtx = { session_id: Date.now().toString(), cwd: projectRoot };
	const agent = createAgentLoop(engine, registry, {
		maxRounds: config.maxRounds,
		projectRoot,
		systemPrompt: buildPrompt(),
		streamOpts: { contextSize: config.contextSize },
		onBeforeToolUse: async (toolName, args) =>
			runHooks(agentHooks.preToolUse ?? [], {
				...hookCtx,
				hook_event_name: "preToolUse",
				tool_name: toolName,
				tool_args: args,
			}),
		onAfterToolUse: (toolName, args, result) => {
			runHooks(agentHooks.postToolUse ?? [], {
				...hookCtx,
				hook_event_name: "postToolUse",
				tool_name: toolName,
				tool_args: args,
				tool_result: result.substring(0, 500),
			});
		},
		...(diagnosticInjector ? { transformToolResult: diagnosticInjector } : {}),
	});
	runHooks(agentHooks.sessionStart ?? [], { ...hookCtx, hook_event_name: "sessionStart" });

	const sessionId = flags.resume ? tryResumeSession(p.historyDir, engine) : undefined;

	return {
		config,
		projectRoot,
		engine,
		registry,
		agent,
		provider,
		activeProviderName,
		availableSkills,
		activeSkill,
		availableAgents,
		activeAgent,
		mcpServers,
		lspManager,
		sessionId,
		historyDir: p.historyDir,
		buildPrompt,
		fireStopHooks: async () => {
			await runHooks(agentHooks.stop ?? [], { ...hookCtx, hook_event_name: "stop" });
		},
		setActiveSkill: (s) => {
			activeSkill = s;
		},
		setActiveAgent: (a) => {
			activeAgent = a;
			applyAgentToRegistry(registry, a);
		},
		shutdown: async () => {
			await Promise.all(mcpServers.map(disconnectServer));
			await lspManager?.shutdown();
		},
	};
};
