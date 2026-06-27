import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { createAgentLoop } from "./agent/index.js";
import type { AgentEvent } from "./agent/loop.js";
import { type AgentDef, applyAgentToRegistry, discoverAgents, runHooks } from "./agents/index.js";
import { loadConfig } from "./config/index.js";
import { createEngine } from "./engine/index.js";
import { VERSION } from "./index.js";
import {
	createDiagnosticInjector,
	createLspDefinitionTool,
	createLspDiagnosticsTool,
	createLspHoverTool,
	createLspManager,
	createLspReferencesTool,
	createLspRenameTool,
	createLspSymbolsTool,
	loadLspConfig,
} from "./lsp/index.js";
import type { LspManager } from "./lsp/index.js";
import {
	type ConnectedServer,
	connectServer,
	disconnectServer,
	loadMcpConfig,
	mcpToolsToAnvil,
} from "./mcp/index.js";
import { type Provider, createProvider } from "./provider/index.js";
import { listSessions, loadSession, saveSession } from "./session/index.js";
import { type Skill, discoverSkills } from "./skills/index.js";
import { startSpinner } from "./spinner.js";
import { builtinTools, createRegistry } from "./tools/index.js";
import { createStatusBar } from "./ui/statusbar.js";

const CONFIG_PATH = join(homedir(), ".anvil", "config.yaml");
const HISTORY_DIR = join(homedir(), ".anvil", "history");

/** Resolved once in main() from positional arg or cwd. */
let projectRoot = process.cwd();

const getProjectPaths = () => ({
	promptPath: join(projectRoot, ".anvil", "prompt.md"),
	mcpPaths: [
		join(projectRoot, ".anvil", "mcp.json"),
		join(projectRoot, ".mcp.json"),
		join(homedir(), ".anvil", "mcp.json"),
	],
	skillDirs: [
		join(projectRoot, ".anvil", "skills"),
		join(projectRoot, ".kiro", "skills"),
		join(projectRoot, ".claude", "skills"),
		join(homedir(), ".anvil", "skills"),
		join(homedir(), ".kiro", "skills"),
		join(homedir(), ".claude", "skills"),
	],
	agentDirs: [join(projectRoot, ".anvil", "agents"), join(homedir(), ".anvil", "agents")],
});

const BASE_PROMPT = `You are Anvil, a local-first coding assistant running in a terminal.

You have tools for: shell commands, file operations, directory listing, web search, and reading web pages. Use them when you need real data — don't guess at file contents, project structure, or current information. Call tools silently and base your answers on the results.

When a task requires multiple steps (search then read, list then inspect), execute all steps in sequence — call the next tool immediately rather than describing what you would do. Do not stop after one tool call if more are needed to fulfill the request.

Keep responses concise. Use markdown formatting (code blocks, lists) when it helps readability. You're rendering in a terminal — no images, no HTML.

When you don't know something, say so. Don't invent file contents or fabricate search results.`;

/** Build an MCP-aware system prompt addition when MCP servers are connected. */
const buildMcpPromptHint = (servers: ConnectedServer[]): string | undefined => {
	if (servers.length === 0) return undefined;
	const groups = servers.map((s) => {
		const toolNames = s.tools.map((t) => `${s.name}.${t.name}`).join(", ");
		return `- "${s.name}" tools (${toolNames}): Use these together as a group. Results from one tool (like paths or IDs) should be passed to other tools in the same group, not to general file/shell tools.`;
	});
	return `\nYou have access to external tool servers:\n${groups.join("\n")}\n\nWhen a prefixed tool group provides specialized access (e.g., reading notes from a vault), always prefer those tools over general-purpose tools like read_file or run_cmd for that resource.`;
};

const parseArgs = () => {
	const args = process.argv.slice(2);
	if (args.includes("--version")) {
		console.log(VERSION);
		process.exit(0);
	}
	const modelIdx = args.indexOf("--model");
	const model = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
	const skillIdx = args.indexOf("--skill");
	const skill = skillIdx >= 0 ? args[skillIdx + 1] : undefined;
	const agentIdx = args.indexOf("--agent");
	const agent = agentIdx >= 0 ? args[agentIdx + 1] : undefined;
	const cmdIdx = args.indexOf("-c");
	const command = cmdIdx >= 0 ? args[cmdIdx + 1] : undefined;

	// Positional path argument — first arg that's not a flag or flag value
	const flagIndices = new Set(
		[modelIdx, skillIdx, agentIdx, cmdIdx].filter((i) => i >= 0).flatMap((i) => [i, i + 1]),
	);
	const positional = args.findIndex((a, i) => !a.startsWith("-") && !flagIndices.has(i));
	const path = positional >= 0 ? args[positional] : undefined;

	return {
		resume: args.includes("--resume"),
		debug: args.includes("--debug"),
		...(model ? { model } : {}),
		...(skill ? { skill } : {}),
		...(agent ? { agent } : {}),
		...(command ? { command } : {}),
		...(path ? { path } : {}),
	};
};

const resumeSession = (engine: ReturnType<typeof createEngine>): string | undefined => {
	const sessions = listSessions(HISTORY_DIR);
	const latest = sessions[0];
	if (!latest) return undefined;
	const loaded = loadSession(HISTORY_DIR, latest.id);
	if (loaded.isErr()) return undefined;
	engine.loadMessages(loaded.value.messages);
	console.log(`Resumed session ${latest.id}`);
	return latest.id;
};

const setupSkills = (flags: { skill?: string }) => {
	const paths = getProjectPaths();
	const availableSkills = discoverSkills(paths.skillDirs);
	let activeSkill: Skill | undefined;
	if (flags.skill) {
		activeSkill = availableSkills.find((s) => s.name === flags.skill);
		if (!activeSkill) console.log(`Skill "${flags.skill}" not found`);
	}
	const projectPrompt = existsSync(paths.promptPath)
		? readFileSync(paths.promptPath, "utf-8").trim()
		: undefined;
	const buildPrompt = (): string => {
		const parts = [projectPrompt, activeSkill?.body, BASE_PROMPT].filter(Boolean);
		return parts.join("\n\n");
	};
	return { availableSkills, activeSkill, buildPrompt };
};

const connectMcpServers = async (
	registry: ReturnType<typeof createRegistry>,
): Promise<ConnectedServer[]> => {
	const configResult = loadMcpConfig(getProjectPaths().mcpPaths);
	if (configResult.isErr()) {
		console.log(`MCP config warning: ${configResult.error}`);
		return [];
	}
	const entries = Object.entries(configResult.value);
	if (entries.length === 0) return [];

	const servers: ConnectedServer[] = [];
	for (const [name, config] of entries) {
		const result = await connectServer(name, config);
		if (typeof result === "string") {
			console.log(result);
			continue;
		}
		const tools = mcpToolsToAnvil(result);
		for (const tool of tools) registry.register(tool);
		servers.push(result);
	}
	if (servers.length > 0) {
		const toolCount = servers.reduce((n, s) => n + s.tools.length, 0);
		console.log(`MCP: ${servers.length} server(s), ${toolCount} tools\n`);
	}
	return servers;
};

const setupAgent = (flags: { agent?: string }) => {
	const baseRegistry = createRegistry();
	for (const tool of builtinTools) baseRegistry.register(tool);

	const availableAgents = discoverAgents(getProjectPaths().agentDirs);
	let activeAgent: AgentDef | undefined;
	if (flags.agent) {
		activeAgent = availableAgents.find((a) => a.name === flags.agent);
		if (!activeAgent) console.log(`Agent "${flags.agent}" not found`);
	}

	return { baseRegistry, availableAgents, activeAgent };
};

const setupLsp = (registry: ReturnType<typeof createRegistry>): LspManager | undefined => {
	const config = loadLspConfig(projectRoot);
	if (!config) return undefined;
	const manager = createLspManager(config, projectRoot);
	registry.register(createLspDiagnosticsTool(manager));
	registry.register(createLspDefinitionTool(manager));
	registry.register(createLspReferencesTool(manager));
	registry.register(createLspHoverTool(manager));
	registry.register(createLspSymbolsTool(manager));
	registry.register(createLspRenameTool(manager));
	console.log("LSP: configured");
	return manager;
};

const loadConfigOrExit = () => {
	const configResult = loadConfig(CONFIG_PATH);
	if (configResult.isErr()) {
		console.error(`Config error: ${configResult.error.message}`);
		process.exit(1);
	}
	const config = configResult.value;
	const providerEntry = config.providers[config.defaultProvider];
	if (!providerEntry) {
		console.error(`Provider "${config.defaultProvider}" not found in config`);
		process.exit(1);
	}
	return { config, providerEntry };
};

const runOneShot = async (
	agent: Agent,
	command: string,
	mcpServers: ConnectedServer[],
	lspManager?: LspManager,
): Promise<void> => {
	let spinner = startSpinner();
	let active = true;
	const stop = () => {
		if (active) {
			spinner.stop();
			active = false;
		}
	};
	const restart = () => {
		spinner = startSpinner();
		active = true;
	};

	const processEvents = async (events: AsyncIterable<AgentEvent>) => {
		for await (const event of events) {
			if (event.kind !== "usage" && event.kind !== "state" && event.kind !== "round") stop();
			if (event.kind === "pending") {
				restart();
				const gen = agent.approve();
				await processEvents(gen);
				return;
			}
			displayEvent(event);
			if (event.kind === "tool_result") restart();
		}
	};

	await processEvents(agent.send(expandFileRefs(command, projectRoot)));
	flushUsage();
	stdout.write("\n");
	await Promise.all(mcpServers.map(disconnectServer));
	await lspManager?.shutdown();
};

const main = async () => {
	const flags = parseArgs();
	if (flags.path) {
		projectRoot = resolve(flags.path);
		process.chdir(projectRoot);
	}

	const { config, providerEntry } = loadConfigOrExit();
	showTokens = config.showTokens;

	const provider = createProvider(config.defaultProvider, {
		endpoint: providerEntry.endpoint,
		...(providerEntry.apiKey ? { apiKey: providerEntry.apiKey } : {}),
		streamTimeout: config.streamTimeout,
		connectTimeout: config.connectTimeout,
	});

	debugMode = flags.debug;
	const engine = createEngine(provider, flags.model ?? config.defaultModel);

	const { baseRegistry, availableAgents, activeAgent } = setupAgent(flags);
	if (activeAgent?.model) engine.setModel(activeAgent.model);

	// Connect MCP servers and register their tools
	const mcpServers = await connectMcpServers(baseRegistry);

	// LSP setup (lazy — starts server on first relevant file operation)
	const lspManager = setupLsp(baseRegistry);

	const registry = activeAgent ? applyAgentToRegistry(baseRegistry, activeAgent) : baseRegistry;

	let sessionId: string | undefined = flags.resume ? resumeSession(engine) : undefined;

	const { availableSkills, activeSkill, buildPrompt } = setupSkills(flags);

	const agentHooks = activeAgent?.hooks ?? {};
	const hookCtxBase = { session_id: Date.now().toString(), cwd: projectRoot };

	const agent = createAgentLoop(engine, registry, {
		maxRounds: config.maxRounds,
		projectRoot,
		systemPrompt: buildPrompt() + (buildMcpPromptHint(mcpServers) ?? ""),
		streamOpts: { contextSize: config.contextSize },
		onBeforeToolUse: async (toolName, args) =>
			runHooks(agentHooks.preToolUse ?? [], {
				...hookCtxBase,
				hook_event_name: "preToolUse",
				tool_name: toolName,
				tool_args: args,
			}),
		onAfterToolUse: (toolName, args, result) => {
			runHooks(agentHooks.postToolUse ?? [], {
				...hookCtxBase,
				hook_event_name: "postToolUse",
				tool_name: toolName,
				tool_args: args,
				tool_result: result.substring(0, 500),
			});
		},
		...(lspManager
			? { transformToolResult: createDiagnosticInjector(lspManager, projectRoot) }
			: {}),
	});

	// Fire sessionStart hooks
	runHooks(agentHooks.sessionStart ?? [], { ...hookCtxBase, hook_event_name: "sessionStart" });

	// Non-interactive one-shot mode
	if (flags.command) {
		await runOneShot(agent, flags.command, mcpServers, lspManager);
		return;
	}

	console.log(`anvil — ${config.defaultProvider}/${engine.model()} — ${projectRoot}`);
	if (activeAgent) console.log(`agent: ${activeAgent.name}`);
	if (activeSkill) console.log(`skill: ${activeSkill.name}`);
	console.log("Type /quit to exit, /skill to list, /model <name> to switch\n");

	const rl = createInterface({ input: stdin, output: stdout });
	try {
		const ctx = {
			availableSkills,
			activeSkill,
			availableAgents,
			activeAgent,
			buildPrompt,
			agent,
			engine,
			provider,
			contextSize: config.contextSize,
			toolCount: registry.all().length,
			toolTokens: Math.round(JSON.stringify(registry.schemas()).length / 4),
			fireStopHooks: async () => {
				await runHooks(agentHooks.stop ?? [], { ...hookCtxBase, hook_event_name: "stop" });
			},
		};
		sessionId = await chatLoop(rl, ctx, sessionId);
	} finally {
		rl.close();
		await Promise.all(mcpServers.map(disconnectServer));
		await lspManager?.shutdown();
		if (sessionTokens.total > 0) {
			console.log(`\nSession: ${sessionTokens.total} tokens (${sessionTokens.prompt} prompt)`);
		}
	}
};

type CliContext = {
	availableSkills: Skill[];
	activeSkill: Skill | undefined;
	availableAgents: AgentDef[];
	activeAgent: AgentDef | undefined;
	buildPrompt: () => string;
	agent: Agent;
	engine: ReturnType<typeof createEngine>;
	provider: Provider;
	contextSize: number;
	toolCount: number;
	toolTokens: number;
	fireStopHooks: () => Promise<void>;
};

type Agent = ReturnType<typeof createAgentLoop>;

let sessionTokens = { prompt: 0, total: 0 };
let showTokens = true;
let debugMode = false;
let pendingUsageDisplay = "";
const statusBar = createStatusBar();

const displayEvent = (event: AgentEvent): void => {
	if (event.kind === "reasoning") stdout.write(`\x1b[2m${event.text}\x1b[0m`);
	if (event.kind === "content") stdout.write(event.text);
	if (event.kind === "tool_result") displayToolResult(event);
	if (event.kind === "usage") {
		sessionTokens.prompt += event.promptTokens;
		sessionTokens.total += event.totalTokens;
		const completion = event.totalTokens - event.promptTokens;
		const reason = debugMode && event.finishReason ? ` ${event.finishReason}` : "";
		pendingUsageDisplay = showTokens
			? `\n\x1b[2m[${event.promptTokens}→${completion} tok${reason}]\x1b[0m`
			: "";
	}
	if (event.kind === "done") stdout.write(`\n✓ ${event.message}`);
	if (event.kind === "stuck") stdout.write(`\n✗ ${event.message}`);
	if (event.kind === "error") stdout.write(`\n[error: ${event.message}]`);
	if (event.kind === "trimmed")
		stdout.write(`\x1b[2m[trimmed ${event.count} old messages]\x1b[0m\n`);
};

const displayToolResult = (event: AgentEvent & { kind: "tool_result" }): void => {
	const preview =
		event.result.length > 500
			? `\x1b[2m${event.result.slice(0, 500)}… (${event.result.length} chars)\x1b[0m\n`
			: "";
	stdout.write(`\n  \x1b[2m↳ \x1b[36m${event.name}\x1b[2m done\x1b[0m\n${preview}`);
	if (pendingUsageDisplay) {
		stdout.write(pendingUsageDisplay);
		pendingUsageDisplay = "";
	}
};

const formatPending = (event: AgentEvent & { kind: "pending" }): string => {
	const { tool, args } = event.call;
	if (tool.name === "edit_file" && args.old_text && args.new_text) {
		return formatEditDiff(String(args.path ?? ""), String(args.old_text), String(args.new_text));
	}
	if (tool.name === "write_file" && args.content) {
		const content = String(args.content);
		const preview = content.length > 300 ? `${content.slice(0, 300)}…` : content;
		return `\n  🔧 \x1b[36m${tool.name}\x1b[0m\x1b[2m(${args.path})\x1b[0m\n\x1b[32m${preview}\x1b[0m`;
	}
	const argsStr = Object.entries(args)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join(", ");
	return `\n  🔧 \x1b[36m${tool.name}\x1b[0m\x1b[2m(${argsStr})\x1b[0m`;
};

const formatEditDiff = (path: string, oldText: string, newText: string): string => {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const lines = [`\n  🔧 edit_file(${path})`];
	for (const l of oldLines) lines.push(`\x1b[31m  - ${l}\x1b[0m`);
	for (const l of newLines) lines.push(`\x1b[32m  + ${l}\x1b[0m`);
	return lines.join("\n");
};

const printModelList = async (ctx: CliContext): Promise<void> => {
	console.log(`Current model: ${ctx.engine.model()}`);
	const result = await ctx.provider.listModels();
	if (result.isOk()) {
		console.log("\nAvailable models:");
		for (const m of result.value) console.log(`  ${m === ctx.engine.model() ? "* " : "  "}${m}`);
	}
};

const setDefaultModel = (model: string, ctx: CliContext): void => {
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	const updated = raw.replace(/^default_model:.*/m, `default_model: ${model}`);
	writeFileSync(CONFIG_PATH, updated);
	ctx.engine.setModel(model);
	console.log(`Default model set to: ${model}`);
};

const handleModelCommand = async (input: string, ctx: CliContext): Promise<void> => {
	const arg = input.replace("/model", "").trim();
	if (!arg) return printModelList(ctx);

	if (arg.startsWith("set ")) {
		const model = arg.slice(4).trim();
		if (model) setDefaultModel(model, ctx);
		return;
	}

	const result = await ctx.provider.listModels();
	if (result.isOk() && !result.value.includes(arg)) {
		console.log(`Model "${arg}" not found. Available models:`);
		for (const m of result.value) console.log(`  ${m}`);
		return;
	}
	ctx.engine.setModel(arg);
	console.log(`Switched to: ${arg}`);
};

const handleSkillCommand = (input: string, ctx: CliContext): void => {
	const name = input.replace("/skill", "").trim();
	if (!name) {
		if (ctx.availableSkills.length === 0) {
			console.log("No skills found");
			return;
		}
		for (const s of ctx.availableSkills) {
			const marker = s.name === ctx.activeSkill?.name ? " ●" : "";
			console.log(`  ${s.name}${marker} — ${s.description}`);
		}
		return;
	}
	const found = ctx.availableSkills.find((s) => s.name === name);
	if (!found) {
		console.log(`Skill "${name}" not found`);
		return;
	}
	ctx.activeSkill = found;
	console.log(`Activated: ${found.name}`);
};

const handleAgentCommand = (input: string, ctx: CliContext): void => {
	const name = input.replace("/agent", "").trim();
	if (!name) {
		if (ctx.availableAgents.length === 0) {
			console.log("No agents found");
			return;
		}
		for (const a of ctx.availableAgents) {
			const marker = a.name === ctx.activeAgent?.name ? " ●" : "";
			console.log(`  ${a.name}${marker}${a.description ? ` — ${a.description}` : ""}`);
		}
		return;
	}
	const found = ctx.availableAgents.find((a) => a.name === name);
	if (!found) {
		console.log(`Agent "${name}" not found`);
		return;
	}
	ctx.activeAgent = found;
	console.log(`Activated agent: ${found.name}`);
};

const handleHistoryCommand = async (
	rl: ReturnType<typeof createInterface>,
	engine: ReturnType<typeof createEngine>,
	currentId: string | undefined,
): Promise<string | undefined> => {
	const sessions = listSessions(HISTORY_DIR);
	if (sessions.length === 0) {
		console.log("No saved sessions.");
		return currentId;
	}
	console.log("\nSaved sessions:\n");
	const shown = sessions.slice(0, 10);
	for (let i = 0; i < shown.length; i++) {
		const s = shown[i];
		if (!s) continue;
		const date = new Date(s.updatedAt).toLocaleDateString();
		const time = new Date(s.updatedAt).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		const marker = s.id === currentId ? " ●" : "";
		const preview = sessionPreview(s.id);
		console.log(`  ${i + 1}. ${date} ${time}${marker}  \x1b[2m${preview}\x1b[0m`);
	}
	console.log();
	const answer = await rl.question("Load # (or Enter to cancel): ");
	const idx = Number.parseInt(answer.trim()) - 1;
	const selected = shown[idx];
	if (!selected) return currentId;
	const loaded = loadSession(HISTORY_DIR, selected.id);
	if (loaded.isErr()) {
		console.log(`Failed: ${loaded.error}`);
		return currentId;
	}
	engine.loadMessages(loaded.value.messages);
	console.log(`Loaded session ${selected.id} (${loaded.value.messages.length} messages)\n`);
	return selected.id;
};

const sessionPreview = (id: string): string => {
	const result = loadSession(HISTORY_DIR, id);
	if (result.isErr()) return "";
	const firstUser = result.value.messages.find((m) => m.role === "user");
	if (!firstUser) return "";
	const text = firstUser.content.replace(/\n/g, " ").slice(0, 50);
	return text.length < firstUser.content.length ? `${text}…` : text;
};

/** Returns true if input was a command (handled), false if it's a message to send. */
const showUsage = (): void => {
	const completion = sessionTokens.total - sessionTokens.prompt;
	console.log(
		`Session: ${sessionTokens.total} tokens (${sessionTokens.prompt} prompt, ${completion} completion)\n`,
	);
};

const showContext = (ctx: CliContext): void => {
	const lastPrompt = sessionTokens.prompt > 0 ? sessionTokens.prompt : 0;
	const pct = lastPrompt > 0 ? Math.round((lastPrompt / ctx.contextSize) * 100) : 0;
	console.log(`Context window: ${ctx.contextSize.toLocaleString()} tokens`);
	console.log(`Last prompt:    ${lastPrompt.toLocaleString()} tokens (${pct}% used)`);
	console.log(`Tools loaded:   ${ctx.toolCount} (~${ctx.toolTokens.toLocaleString()} tokens)\n`);
};

const handleCommand = async (
	trimmed: string,
	rl: ReturnType<typeof createInterface>,
	ctx: CliContext,
	setId: (id: string | undefined) => void,
): Promise<"handled" | "quit" | "message"> => {
	if (trimmed === "/quit" || trimmed === "/exit") return "quit";
	if (trimmed === "/usage") {
		showUsage();
		return "handled";
	}
	if (trimmed === "/context") {
		showContext(ctx);
		return "handled";
	}
	if (trimmed === "/new") {
		setId(undefined);
		sessionTokens = { prompt: 0, total: 0 };
		console.log("New session started.\n");
		return "handled";
	}
	if (trimmed.startsWith("/model")) {
		await handleModelCommand(trimmed, ctx);
		return "handled";
	}
	if (trimmed.startsWith("/skill")) {
		handleSkillCommand(trimmed, ctx);
		return "handled";
	}
	if (trimmed === "/history") {
		setId(await handleHistoryCommand(rl, ctx.engine, undefined));
		return "handled";
	}
	if (trimmed === "/transcript") {
		exportTranscript(ctx);
		return "handled";
	}
	if (trimmed.startsWith("/agent")) {
		handleAgentCommand(trimmed, ctx);
		return "handled";
	}
	if (trimmed.startsWith("/rewind")) {
		handleRewind(trimmed, ctx);
		return "handled";
	}
	// Skill as slash command: /code-review triggers skill "code-review"
	if (trimmed.startsWith("/")) {
		const found = ctx.availableSkills.find((s) => s.name === trimmed.slice(1));
		if (found) {
			ctx.activeSkill = found;
			console.log(`Activated: ${found.name}\n`);
			return "handled";
		}
	}
	return "message";
};

const exportTranscript = (ctx: CliContext): void => {
	const msgs = ctx.engine.messages();
	if (msgs.length === 0) {
		console.log("No messages to export.\n");
		return;
	}
	const dir = join(homedir(), ".anvil", "transcripts");
	mkdirSync(dir, { recursive: true });
	const md = msgs
		.map((m) => {
			const role =
				m.role === "user" ? "**You**" : m.role === "assistant" ? "**Assistant**" : `*${m.role}*`;
			return `${role}:\n${m.content ?? ""}\n`;
		})
		.join("\n---\n\n");
	const filename = `${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.md`;
	const path = join(dir, filename);
	writeFileSync(path, md);
	console.log(`Transcript saved: ${path}\n`);
};

const handleRewind = (input: string, ctx: CliContext): void => {
	const n = Number.parseInt(input.replace("/rewind", "").trim(), 10);
	const msgs = ctx.engine.messages();
	const userIndices: number[] = [];
	for (const [i, m] of msgs.entries()) {
		if (m.role === "user") userIndices.push(i);
	}
	if (Number.isNaN(n) || n < 1 || n > userIndices.length) {
		console.log(`Usage: /rewind N (1-${userIndices.length} user turns)\n`);
		return;
	}
	// Keep up to the end of the Nth user turn's response
	const lastUserIdx = userIndices[n - 1] ?? 0;
	// Find next user message after this one (that's where the turn ends)
	const nextUserIdx = userIndices[n] ?? msgs.length;
	const kept = msgs.slice(0, nextUserIdx);
	ctx.engine.loadMessages([...kept]);
	sessionTokens = { prompt: 0, total: 0 };
	const removed = msgs.length - kept.length;
	const preview = (msgs[lastUserIdx]?.content ?? "").slice(0, 60);
	console.log(`[rewound to turn ${n}: "${preview}…" — removed ${removed} messages]\n`);
};

const showPasteHint = (input: string): void => {
	const lineCount = input.split("\n").length;
	if (lineCount > 3) stdout.write(`\x1b[2m[${lineCount} lines]\x1b[0m\n`);
};

const MAX_FILE_CHARS = 8000;

/** Expand @path references to file contents inline. */
const expandFileRefs = (input: string, root: string): string =>
	input.replace(/(^|[\s])@([\w./-]+)/g, (match, prefix: string, p: string) => {
		const filePath = resolve(root, p);
		if (!existsSync(filePath)) return match;
		try {
			const content = readFileSync(filePath, "utf-8");
			const lines = content.split("\n").length;
			stdout.write(`\x1b[2m[attached: ${p} (${lines} lines)]\x1b[0m\n`);
			if (content.length > MAX_FILE_CHARS)
				return `${prefix}<file path="${p}">\n${content.slice(0, MAX_FILE_CHARS)}\n[truncated, use read_file for full content]\n</file>`;
			return `${prefix}<file path="${p}">\n${content}\n</file>`;
		} catch {
			return match;
		}
	});

const chatLoop = async (
	rl: ReturnType<typeof createInterface>,
	ctx: CliContext,
	sessionId: string | undefined,
): Promise<string | undefined> => {
	let id = sessionId;
	while (true) {
		let input: string;
		try {
			input = await rl.question("> ");
		} catch {
			break;
		}
		const trimmed = input.trim();
		if (!trimmed) continue;

		// Show summary for large pastes
		showPasteHint(trimmed);

		const result = await handleCommand(trimmed, rl, ctx, (newId) => {
			id = newId;
		});
		if (result === "quit") break;
		if (result === "handled") continue;

		try {
			stdout.write("\x1b[2m─\x1b[0m\n");
			const expanded = expandFileRefs(trimmed, projectRoot);
			await processAgentTurn(rl, ctx.agent, expanded, ctx);
		} catch (e) {
			stdout.write(`\n[error: ${e instanceof Error ? e.message : String(e)}]\n`);
		}
		stdout.write("\n");
		await ctx.fireStopHooks();

		id = saveSession(HISTORY_DIR, [...ctx.engine.messages()], id, {
			promptTokens: sessionTokens.prompt,
			totalTokens: sessionTokens.total,
		});
	}
	return id;
};

const processAgentTurn = async (
	rl: ReturnType<typeof createInterface>,
	agent: Agent,
	message: string,
	ctx: CliContext,
) => {
	let spinner = startSpinner();
	let active = true;
	const stop = () => {
		if (active) {
			spinner.stop();
			active = false;
		}
	};

	for await (const event of agent.send(message)) {
		if (event.kind !== "usage" && event.kind !== "state" && event.kind !== "round") stop();
		if (event.kind === "pending") {
			await handleApproval(rl, agent, event, ctx);
			return;
		}
		if (event.kind === "error") {
			stop();
			displayEvent(event);
			await offerRetry(rl, agent, message, ctx);
			return;
		}
		displayEvent(event);
		if (event.kind === "tool_result") {
			spinner = startSpinner();
			active = true;
		}
	}
	stop();
	flushUsage();
	renderStatusBar(ctx);
};

const offerRetry = async (
	rl: ReturnType<typeof createInterface>,
	agent: Agent,
	message: string,
	ctx: CliContext,
): Promise<void> => {
	const answer = await rl.question("\nRetry? (y/n): ");
	if (answer.trim().toLowerCase() === "y") {
		await processAgentTurn(rl, agent, message, ctx);
	}
};

const handleApproval = async (
	rl: ReturnType<typeof createInterface>,
	agent: Agent,
	event: AgentEvent & { kind: "pending" },
	ctx: CliContext,
) => {
	pendingUsageDisplay = "";
	const approved = await promptApproval(rl, event);
	let spinner = startSpinner();
	let active = true;
	const stop = () => {
		if (active) {
			spinner.stop();
			active = false;
		}
	};
	const gen = approved ? agent.approve() : agent.reject("User declined");
	for await (const e of gen) {
		if (e.kind !== "usage" && e.kind !== "state" && e.kind !== "round") stop();
		displayEvent(e);
		if (e.kind === "tool_result") {
			spinner = startSpinner();
			active = true;
		}
	}
	stop();
	flushUsage();
	renderStatusBar(ctx);
};

const flushUsage = (): void => {
	if (pendingUsageDisplay) {
		stdout.write(pendingUsageDisplay);
		pendingUsageDisplay = "";
	}
};

const renderStatusBar = (ctx: CliContext): void => {
	const model = ctx.engine.model();
	const ctxPct =
		sessionTokens.prompt > 0 ? Math.round((sessionTokens.prompt / ctx.contextSize) * 100) : 0;
	const ctxUsed =
		sessionTokens.prompt > 1000
			? `${(sessionTokens.prompt / 1000).toFixed(1)}k`
			: `${sessionTokens.prompt}`;
	const ctxMax =
		ctx.contextSize > 1000 ? `${(ctx.contextSize / 1000).toFixed(0)}k` : `${ctx.contextSize}`;
	const warn = ctxPct >= 80 ? " ⚠ /new" : "";
	const right = `${model} • ctx: ${ctxUsed}/${ctxMax} (${ctxPct}%)${warn} • ${sessionTokens.total} tok`;
	statusBar.render(projectRoot, right);
};

const promptApproval = async (
	rl: ReturnType<typeof createInterface>,
	event: AgentEvent & { kind: "pending" },
): Promise<boolean> => {
	console.log(formatPending(event));
	const answer = await rl.question("  approve? [y/n]: ");
	return answer.trim().toLowerCase().startsWith("y");
};

main().then(() => process.exit(0));
