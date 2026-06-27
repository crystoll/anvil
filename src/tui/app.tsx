import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Box, render, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";
import { type AgentEvent, createAgentLoop } from "../agent/index.js";
import { type AgentDef, applyAgentToRegistry, discoverAgents, runHooks } from "../agents/index.js";
import { loadConfig } from "../config/config.js";
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
	loadLspConfig,
} from "../lsp/index.js";
import {
	type ConnectedServer,
	connectServer,
	loadMcpConfig,
	mcpToolsToAnvil,
} from "../mcp/index.js";
import { createProvider } from "../provider/index.js";
import { listSessions, loadSession, saveSession } from "../session/index.js";
import { discoverSkills, type Skill } from "../skills/index.js";
import { builtinTools, createRegistry } from "../tools/index.js";

// === Bootstrap ===
const args = process.argv.slice(2);
if (args.includes("--version")) {
	console.log(VERSION);
	process.exit(0);
}
const flagVal = (flag: string): string | undefined => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
};
const flagModel = flagVal("--model");
const flagSkill = flagVal("--skill");
const flagAgent = flagVal("--agent");
const flagResume = args.includes("--resume");

// Positional path arg
const flagIndices = new Set(
	["--model", "--skill", "--agent"]
		.map((f) => args.indexOf(f))
		.filter((i) => i >= 0)
		.flatMap((i) => [i, i + 1]),
);
const posIdx = args.findIndex((a, i) => !a.startsWith("-") && !flagIndices.has(i));
const projectRoot = posIdx >= 0 ? resolve(args[posIdx] ?? "") : process.cwd();
const home = homedir();
const HISTORY_DIR = join(home, ".anvil", "history");
const configPath = join(home, ".anvil", "config.yaml");

const configResult = loadConfig(configPath);
if (configResult.isErr()) {
	console.error("Config error:", configResult.error.message);
	process.exit(1);
}
const config = configResult.value;
const providerEntry = config.providers[config.defaultProvider];
if (!providerEntry) {
	console.error(`Provider not found: ${config.defaultProvider}`);
	process.exit(1);
}

const provider = createProvider(config.defaultProvider, {
	endpoint: providerEntry.endpoint,
	...(providerEntry.apiKey ? { apiKey: providerEntry.apiKey } : {}),
	streamTimeout: config.streamTimeout,
	connectTimeout: config.connectTimeout,
});
const ollamaBase = providerEntry.endpoint.replace(/\/v1\/?$/, "");
const engine = createEngine(provider, flagModel ?? config.defaultModel);
const registry = createRegistry();
for (const tool of builtinTools) registry.register(tool);

// Skills
const skillDirs = [
	join(projectRoot, ".anvil", "skills"),
	join(projectRoot, ".kiro", "skills"),
	join(projectRoot, ".claude", "skills"),
	join(home, ".anvil", "skills"),
	join(home, ".kiro", "skills"),
	join(home, ".claude", "skills"),
];
const availableSkills = discoverSkills(skillDirs);
let activeSkill: Skill | undefined = flagSkill
	? availableSkills.find((s) => s.name === flagSkill)
	: undefined;

// Agents
const agentDirs = [join(projectRoot, ".anvil", "agents"), join(home, ".anvil", "agents")];
const availableAgents = discoverAgents(agentDirs);
let activeAgentDef: AgentDef | undefined = flagAgent
	? availableAgents.find((a) => a.name === flagAgent)
	: availableAgents.find((a) => a.name === "default");
if (activeAgentDef) applyAgentToRegistry(registry, activeAgentDef);

// MCP
const mcpPaths = [
	join(projectRoot, ".anvil", "mcp.json"),
	join(projectRoot, ".mcp.json"),
	join(home, ".anvil", "mcp.json"),
];
const mcpResult = loadMcpConfig(mcpPaths);
const mcpServers: ConnectedServer[] = [];
const mcpInit = async () => {
	if (mcpResult.isErr()) return;
	for (const [name, cfg] of Object.entries(mcpResult.value)) {
		const result = await connectServer(name, cfg);
		if (typeof result === "string") continue;
		for (const tool of mcpToolsToAnvil(result)) registry.register(tool);
		mcpServers.push(result);
	}
};
const mcpReady = mcpInit();

const buildMcpHint = (): string => {
	if (mcpServers.length === 0) return "";
	const groups = mcpServers.map((s) => {
		const names = s.tools.map((t) => `${s.name}.${t.name}`).join(", ");
		return `- "${s.name}" tools (${names}): Use these together as a group.`;
	});
	return `\nYou have access to external tool servers:\n${groups.join("\n")}\nPrefer prefixed tools over general-purpose tools for that resource.`;
};

// LSP
const lspConfig = loadLspConfig(projectRoot);
let diagnosticInjector: ReturnType<typeof createDiagnosticInjector> | undefined;
if (lspConfig) {
	const manager = createLspManager(lspConfig, projectRoot);
	registry.register(createLspDiagnosticsTool(manager));
	registry.register(createLspDefinitionTool(manager));
	registry.register(createLspReferencesTool(manager));
	registry.register(createLspHoverTool(manager));
	registry.register(createLspSymbolsTool(manager));
	registry.register(createLspRenameTool(manager));
	diagnosticInjector = createDiagnosticInjector(manager, projectRoot);
}

// System prompt
const promptPath = join(projectRoot, ".anvil", "prompt.md");
const projectPrompt = existsSync(promptPath) ? readFileSync(promptPath, "utf-8").trim() : undefined;
const BASE_PROMPT = `You are Anvil, a local-first coding assistant running in a terminal.
You have tools for: shell commands, file operations, directory listing, web search, and reading web pages. Use them when you need real data. Call tools silently and base your answers on the results.
When a task requires multiple steps, execute all steps in sequence.
Keep responses concise. Use markdown formatting when it helps readability.
When you don't know something, say so.
Never output raw protocol tokens like <tool_response>, <tool_call>, or similar markup in your responses.`;

const buildPrompt = (): string =>
	[projectPrompt, activeSkill?.body, BASE_PROMPT].filter(Boolean).join("\n\n") + buildMcpHint();

const agentHooks = activeAgentDef?.hooks ?? {};
const hookCtx = { session_id: Date.now().toString(), cwd: projectRoot };

const agent = createAgentLoop(engine, registry, {
	maxRounds: config.maxRounds ?? 25,
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

// Fire sessionStart hooks
runHooks(agentHooks.sessionStart ?? [], { ...hookCtx, hook_event_name: "sessionStart" });

let sessionId: string | undefined;
if (flagResume) {
	const sessions = listSessions(HISTORY_DIR);
	if (sessions.length > 0) {
		const latest = sessions[0];
		if (latest) {
			const loaded = loadSession(HISTORY_DIR, latest.id);
			if (loaded.isOk()) {
				engine.loadMessages(loaded.value.messages);
				sessionId = latest.id;
			}
		}
	}
}

// === UI ===
type Msg = { id: number; text: string; dim?: boolean };

const truncate = (s: string, max = 80): string => {
	const one = s.replace(/\n/g, " ").trim();
	return one.length > max ? `${one.slice(0, max)}…` : one;
};

const expandFileRefs = (input: string): string =>
	input.replace(/(^|[\s])@([\w./-]+)/g, (match, prefix: string, p: string) => {
		const filePath = resolve(projectRoot, p);
		if (!existsSync(filePath)) return match;
		try {
			const content = readFileSync(filePath, "utf-8");
			return content.length > 8000
				? `${prefix}<file path="${p}">\n${content.slice(0, 8000)}\n[truncated]\n</file>`
				: `${prefix}<file path="${p}">\n${content}\n</file>`;
		} catch {
			return match;
		}
	});

function StatusBar({ model, tokens, busy }: { model: string; tokens: number; busy: boolean }) {
	return (
		<Box borderStyle="single" borderColor="gray" paddingX={1}>
			<Text color="cyan">{model}</Text>
			<Text> │ </Text>
			<Text dimColor>
				{busy ? "~" : ""}
				{tokens} tok
			</Text>
			{busy && <Text> │ </Text>}
			{busy && (
				<Text color="yellow">
					<Spinner type="dots" />
				</Text>
			)}
			{activeSkill && <Text> │ </Text>}
			{activeSkill && <Text color="magenta">{activeSkill.name}</Text>}
		</Box>
	);
}

function App() {
	const [messages, setMessages] = useState<Msg[]>([]);
	const [input, setInput] = useState("");
	const [tokens, setTokens] = useState(0);
	const [streaming, setStreaming] = useState("");
	const [busy, setBusy] = useState(false);
	const [pendingTool, setPendingTool] = useState<string | null>(null);
	const nextId = useRef(0);
	const history = useRef<string[]>([]);
	const histIdx = useRef(-1);
	const lastModels = useRef<string[]>([]);

	useInput((_input, key) => {
		if (key.ctrl && _input === "c") process.exit(0);
		if (key.upArrow && history.current.length > 0) {
			histIdx.current = Math.min(histIdx.current + 1, history.current.length - 1);
			setInput(history.current[histIdx.current] ?? "");
		}
		if (key.downArrow) {
			histIdx.current = Math.max(histIdx.current - 1, -1);
			setInput(histIdx.current < 0 ? "" : (history.current[histIdx.current] ?? ""));
		}
	});

	const addMsg = (text: string, dim = false) => {
		const id = nextId.current++;
		setMessages((prev) => [...prev, { id, text, dim }]);
	};

	const save = () => {
		sessionId = saveSession(HISTORY_DIR, [...engine.messages()], sessionId, {
			promptTokens: tokens,
			totalTokens: tokens,
		});
		runHooks(agentHooks.stop ?? [], { ...hookCtx, hook_event_name: "stop" });
	};

	const processEvents = async (events: AsyncGenerator<AgentEvent>): Promise<number> => {
		let response = "";
		for await (const event of events) {
			switch (event.kind) {
				case "content":
					response += event.text;
					setStreaming(`anvil: ${response}`);
					break;
				case "pending":
					setPendingTool(`${event.call.tool.name}(${JSON.stringify(event.call.args)})`);
					if (response) {
						addMsg(`anvil: ${response}`);
						setStreaming("");
						response = "";
					}
					return response.length;
				case "tool_result":
					addMsg(`  ↳ ${event.name}: ${truncate(event.result)}`, true);
					break;
				case "usage":
					setTokens((t) => t + event.totalTokens);
					break;
				default:
					break;
			}
		}
		if (response) addMsg(`anvil: ${response}`);
		setStreaming("");
		return response.length;
	};

	const simpleCommands: Record<string, () => void> = {
		"/quit": () => process.exit(0),
		"/exit": () => process.exit(0),
		"/new": () => {
			engine.reset();
			setMessages([]);
			setTokens(0);
			sessionId = undefined;
			addMsg("[new session]", true);
		},
		"/usage": () => addMsg(`[${tokens} tok | ${engine.messages().length} msgs]`, true),
		"/history": () => cmdHistory(),
		"/transcript": () => cmdTranscript(),
		"/context": () => cmdContext(),
	};

	const handleCommand = (cmd: string): boolean => {
		const simple = simpleCommands[cmd];
		if (simple) {
			simple();
			return true;
		}
		if (cmd.startsWith("/model")) return cmdModel(cmd.slice(6).trim());
		if (cmd.startsWith("/skill")) return cmdSkill(cmd.slice(6).trim());
		if (cmd.startsWith("/rewind")) {
			cmdRewind(cmd.slice(7).trim());
			return true;
		}
		if (cmd.startsWith("/agent")) {
			cmdAgent(cmd.slice(6).trim());
			return true;
		}
		// Skill as slash command: /code-review activates skill "code-review"
		const skillMatch = availableSkills.find((s) => s.name === cmd.slice(1));
		if (skillMatch) {
			activeSkill = skillMatch;
			addMsg(`[skill → ${skillMatch.name}]`, true);
			return true;
		}
		return false;
	};

	const cmdModel = (arg: string): true => {
		if (arg.startsWith("set ")) {
			const model = arg.slice(4).trim();
			engine.setModel(model);
			const cfgPath = join(home, ".anvil", "config.yaml");
			const raw = readFileSync(cfgPath, "utf-8");
			writeFileSync(cfgPath, raw.replace(/^default_model:.*/m, `default_model: ${model}`));
			addMsg(`[default model → ${model}]`, true);
		} else if (arg) {
			// Check if it's a number selecting from last listed models
			const n = Number.parseInt(arg, 10);
			const picked =
				n > 0 && lastModels.current.length >= n ? lastModels.current[n - 1] : undefined;
			const model = picked ?? arg;
			engine.setModel(model);
			addMsg(`[model → ${model}]`, true);
		} else {
			addMsg(`[model: ${engine.model()}]`, true);
			fetch(`${ollamaBase}/api/tags`)
				.then((r) => r.json())
				.then((data: { models?: { name: string }[] }) => {
					const models = data.models ?? [];
					if (models.length === 0) {
						addMsg("[no models found]", true);
						return;
					}
					lastModels.current = models.map((m) => m.name);
					for (const [i, m] of models.entries()) {
						const marker = m.name === engine.model() ? " ●" : "";
						addMsg(`  ${i + 1}. ${m.name}${marker}`, true);
					}
				})
				.catch(() => addMsg("[failed to list models]", true));
		}
		return true;
	};

	const cmdSkill = (arg: string): true => {
		if (!arg) {
			const list = availableSkills.map((s) => s.name).join(", ");
			addMsg(`[skills: ${list || "none"}]`, true);
			return true;
		}
		const found = availableSkills.find((s) => s.name === arg);
		if (found) {
			activeSkill = found;
			addMsg(`[skill → ${arg}]`, true);
		} else {
			addMsg(`[skill "${arg}" not found]`, true);
		}
		return true;
	};

	const cmdRewind = (arg: string) => {
		const n = Number.parseInt(arg, 10);
		if (Number.isNaN(n) || n < 0) {
			addMsg("[usage: /rewind N]", true);
			return;
		}
		const keep = engine.messages().slice(0, n * 2);
		engine.reset();
		engine.loadMessages([...keep]);
		addMsg(`[rewound to turn ${n}]`, true);
	};

	const cmdHistory = () => {
		const sessions = listSessions(HISTORY_DIR);
		if (sessions.length === 0) {
			addMsg("[no sessions]", true);
			return;
		}
		for (const s of sessions.slice(0, 10)) {
			const loaded = loadSession(HISTORY_DIR, s.id);
			const preview = loaded.isOk()
				? (loaded.value.messages.find((m) => m.role === "user")?.content ?? "")
						.replace(/\n/g, " ")
						.slice(0, 50)
				: "";
			addMsg(`  ${s.id.slice(0, 8)} ${preview}`, true);
		}
		addMsg("[use /history is browse-only for now]", true);
	};

	const cmdTranscript = () => {
		const msgs = engine.messages();
		if (msgs.length === 0) {
			addMsg("[no messages to export]", true);
			return;
		}
		const dir = join(home, ".anvil", "transcripts");
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
		addMsg(`[transcript → ${path}]`, true);
	};

	const cmdAgent = (arg: string) => {
		if (!arg) {
			const lines = availableAgents.map((a) => {
				const marker = a.name === activeAgentDef?.name ? " ●" : "";
				return `  ${a.name}${marker}${a.description ? ` — ${a.description}` : ""}`;
			});
			addMsg(lines.length > 0 ? lines.join("\n") : "[no agents]", true);
			return;
		}
		const found = availableAgents.find((a) => a.name === arg);
		if (!found) {
			addMsg(`[agent "${arg}" not found]`, true);
			return;
		}
		activeAgentDef = found;
		applyAgentToRegistry(registry, found);
		addMsg(`[agent → ${arg}]`, true);
	};

	const cmdContext = () => {
		const contextSize = config.contextSize ?? 128000;
		const pct = tokens > 0 ? Math.round((tokens / contextSize) * 100) : 0;
		const toolCount = registry.all().length;
		addMsg(
			`[context: ${contextSize.toLocaleString()} tok | used: ~${tokens} (${pct}%) | tools: ${toolCount}]`,
			true,
		);
	};

	const handleApproval = async (value: string) => {
		const approved = value.trim().toLowerCase().startsWith("y");
		setPendingTool(null);
		setInput("");
		await processEvents(approved ? agent.approve() : agent.reject(value));
		if (!pendingTool) {
			setBusy(false);
			save();
		}
	};

	const sendMessage = async (value: string) => {
		addMsg(`you: ${value}`);
		// @path hint display
		const refs = value.match(/(^|[\s])@([\w./-]+)/g);
		if (refs) {
			const paths = refs.map((r) => r.trim().slice(1));
			addMsg(`  [attached: ${paths.join(", ")}]`, true);
		}
		setBusy(true);
		let len = await processEvents(agent.send(expandFileRefs(value)));
		if (len === 0 && !pendingTool) {
			addMsg("  [empty response, retrying…]", true);
			len = await processEvents(agent.send("Please try again."));
		}
		if (!pendingTool) {
			setBusy(false);
			save();
		}
	};

	const handleSubmit = async (value: string) => {
		if (!value.trim()) return;
		if (pendingTool) {
			await handleApproval(value);
			return;
		}
		if (busy) return;
		setInput("");
		history.current = [value, ...history.current.slice(0, 99)];
		histIdx.current = -1;
		const cmd = value.trim();
		if (cmd.startsWith("/plan")) {
			await handlePlan(cmd.slice(5).trim());
			return;
		}
		if (cmd.startsWith("/") && handleCommand(cmd)) return;
		await sendMessage(value);
	};

	const handlePlan = async (task: string) => {
		if (!task) {
			addMsg("[usage: /plan <task>]", true);
			return;
		}
		addMsg(`[plan: ${task}]`, true);
		setBusy(true);
		await processEvents(
			agent.send(`Break this task into numbered steps (just the steps, no explanation):\n${task}`),
		);
		if (!pendingTool) {
			setBusy(false);
			save();
		}
	};

	return (
		<Box flexDirection="column" height="100%">
			<Box flexDirection="column" flexGrow={1} paddingX={1}>
				{messages.map((m) => (
					<Text key={m.id} dimColor={m.dim ?? false}>
						{m.text}
					</Text>
				))}
				{streaming && <Text color="gray">{streaming}</Text>}
			</Box>
			<StatusBar model={engine.model()} tokens={tokens} busy={busy} />
			<Box paddingX={1}>
				{pendingTool ? (
					<>
						<Text color="yellow">
							{"⚡ "}
							{pendingTool}
						</Text>
						<Text> [y/n]: </Text>
						<TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
					</>
				) : (
					<>
						<Text color="green">{"❯ "}</Text>
						<TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
					</>
				)}
			</Box>
		</Box>
	);
}

function Loading() {
	return (
		<Box paddingX={1}>
			<Text color="yellow">
				<Spinner type="dots" />
			</Text>
			<Text> connecting…</Text>
		</Box>
	);
}

function Root() {
	const [ready, setReady] = useState(false);
	if (!ready) {
		mcpReady.then(() => setReady(true));
		return <Loading />;
	}
	return <App />;
}

render(<Root />);
