import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Box, render, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";
import type { AgentEvent } from "../agent/loop.js";
import { listSessions, loadSession, saveSession } from "../session/index.js";
import {
	bootstrap,
	expandFileRefs,
	makeProvider,
	parseFlags,
	pingProvider,
} from "../shared/bootstrap.js";

const flags = parseFlags(process.argv);
const ctx = await bootstrap(flags);
if (flags.path) process.chdir(ctx.projectRoot);

const {
	config,
	projectRoot,
	engine,
	registry,
	agent,
	availableSkills,
	availableAgents,
	historyDir,
} = ctx;
let { activeProviderName, sessionId } = ctx;
let activeSkill = ctx.activeSkill;
let activeAgentDef = ctx.activeAgent;

// Provider health — derived from bootstrap validation
const defaultHealth = ctx.healthyProviders.get(activeProviderName);
const providerWarning =
	defaultHealth && defaultHealth.status !== "healthy"
		? `${activeProviderName}: ${defaultHealth.message}`
		: undefined;

// === UI ===
type Msg = { id: number; text: string; dim?: boolean };

const truncate = (s: string, max = 80): string => {
	const one = s.replace(/\n/g, " ").trim();
	return one.length > max ? `${one.slice(0, max)}…` : one;
};

function StatusBar({
	provider,
	model,
	tokens,
	busy,
}: {
	provider: string;
	model: string;
	tokens: number;
	busy: boolean;
}) {
	const label = `${provider}/${model}`;
	return (
		<Box borderStyle="single" borderColor="gray" paddingX={1}>
			<Text color="cyan">{label}</Text>
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

function App({ providerWarning }: { providerWarning: string | undefined }) {
	const initMsgs: Msg[] = providerWarning
		? [{ id: 0, text: `⚠ ${providerWarning} — use /model to switch`, dim: true }]
		: [];
	const [messages, setMessages] = useState<Msg[]>(initMsgs);
	const [input, setInput] = useState("");
	const [tokens, setTokens] = useState(0);
	const [streaming, setStreaming] = useState("");
	const [busy, setBusyState] = useState(false);
	const busyRef = useRef(false);
	const setBusy = (v: boolean) => {
		busyRef.current = v;
		setBusyState(v);
	};
	const [pendingTool, setPendingTool] = useState<string | null>(null);
	const [picker, setPicker] = useState<string[] | null>(null);
	const [pickerIdx, setPickerIdx] = useState(0);
	const nextId = useRef(providerWarning ? 1 : 0);
	const history = useRef<string[]>([]);
	const histIdx = useRef(-1);

	const addMsg = (text: string, dim = false) => {
		const id = nextId.current++;
		setMessages((prev) => [...prev, { id, text, dim }]);
	};

	const handlePickerKey = (key: {
		upArrow: boolean;
		downArrow: boolean;
		escape: boolean;
		return: boolean;
	}) => {
		if (key.upArrow) setPickerIdx((i) => Math.max(0, i - 1));
		if (key.downArrow) setPickerIdx((i) => Math.min((picker?.length ?? 1) - 1, i + 1));
		if (key.escape) setPicker(null);
		if (key.return && picker) {
			const picked = picker[pickerIdx];
			setPicker(null);
			if (!picked) return;
			const slashIdx = picked.indexOf("/");
			switchProvider(picked.slice(0, slashIdx), picked.slice(slashIdx + 1));
		}
	};

	const lastCtrlC = useRef(0);

	const handleCtrlC = () => {
		if (picker) {
			setPicker(null);
			return;
		}
		if (busyRef.current) {
			agent.cancel();
			setBusy(false);
			setStreaming("");
			addMsg("  [cancelled]", true);
			return;
		}
		const now = Date.now();
		if (now - lastCtrlC.current < 1500) {
			process.exit(0);
		}
		lastCtrlC.current = now;
		addMsg("  [press Ctrl+C again to exit]", true);
	};

	useInput((_input, key) => {
		if (key.ctrl && _input === "c") {
			handleCtrlC();
			return;
		}
		if (picker) {
			handlePickerKey(key);
			return;
		}
		if (key.upArrow && history.current.length > 0) {
			histIdx.current = Math.min(histIdx.current + 1, history.current.length - 1);
			setInput(history.current[histIdx.current] ?? "");
		}
		if (key.downArrow) {
			histIdx.current = Math.max(histIdx.current - 1, -1);
			setInput(histIdx.current < 0 ? "" : (history.current[histIdx.current] ?? ""));
		}
	});

	const save = () => {
		sessionId = saveSession(historyDir, [...engine.messages()], sessionId, {
			promptTokens: tokens,
			totalTokens: tokens,
		});
		ctx.fireStopHooks();
	};

	const processEvents = async (events: AsyncGenerator<AgentEvent>): Promise<number> => {
		let response = "";
		for await (const event of events) {
			switch (event.kind) {
				case "content":
					response += event.text;
					setStreaming(`anvil: ${response}`);
					break;
				case "reasoning":
					setStreaming("anvil: [thinking…]");
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
				case "error":
					addMsg(`  ⚠ ${event.message}`, true);
					return -1;
				default:
					break;
			}
		}
		if (response) addMsg(`anvil: ${response}`);
		setStreaming("");
		return response.length;
	};

	// === Commands ===

	const switchProvider = (name: string, model: string) => {
		const entry = config.providers[name];
		if (!entry) {
			addMsg(`[unknown provider: ${name}]`, true);
			return;
		}
		pingProvider(entry, config.connectTimeout * 1000).then((health) => {
			if (health.status !== "healthy") {
				addMsg(`[${name}: ${health.message}]`, true);
				return;
			}
			const p = makeProvider(name, entry, {
				streamTimeout: config.streamTimeout,
				connectTimeout: config.connectTimeout,
			});
			engine.setProvider(p);
			engine.setModel(model);
			activeProviderName = name;
			addMsg(`[model → ${name}/${model}]`, true);
		});
	};

	const listModels = (providerName: string) => {
		const health = ctx.healthyProviders.get(providerName);
		if (!health) {
			addMsg(`[unknown provider: ${providerName}]`, true);
			return;
		}
		if (health.status !== "healthy") {
			addMsg(`[${providerName}: ${health.message}]`, true);
			return;
		}
		const entry = config.providers[providerName];
		if (!entry) return;
		const current = `${activeProviderName}/${engine.model()}`;
		addMsg(`[provider: ${providerName} | active: ${current}]`, true);
		fetch(`${entry.endpoint}/models`, {
			headers: entry.apiKey ? { Authorization: `Bearer ${entry.apiKey}` } : {},
		})
			.then((r) => r.json())
			.then((data: { data?: { id: string }[] }) => {
				const models = (data.data ?? []).map((m) => m.id);
				if (models.length === 0) {
					addMsg("[no models found]", true);
					return;
				}
				for (const name of models) {
					const fq = `${providerName}/${name}`;
					const marker = fq === current ? " ●" : "";
					addMsg(`  ${fq}${marker}`, true);
				}
			})
			.catch(() => addMsg(`[${providerName}: failed to list models]`, true));
	};

	const listAllModels = () => {
		const healthy = [...ctx.healthyProviders.entries()].filter(([, h]) => h.status === "healthy");
		if (healthy.length === 0) {
			addMsg("[no healthy providers]", true);
			return;
		}
		const promises = healthy.map(async ([name]) => {
			const entry = config.providers[name];
			if (!entry) return [];
			const res = await fetch(`${entry.endpoint}/models`, {
				headers: entry.apiKey ? { Authorization: `Bearer ${entry.apiKey}` } : {},
			}).then((r) => r.json() as Promise<{ data?: { id: string }[] }>);
			return (res.data ?? []).map((m) => `${name}/${m.id}`);
		});
		Promise.all(promises).then((results) => {
			const models = results.flat();
			if (models.length === 0) {
				addMsg("[no models available]", true);
				return;
			}
			setPickerIdx(0);
			setPicker(models);
		});
	};

	const cmdModel = (arg: string): true => {
		if (arg.startsWith("set ")) {
			const fq = arg.slice(4).trim();
			const slashIdx = fq.indexOf("/");
			if (slashIdx > 0) {
				switchProvider(fq.slice(0, slashIdx), fq.slice(slashIdx + 1));
			} else {
				engine.setModel(fq);
			}
			const cfgPath = join(homedir(), ".anvil", "config.yaml");
			const raw = readFileSync(cfgPath, "utf-8");
			writeFileSync(cfgPath, raw.replace(/^default_model:.*/m, `default_model: ${fq}`));
			addMsg(`[default → ${fq}]`, true);
		} else if (arg.startsWith("@")) {
			listModels(arg.slice(1));
		} else if (arg.includes("/")) {
			const slashIdx = arg.indexOf("/");
			switchProvider(arg.slice(0, slashIdx), arg.slice(slashIdx + 1));
		} else if (arg) {
			engine.setModel(arg);
			addMsg(`[model → ${activeProviderName}/${arg}]`, true);
		} else {
			listAllModels();
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
			ctx.setActiveSkill(found);
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
		const sessions = listSessions(historyDir);
		if (sessions.length === 0) {
			addMsg("[no sessions]", true);
			return;
		}
		for (const s of sessions.slice(0, 10)) {
			const loaded = loadSession(historyDir, s.id);
			const preview = loaded.isOk()
				? (loaded.value.messages.find((m) => m.role === "user")?.content ?? "")
						.replace(/\n/g, " ")
						.slice(0, 50)
				: "";
			addMsg(`  ${s.id.slice(0, 8)} ${preview}`, true);
		}
	};

	const cmdTranscript = () => {
		const msgs = engine.messages();
		if (msgs.length === 0) {
			addMsg("[no messages to export]", true);
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
		ctx.setActiveAgent(found);
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
		const skillMatch = availableSkills.find((s) => s.name === cmd.slice(1));
		if (skillMatch) {
			activeSkill = skillMatch;
			ctx.setActiveSkill(skillMatch);
			addMsg(`[skill → ${skillMatch.name}]`, true);
			return true;
		}
		return false;
	};

	// === Message handling ===

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
		const refs = value.match(/(^|[\s])@([\w./-]+)/g);
		if (refs) {
			const paths = refs.map((r) => r.trim().slice(1));
			addMsg(`  [attached: ${paths.join(", ")}]`, true);
		}
		setBusy(true);
		let len = await processEvents(agent.send(expandFileRefs(value, projectRoot)));
		if (len === 0 && !pendingTool) {
			addMsg("  [empty response, retrying…]", true);
			len = await processEvents(agent.send("Please try again."));
		}
		if (!pendingTool) {
			setBusy(false);
			save();
		}
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
			<StatusBar provider={activeProviderName} model={engine.model()} tokens={tokens} busy={busy} />
			<Box paddingX={1}>
				{picker ? (
					<Box flexDirection="column">
						<Text dimColor>↑↓ select, Enter confirm, Esc cancel</Text>
						{picker.map((m, i) => (
							<Text key={m} {...(i === pickerIdx ? { color: "cyan" } : {})}>
								{i === pickerIdx ? "❯ " : "  "}
								{m}
								{m === `${activeProviderName}/${engine.model()}` ? " ●" : ""}
							</Text>
						))}
					</Box>
				) : pendingTool ? (
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

function Root() {
	return <App providerWarning={providerWarning} />;
}

render(<Root />, { exitOnCtrlC: false });
