import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { AgentEvent } from "./agent/loop.js";
import { listSessions, loadSession, saveSession } from "./session/index.js";
import {
	bootstrap,
	expandFileRefs,
	makeProvider,
	parseFlags,
	pingProvider,
	resolveProviderModel,
} from "./shared/bootstrap.js";
import { startSpinner } from "./spinner.js";
import { createStatusBar } from "./ui/statusbar.js";

// === Bootstrap ===

const flags = parseFlags(process.argv);
if (flags.path) process.chdir(flags.path);
const ctx = await bootstrap(flags);
const { config, projectRoot, engine, registry, agent, historyDir } = ctx;

// === State ===

let sessionTokens = { prompt: 0, total: 0 };
let pendingUsageDisplay = "";
const debugMode = flags.debug;
const showTokens = config.showTokens;
const statusBar = createStatusBar();

// === Display ===

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

const flushUsage = (): void => {
	if (pendingUsageDisplay) {
		stdout.write(pendingUsageDisplay);
		pendingUsageDisplay = "";
	}
};

const renderStatusBar = (): void => {
	const model = engine.model();
	const ctxPct =
		sessionTokens.prompt > 0 ? Math.round((sessionTokens.prompt / config.contextSize) * 100) : 0;
	const ctxUsed =
		sessionTokens.prompt > 1000
			? `${(sessionTokens.prompt / 1000).toFixed(1)}k`
			: `${sessionTokens.prompt}`;
	const ctxMax =
		config.contextSize > 1000
			? `${(config.contextSize / 1000).toFixed(0)}k`
			: `${config.contextSize}`;
	const warn = ctxPct >= 80 ? " ⚠ /new" : "";
	const right = `${model} • ctx: ${ctxUsed}/${ctxMax} (${ctxPct}%)${warn} • ${sessionTokens.total} tok`;
	statusBar.render(projectRoot, right);
};

// === Approval / pending ===

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
	const lines = [`\n  🔧 edit_file(${path})`];
	for (const l of oldText.split("\n")) lines.push(`\x1b[31m  - ${l}\x1b[0m`);
	for (const l of newText.split("\n")) lines.push(`\x1b[32m  + ${l}\x1b[0m`);
	return lines.join("\n");
};

const promptApproval = async (
	rl: ReturnType<typeof createInterface>,
	event: AgentEvent & { kind: "pending" },
): Promise<boolean> => {
	console.log(formatPending(event));
	const answer = await rl.question("  approve? [y/n]: ");
	return answer.trim().toLowerCase().startsWith("y");
};

// === Agent turn processing ===

const processAgentTurn = async (
	rl: ReturnType<typeof createInterface>,
	message: string,
): Promise<void> => {
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
			await handleApproval(rl, event);
			return;
		}
		if (event.kind === "error") {
			stop();
			displayEvent(event);
			const answer = await rl.question("\nRetry? (y/n): ");
			if (answer.trim().toLowerCase() === "y") await processAgentTurn(rl, message);
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
	renderStatusBar();
};

const handleApproval = async (
	rl: ReturnType<typeof createInterface>,
	event: AgentEvent & { kind: "pending" },
): Promise<void> => {
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
	renderStatusBar();
};

// === Commands ===

const showUsage = (): void => {
	const completion = sessionTokens.total - sessionTokens.prompt;
	console.log(
		`Session: ${sessionTokens.total} tokens (${sessionTokens.prompt} prompt, ${completion} completion)\n`,
	);
};

const showContext = (): void => {
	const pct =
		sessionTokens.prompt > 0 ? Math.round((sessionTokens.prompt / config.contextSize) * 100) : 0;
	const toolTokens = Math.round(JSON.stringify(registry.schemas()).length / 4);
	console.log(`Context window: ${config.contextSize.toLocaleString()} tokens`);
	console.log(`Last prompt:    ${sessionTokens.prompt.toLocaleString()} tokens (${pct}% used)`);
	console.log(
		`Tools loaded:   ${registry.all().length} (~${toolTokens.toLocaleString()} tokens)\n`,
	);
};

const printModelList = async (): Promise<void> => {
	const current = `${ctx.activeProviderName}/${engine.model()}`;
	console.log(`Active: ${current}\n`);
	for (const [name, health] of ctx.healthyProviders) {
		if (health.status !== "healthy") {
			console.log(`  ${name}: ${health.message}`);
			continue;
		}
		const entry = config.providers[name];
		if (!entry) continue;
		const result = await makeProvider(name, entry, {
			streamTimeout: config.streamTimeout,
			connectTimeout: config.connectTimeout,
		}).listModels();
		if (result.isErr()) {
			console.log(`  ${name}: failed to list models`);
			continue;
		}
		for (const m of result.value) {
			const fq = `${name}/${m}`;
			console.log(`  ${fq}${fq === current ? " ●" : ""}`);
		}
	}
};

const handleModelCommand = async (input: string): Promise<void> => {
	const arg = input.replace("/model", "").trim();
	if (!arg) return printModelList();

	if (arg.startsWith("set ")) {
		const model = arg.slice(4).trim();
		if (!model) return;
		const raw = readFileSync(join(homedir(), ".anvil", "config.yaml"), "utf-8");
		writeFileSync(
			join(homedir(), ".anvil", "config.yaml"),
			raw.replace(/^default_model:.*/m, `default_model: ${model}`),
		);
		engine.setModel(model);
		console.log(`Default model set to: ${model}`);
		return;
	}

	const { provider: provName, model: modelName } = resolveProviderModel(
		arg,
		config.providers,
		ctx.activeProviderName,
	);
	const entry = config.providers[provName];
	if (!entry) {
		console.log(`Provider "${provName}" not configured`);
		return;
	}
	const health = await pingProvider(entry, config.connectTimeout * 1000);
	if (health.status !== "healthy") {
		console.log(`Provider "${provName}": ${health.message}`);
		return;
	}

	if (provName !== ctx.activeProviderName) {
		const newProvider = makeProvider(provName, entry, {
			streamTimeout: config.streamTimeout,
			connectTimeout: config.connectTimeout,
		});
		engine.setProvider(newProvider);
	}
	engine.setModel(modelName);
	console.log(`Switched to: ${provName}/${modelName}`);
};

const handleSkillCommand = (input: string): void => {
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
	ctx.setActiveSkill(found);
	console.log(`Activated: ${found.name}`);
};

const handleAgentCommand = (input: string): void => {
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
	ctx.setActiveAgent(found);
	console.log(`Activated agent: ${found.name}`);
};

const handleHistoryCommand = async (
	rl: ReturnType<typeof createInterface>,
	currentId: string | undefined,
): Promise<string | undefined> => {
	const sessions = listSessions(historyDir);
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
		const result = loadSession(historyDir, s.id);
		const preview = result.isOk()
			? (result.value.messages.find((m) => m.role === "user")?.content ?? "")
					.replace(/\n/g, " ")
					.slice(0, 50)
			: "";
		console.log(`  ${i + 1}. ${date} ${time}${marker}  \x1b[2m${preview}\x1b[0m`);
	}
	console.log();
	const answer = await rl.question("Load # (or Enter to cancel): ");
	const idx = Number.parseInt(answer.trim(), 10) - 1;
	const selected = shown[idx];
	if (!selected) return currentId;
	const loaded = loadSession(historyDir, selected.id);
	if (loaded.isErr()) {
		console.log(`Failed: ${loaded.error}`);
		return currentId;
	}
	engine.loadMessages(loaded.value.messages);
	console.log(`Loaded session ${selected.id} (${loaded.value.messages.length} messages)\n`);
	return selected.id;
};

const handleRewind = (input: string): void => {
	const n = Number.parseInt(input.replace("/rewind", "").trim(), 10);
	const msgs = engine.messages();
	const userIndices: number[] = [];
	for (const [i, m] of msgs.entries()) {
		if (m.role === "user") userIndices.push(i);
	}
	if (Number.isNaN(n) || n < 1 || n > userIndices.length) {
		console.log(`Usage: /rewind N (1-${userIndices.length} user turns)\n`);
		return;
	}
	const nextUserIdx = userIndices[n] ?? msgs.length;
	const kept = msgs.slice(0, nextUserIdx);
	engine.loadMessages([...kept]);
	sessionTokens = { prompt: 0, total: 0 };
	const lastUserIdx = userIndices[n - 1] ?? 0;
	const preview = (msgs[lastUserIdx]?.content ?? "").slice(0, 60);
	console.log(
		`[rewound to turn ${n}: "${preview}…" — removed ${msgs.length - kept.length} messages]\n`,
	);
};

const exportTranscript = (): void => {
	const msgs = engine.messages();
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

// === Plan ===
const executeSteps = async (
	steps: string[],
	rl: ReturnType<typeof createInterface>,
): Promise<void> => {
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i] ?? "";
		const progress = `Step ${i + 1}/${steps.length}: ${step}`;
		stdout.write(`\n\x1b[36m${progress}\x1b[0m\n\x1b[2m─\x1b[0m\n`);
		const prev = i > 0 ? "\nPrevious steps completed successfully." : "";
		await processAgentTurn(rl, `${progress}${prev}\nDo this now.`);
		stdout.write("\n");
		if (i >= steps.length - 1) continue;
		const cont = await rl.question("\x1b[2m[continue? y/n/skip]: \x1b[0m");
		if (cont.trim().toLowerCase() === "n") break;
	}
};

const handlePlan = async (task: string, rl: ReturnType<typeof createInterface>): Promise<void> => {
	if (!task) {
		console.log("Usage: /plan <task description>\n");
		return;
	}
	stdout.write("\x1b[2m─\x1b[0m\n");
	let text = "";
	const spinner = startSpinner();
	for await (const event of agent.send(
		`Break this task into numbered steps (just the steps, no explanation):\n${task}`,
	)) {
		if (event.kind === "content") {
			spinner.stop();
			text += event.text;
			stdout.write(event.text);
		}
		if (event.kind === "usage") {
			sessionTokens.prompt += event.promptTokens;
			sessionTokens.total += event.totalTokens;
		}
	}
	stdout.write("\n\n");
	const steps = text
		.split("\n")
		.map((l) => l.replace(/^\d+[.)]\s*/, "").trim())
		.filter((l) => l.length > 0);
	if (steps.length === 0) {
		console.log("[no steps found]\n");
		return;
	}
	const answer = await rl.question(`\x1b[2m[${steps.length} steps — execute? y/n]: \x1b[0m`);
	if (!answer.trim().toLowerCase().startsWith("y")) return;
	await executeSteps(steps, rl);
	console.log("\x1b[2m[plan complete]\x1b[0m\n");
};

// === Command dispatch ===

const handleCommand = async (
	trimmed: string,
	rl: ReturnType<typeof createInterface>,
	setId: (id: string | undefined) => void,
): Promise<"handled" | "quit" | "message"> => {
	if (trimmed === "/quit" || trimmed === "/exit") return "quit";
	if (trimmed === "/usage") {
		showUsage();
		return "handled";
	}
	if (trimmed === "/context") {
		showContext();
		return "handled";
	}
	if (trimmed === "/new") {
		setId(undefined);
		sessionTokens = { prompt: 0, total: 0 };
		console.log("New session started.\n");
		return "handled";
	}
	if (trimmed.startsWith("/model")) {
		await handleModelCommand(trimmed);
		return "handled";
	}
	if (trimmed.startsWith("/skill")) {
		handleSkillCommand(trimmed);
		return "handled";
	}
	if (trimmed === "/history") {
		setId(await handleHistoryCommand(rl, undefined));
		return "handled";
	}
	if (trimmed === "/transcript") {
		exportTranscript();
		return "handled";
	}
	if (trimmed.startsWith("/agent")) {
		handleAgentCommand(trimmed);
		return "handled";
	}
	if (trimmed.startsWith("/rewind")) {
		handleRewind(trimmed);
		return "handled";
	}
	if (trimmed.startsWith("/plan")) {
		await handlePlan(trimmed.replace("/plan", "").trim(), rl);
		return "handled";
	}
	if (trimmed.startsWith("/")) {
		const found = ctx.availableSkills.find((s) => s.name === trimmed.slice(1));
		if (found) {
			ctx.setActiveSkill(found);
			console.log(`Activated: ${found.name}\n`);
			return "handled";
		}
	}
	return "message";
};

// === One-shot mode ===

const runOneShot = async (command: string): Promise<void> => {
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
				await processEvents(agent.approve());
				return;
			}
			displayEvent(event);
			if (event.kind === "tool_result") restart();
		}
	};

	await processEvents(agent.send(expandFileRefs(command, projectRoot)));
	flushUsage();
	stdout.write("\n");
};

// === Main chat loop ===

const processUserMessage = async (
	trimmed: string,
	rl: ReturnType<typeof createInterface>,
	id: string | undefined,
): Promise<string | undefined> => {
	try {
		stdout.write("\x1b[2m─\x1b[0m\n");
		await processAgentTurn(rl, expandFileRefs(trimmed, projectRoot));
	} catch (e) {
		stdout.write(`\n[error: ${e instanceof Error ? e.message : String(e)}]\n`);
	}
	stdout.write("\n");
	await ctx.fireStopHooks();
	return saveSession(historyDir, [...engine.messages()], id, {
		promptTokens: sessionTokens.prompt,
		totalTokens: sessionTokens.total,
	});
};

const chatLoop = async (rl: ReturnType<typeof createInterface>): Promise<void> => {
	let id = ctx.sessionId;
	while (true) {
		let input: string;
		try {
			input = await rl.question("> ");
		} catch {
			break;
		}
		const trimmed = input.trim();
		if (!trimmed) continue;

		const lineCount = trimmed.split("\n").length;
		if (lineCount > 3) stdout.write(`\x1b[2m[${lineCount} lines]\x1b[0m\n`);

		const result = await handleCommand(trimmed, rl, (newId) => {
			id = newId;
		});
		if (result === "quit") break;
		if (result === "handled") continue;

		id = (await processUserMessage(trimmed, rl, id)) ?? id;
	}

	if (sessionTokens.total > 0) {
		console.log(`\nSession: ${sessionTokens.total} tokens (${sessionTokens.prompt} prompt)`);
	}
};

// === Entry point ===

if (flags.command) {
	await runOneShot(flags.command);
} else {
	console.log(`anvil — ${ctx.activeProviderName}/${engine.model()} — ${projectRoot}`);
	if (ctx.activeAgent) console.log(`agent: ${ctx.activeAgent.name}`);
	if (ctx.activeSkill) console.log(`skill: ${ctx.activeSkill.name}`);
	console.log("Type /quit to exit, /skill to list, /model <name> to switch\n");

	const rl = createInterface({ input: stdin, output: stdout });
	try {
		await chatLoop(rl);
	} finally {
		rl.close();
	}
}

await ctx.shutdown();
