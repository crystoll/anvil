import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { ok } from "neverthrow";
import type { AgentEvent, PendingCall } from "../agent/loop.js";
import { createAppCommandRegistry } from "../controller/app-commands.js";
import { type ControllerState, createSessionController } from "../controller/controller.js";
import { bootstrap, expandFileRefs, parseFlags } from "../shared/bootstrap.js";
import { guardProcess } from "../shared/crash-guard.js";
import { createGracefulExit } from "../shared/graceful-exit.js";
import { type Spinner, startSpinner } from "../spinner.js";
import { createStatusBar } from "../ui/statusbar.js";
import { createReadlineInput } from "./readline-input.js";

const flags = parseFlags(process.argv);
if (flags.path) process.chdir(flags.path);
const ctx = await bootstrap(flags);
const { config, projectRoot, engine, registry, session } = ctx;
for (const warning of ctx.mcpWarnings) console.error(`⚠ ${warning}`);

const controllerSession = flags.command ? { ...session, save: () => ok(undefined) } : session;
const commands = createAppCommandRegistry(ctx);
const controller = createSessionController({
	agent: ctx.agent,
	engine,
	session: controllerSession,
	shutdown: ctx.shutdown,
	commands,
	expandInput: (input) => expandFileRefs(input, projectRoot),
});

commands.register({
	name: "usage",
	description: "Show session token usage",
	execute: () => {
		const tokens = controller.getState().tokens;
		const completion = tokens.totalTokens - tokens.promptTokens;
		return {
			kind: "handled",
			message: `Session: ${tokens.totalTokens} tokens (${tokens.promptTokens} prompt, ${completion} completion)`,
		};
	},
});
commands.register({
	name: "context",
	description: "Show context window usage",
	execute: () => ({
		kind: "handled",
		message: formatContext(
			lastPromptTokens,
			config.contextSize,
			registry.all().length,
			JSON.stringify(registry.schemas()).length,
		),
	}),
});
commands.register({
	name: "transcript",
	description: "Export the conversation to Markdown",
	execute: () => ({ kind: "handled", message: exportTranscript() }),
});

let lastPromptTokens = 0;
let pendingUsageDisplay = "";
let busy = false;
let exitRequested = false;
let exitCode = 0;
let lastCtrlC = 0;
let approvalAbort: AbortController | undefined;
let cancellation: Promise<void> | undefined;
let spinner: Spinner | undefined;
const showTokens = config.showTokens;
const debugMode = flags.debug;
const statusBar = createStatusBar();

const stopSpinner = (): void => {
	spinner?.stop();
	spinner = undefined;
};

const cancelController = (): Promise<void> => {
	cancellation ??= controller.cancel().finally(() => {
		cancellation = undefined;
	});
	return cancellation;
};

const startTurnSpinner = (): void => {
	if (stdout.isTTY && !spinner) spinner = startSpinner();
};

const flushUsage = (): void => {
	if (!pendingUsageDisplay) return;
	stdout.write(pendingUsageDisplay);
	pendingUsageDisplay = "";
};

const renderStatusBar = (state: ControllerState): void => {
	const ctxPct =
		lastPromptTokens > 0 ? Math.round((lastPromptTokens / config.contextSize) * 100) : 0;
	const ctxUsed =
		lastPromptTokens > 1000 ? `${(lastPromptTokens / 1000).toFixed(1)}k` : `${lastPromptTokens}`;
	const ctxMax =
		config.contextSize > 1000
			? `${(config.contextSize / 1000).toFixed(0)}k`
			: `${config.contextSize}`;
	const indicator = ctxPct >= 90 ? "⚡" : ctxPct >= 80 ? "⚠" : "";
	const right = `${state.model} • ctx: ${ctxUsed}/${ctxMax} (${ctxPct}%${indicator}) • ${state.tokens.totalTokens} tok`;
	statusBar.render(projectRoot, right);
};

const formatUsage = (event: AgentEvent & { kind: "usage" }): string => {
	const completion = event.totalTokens - event.promptTokens;
	const reason = debugMode && event.finishReason ? ` ${event.finishReason}` : "";
	return showTokens ? `\n\x1b[2m[${event.promptTokens}→${completion} tok${reason}]\x1b[0m` : "";
};

const displayToolResult = (event: AgentEvent & { kind: "tool_result" }): void => {
	const preview =
		event.result.length > 500
			? `\x1b[2m${event.result.slice(0, 500)}… (${event.result.length} chars)\x1b[0m\n`
			: "";
	stdout.write(`\n  \x1b[2m↳ \x1b[36m${event.name}\x1b[2m done\x1b[0m\n${preview}`);
	flushUsage();
};

const displayAgentEvent = (event: AgentEvent): void => {
	switch (event.kind) {
		case "reasoning":
			stopSpinner();
			stdout.write(`\x1b[2m${event.text}\x1b[0m`);
			break;
		case "content":
			stopSpinner();
			stdout.write(event.text);
			break;
		case "tool_result":
			stopSpinner();
			displayToolResult(event);
			startTurnSpinner();
			break;
		case "usage":
			lastPromptTokens = event.promptTokens;
			pendingUsageDisplay = formatUsage(event);
			break;
		case "done":
			stopSpinner();
			stdout.write(`\n✓ ${event.message}`);
			break;
		case "stuck":
			stopSpinner();
			stdout.write(`\n✗ ${event.message}`);
			break;
		case "error":
			stopSpinner();
			stdout.write(`\n[error: ${event.message}]`);
			if (event.status) {
				const label =
					event.status === "interrupted"
						? "[response interrupted]"
						: "[response ended with an error]";
				stdout.write(`\n\x1b[2m${label}\x1b[0m`);
			}
			break;
		case "warning":
			stdout.write(`\n\x1b[33m⚠ ${event.message}\x1b[0m\n`);
			break;
		case "trimmed":
			stdout.write(`\x1b[2m[trimmed ${event.count} old messages]\x1b[0m\n`);
			break;
		case "overflow":
			stdout.write("\x1b[31m⚠ context overflow detected\x1b[0m\n");
			break;
		case "compacting":
			stdout.write("\x1b[2m[compacting context...]\x1b[0m\n");
			break;
		case "compacted":
			stdout.write(
				`\x1b[32m⚡ compacted: ~${event.before.toLocaleString()} → ~${event.after.toLocaleString()} tokens\x1b[0m\n`,
			);
			break;
	}
};

controller.subscribe((event) => {
	if (event.type === "agent") {
		if (
			event.event.kind !== "usage" &&
			event.event.kind !== "state" &&
			event.event.kind !== "round"
		)
			stopSpinner();
		displayAgentEvent(event.event);
		return;
	}
	if (event.type === "notice") stdout.write(`\n${event.message}\n`);
	if (event.type === "quit") exitRequested = true;
	if (event.type === "state") {
		if (event.state.phase === "streaming" || event.state.phase === "executing") startTurnSpinner();
		if (
			event.state.phase === "idle" ||
			event.state.phase === "awaiting_approval" ||
			event.state.phase === "cancelling"
		) {
			stopSpinner();
			flushUsage();
			renderStatusBar(event.state);
		}
	}
});

const formatContext = (
	used: number,
	limit: number,
	toolCount: number,
	schemaLength: number,
): string => {
	const pct = used > 0 ? Math.round((used / limit) * 100) : 0;
	const trimAt = Math.round(limit * 0.8);
	const barWidth = 20;
	const filled = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
	const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
	const color =
		pct >= 90 ? "\x1b[31m" : pct >= 80 ? "\x1b[38;5;208m" : pct >= 60 ? "\x1b[33m" : "\x1b[2m";
	const reset = "\x1b[0m";
	return [
		"[context]",
		`  limit:     ${limit.toLocaleString()} tokens`,
		`  used:      ~${used.toLocaleString()} (${color}${pct}%${reset})  ${color}${bar}${reset}`,
		`  tools:     ${toolCount} (~${Math.round(schemaLength / 4).toLocaleString()} tokens)`,
		`  trim at:   80% (~${trimAt.toLocaleString()} tokens)`,
		"  compact:   on overflow (auto)",
		pct >= 60 ? "\n  hint: /compact to manually free context" : "",
	].join("\n");
};

const exportTranscript = (): string => {
	const messages = engine.messages();
	if (messages.length === 0) return "No messages to export.";
	const directory = join(homedir(), ".anvil", "transcripts");
	mkdirSync(directory, { recursive: true });
	const markdown = messages
		.map((message) => {
			const role =
				message.role === "user"
					? "**You**"
					: message.role === "assistant"
						? "**Assistant**"
						: `*${message.role}*`;
			return `${role}:\n${message.content ?? ""}\n`;
		})
		.join("\n---\n\n");
	const filename = `${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.md`;
	const path = join(directory, filename);
	writeFileSync(path, markdown);
	return `Transcript saved: ${path}`;
};

const formatPending = (call: PendingCall, index: number, total: number): string => {
	const { tool, args } = call;
	const position = `\x1b[2m[${index}/${total}]\x1b[0m `;
	if (tool.name === "edit_file" && args.search && args.replace)
		return formatEditDiff(
			String(args.path ?? ""),
			String(args.search),
			String(args.replace),
			position,
		);
	if (tool.name === "write_file" && typeof args.content === "string") {
		const preview = args.content.length > 300 ? `${args.content.slice(0, 300)}…` : args.content;
		return `\n  🔧 ${position}\x1b[36m${tool.name}\x1b[0m\x1b[2m(${args.path})\x1b[0m\n\x1b[32m${preview}\x1b[0m`;
	}
	const argsString = Object.entries(args)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join(", ");
	return `\n  🔧 ${position}\x1b[36m${tool.name}\x1b[0m\x1b[2m(${argsString})\x1b[0m`;
};

const formatEditDiff = (
	path: string,
	search: string,
	replace: string,
	position: string,
): string => {
	const lines = [`\n  🔧 ${position}edit_file(${path})`];
	for (const line of search.split("\n")) lines.push(`\x1b[31m  - ${line}\x1b[0m`);
	for (const line of replace.split("\n")) lines.push(`\x1b[32m  + ${line}\x1b[0m`);
	return lines.join("\n");
};

type ApprovalDecision = "once" | "always" | "reject" | "cancel";

const parseApprovalDecision = (answer: string): ApprovalDecision | undefined => {
	if (answer === "c" || answer === "cancel") return "cancel";
	if (answer === "a" || answer === "always") return "always";
	if (answer === "y" || answer === "yes") return "once";
	if (answer === "n" || answer === "no") return "reject";
	return undefined;
};

const promptForApproval = async (
	lines: ReturnType<typeof createReadlineInput>,
): Promise<ApprovalDecision> => {
	while (!exitRequested) {
		const answer = (
			(await lines.prompt("  approve? [y/a/n/cancel]: ", {
				onlyNew: true,
				...(approvalAbort ? { signal: approvalAbort.signal } : {}),
			})) ?? ""
		)
			.trim()
			.toLowerCase();
		const decision = parseApprovalDecision(answer);
		if (decision) return decision;
		if (answer) stdout.write("  Enter y, a, n, or cancel.\n");
		else return "cancel";
	}
	return "cancel";
};

const resolveApprovals = async (
	lines: ReturnType<typeof createReadlineInput>,
	autoApprove: boolean,
): Promise<void> => {
	while (controller.getState().phase === "awaiting_approval" && !exitRequested) {
		const pending = controller.getState().pending;
		if (!pending) return;
		if (autoApprove) {
			await controller.approve("always");
			continue;
		}
		stdout.write(formatPending(pending.call, pending.index, pending.total));
		approvalAbort = new AbortController();
		const decision = await promptForApproval(lines);
		approvalAbort = undefined;
		if (decision === "once") await controller.approve("once");
		else if (decision === "always") await controller.approve("always");
		else if (decision === "reject") await controller.reject("User declined");
		else {
			await cancelController();
			return;
		}
	}
};

const runSubmission = async (
	input: string,
	lines: ReturnType<typeof createReadlineInput>,
	options: { autoApprove?: boolean } = {},
): Promise<void> => {
	await controller.submit(input);
	await resolveApprovals(lines, options.autoApprove ?? false);
	flushUsage();
};

const parsePlanSteps = (text: string): string[] =>
	text
		.split("\n")
		.map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/, "").trim())
		.filter(Boolean);

const executePlan = async (
	steps: string[],
	lines: ReturnType<typeof createReadlineInput>,
): Promise<void> => {
	const answer = await lines.prompt(`\x1b[2m[${steps.length} steps — execute? y/n]: \x1b[0m`, {
		onlyNew: true,
	});
	if (!answer?.trim().toLowerCase().startsWith("y")) return;
	for (const [index, step] of steps.entries()) {
		const progress = `Step ${index + 1}/${steps.length}: ${step}`;
		stdout.write(`\n\x1b[36m${progress}\x1b[0m\n\x1b[2m─\x1b[0m\n`);
		const previous = index > 0 ? "\nPrevious steps completed successfully." : "";
		await runSubmission(`${progress}${previous}\nDo this now.`, lines);
		stdout.write("\n");
		if (index >= steps.length - 1 || exitRequested) continue;
		const next = await lines.prompt("\x1b[2m[continue? y/n/skip]: \x1b[0m", { onlyNew: true });
		if (next === undefined || next.trim().toLowerCase() === "n") break;
	}
	stdout.write("\x1b[2m[plan complete]\x1b[0m\n");
};

const runInteractiveTurn = async (
	input: string,
	lines: ReturnType<typeof createReadlineInput>,
): Promise<void> => {
	const plan = /^\/plan\s+(.+)/s.exec(input);
	const shorthandSkill =
		input.startsWith("/") &&
		ctx.availableSkills.some((skill) => skill.name === input.slice(1).trim());
	const submitted = shorthandSkill ? `/skill ${input.slice(1).trim()}` : input;
	try {
		stdout.write("\x1b[2m─\x1b[0m\n");
		await runSubmission(submitted, lines);
		if (plan && !exitRequested) {
			const steps = parsePlanSteps(controller.getState().streamingText);
			if (steps.length === 0) stdout.write("[no steps found]\n");
			else await executePlan(steps, lines);
		}
	} catch (error) {
		stdout.write(`\n[error: ${error instanceof Error ? error.message : String(error)}]\n`);
	} finally {
		flushUsage();
		stopSpinner();
		busy = false;
		await ctx.fireStopHooks();
	}
	stdout.write("\n");
};

const runOneShot = async (command: string, lines: ReturnType<typeof createReadlineInput>) => {
	startTurnSpinner();
	try {
		await runSubmission(command, lines, { autoApprove: true });
	} finally {
		stopSpinner();
		flushUsage();
		stdout.write("\n");
	}
};

guardProcess({ flush: flags.command ? () => ok(undefined) : session.save });
const lines = createReadlineInput(stdin, stdout);
const gracefulExit = createGracefulExit({
	cancel: cancelController,
	closeUi: () => lines.close(),
	flush: flags.command ? () => ok(undefined) : session.save,
	shutdown: ctx.shutdown,
	print: (message) => process.stderr.write(message),
	exit: (code) => {
		process.exitCode = code;
		process.stderr.write("", () => stdout.write("", () => process.exit(code)));
	},
});
gracefulExit.install(process);

const removeInterruptListener = lines.onInterrupt(() => {
	const now = Date.now();
	lines.clearQueue();
	if (now - lastCtrlC < 500) {
		exitCode = 130;
		exitRequested = true;
		approvalAbort?.abort();
		void cancelController();
		return;
	}
	lastCtrlC = now;
	if (!busy) {
		exitCode = 130;
		exitRequested = true;
		lines.close();
		return;
	}
	approvalAbort?.abort();
	void cancelController();
	stdout.write("\n  \x1b[2m(cancelling; Ctrl+C again to exit)\x1b[0m\n");
});

if (flags.command) {
	await runOneShot(flags.command, lines);
} else {
	stdout.write(`anvil — ${ctx.activeProviderName}/${engine.model()} — ${projectRoot}\n`);
	if (ctx.activeAgent) stdout.write(`agent: ${ctx.activeAgent.name}\n`);
	if (ctx.activeSkill) stdout.write(`skill: ${ctx.activeSkill.name}\n`);
	stdout.write("Type /quit to exit, /skill to list, /model <name> to switch\n");
	stdout.write("Press Esc to interrupt agent, Ctrl+C twice to exit\n\n");

	emitKeypressEvents(stdin);
	stdin.on("keypress", (_text: string, key: { name?: string }) => {
		if (key?.name === "escape" && busy) {
			lines.clearQueue();
			approvalAbort?.abort();
			void cancelController();
			stdout.write("\n  [cancelling]\n");
		}
	});

	while (!exitRequested) {
		const input = await lines.prompt("> ");
		if (input === undefined) break;
		const trimmed = input.trim();
		if (!trimmed) continue;
		const lineCount = trimmed.split("\n").length;
		if (lineCount > 3) stdout.write(`\x1b[2m[${lineCount} lines]\x1b[0m\n`);
		busy = true;
		await runInteractiveTurn(trimmed, lines);
	}
	if (controller.getState().tokens.totalTokens > 0) {
		const tokens = controller.getState().tokens;
		stdout.write(`\nSession: ${tokens.totalTokens} tokens (${tokens.promptTokens} prompt)\n`);
	}
}

removeInterruptListener();
lines.close();
await gracefulExit.run(exitCode);
