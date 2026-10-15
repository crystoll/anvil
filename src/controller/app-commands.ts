import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compactHistory } from "../agent/compact.js";
import type { AgentDef } from "../agents/agents.js";
import type { AnvilConfig } from "../config/config.js";
import type { Engine } from "../engine/engine.js";
import { repairHistory } from "../engine/history.js";
import type { TokenUsage } from "../provider/types.js";
import { listSessions, loadSession, type SessionWriter } from "../session/index.js";
import {
	makeProvider,
	type ProviderHealth,
	pingProvider,
	resolveProviderModel,
} from "../shared/bootstrap.js";
import type { Skill } from "../skills/index.js";
import type { Registry } from "../tools/registry.js";
import { type CommandRegistry, type CommandResult, createCommandRegistry } from "./commands.js";

export type ContextUsage = {
	used: number;
	limit: number;
	percentage: number;
	toolCount: number;
	toolTokens: number;
	trimAt: number;
};

type UiCommandOptions = {
	getTokenUsage: () => TokenUsage;
	getLastPromptTokens: () => number;
	formatContext: (usage: ContextUsage) => string;
};

export type AppCommandContext = {
	config: Pick<
		AnvilConfig,
		| "providers"
		| "contextSize"
		| "connectTimeout"
		| "streamTimeout"
		| "firstTokenTimeout"
		| "keepAlive"
	>;
	engine: Pick<
		Engine,
		"messages" | "model" | "getProvider" | "setModel" | "setProvider" | "loadMessages" | "reset"
	>;
	registry: Pick<Registry, "all" | "schemas">;
	activeProviderName: string;
	healthyProviders: Map<string, ProviderHealth>;
	availableSkills: Skill[];
	activeSkill: Skill | undefined;
	availableAgents: AgentDef[];
	activeAgent: AgentDef | undefined;
	historyDir: string;
	session: Pick<SessionWriter, "id" | "save" | "startNew" | "resume">;
	setActiveSkill: (skill: Skill | undefined) => void;
	setActiveAgent: (agent: AgentDef) => void;
};

const handled = (
	message: string,
	options: { resetUsage?: boolean; usage?: { promptTokens: number; totalTokens: number } } = {},
): CommandResult => ({ kind: "handled", message, ...options });

const saveCommandChanges = (
	context: AppCommandContext,
	usage?: { promptTokens: number; totalTokens: number },
): string => {
	const result = context.session.save(usage);
	return result.isErr() ? `Couldn't save session: ${result.error}` : "";
};

const contextUsage = (context: AppCommandContext, used: number): ContextUsage => {
	const limit = context.config.contextSize;
	return {
		used,
		limit,
		percentage: used > 0 ? Math.round((used / limit) * 100) : 0,
		toolCount: context.registry.all().length,
		toolTokens: Math.round(JSON.stringify(context.registry.schemas()).length / 4),
		trimAt: Math.round(limit * 0.8),
	};
};

export const formatContextSummary = (usage: ContextUsage): string =>
	[
		"[context]",
		`  limit:     ${usage.limit.toLocaleString()} tokens`,
		`  used:      ~${usage.used.toLocaleString()} (${usage.percentage}%)`,
		`  tools:     ${usage.toolCount} (~${usage.toolTokens.toLocaleString()} tokens)`,
		`  trim at:   80% (~${usage.trimAt.toLocaleString()} tokens)`,
		"  compact:   auto at ~80%; overflow retry at 95%",
		usage.percentage >= 60 ? "  hint: /compact to manually free context" : "",
	]
		.filter(Boolean)
		.join("\n");

const saveTranscript = (context: AppCommandContext): string => {
	const messages = context.engine.messages();
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

export const registerUiCommands = (
	commands: CommandRegistry,
	context: AppCommandContext,
	options: UiCommandOptions,
): void => {
	commands.register({
		name: "usage",
		description: "Show session token usage",
		execute: () => {
			const usage = options.getTokenUsage();
			const completion = usage.totalTokens - usage.promptTokens;
			return handled(
				`Session: ${usage.totalTokens} tokens (${usage.promptTokens} prompt, ${completion} completion) · ${context.engine.messages().length} msgs`,
			);
		},
	});
	commands.register({
		name: "context",
		description: "Show context window usage",
		execute: () =>
			handled(options.formatContext(contextUsage(context, options.getLastPromptTokens()))),
	});
	commands.register({
		name: "transcript",
		description: "Export the conversation to Markdown",
		execute: () => handled(saveTranscript(context)),
	});
};

const listModels = async (context: AppCommandContext): Promise<CommandResult> => {
	const available = Object.entries(context.config.providers).filter(
		([name]) => context.healthyProviders.get(name)?.status === "healthy",
	);
	const groups = await Promise.all(
		available.map(async ([name, entry]) => {
			const result = await makeProvider(name, entry, {
				firstTokenTimeout: context.config.firstTokenTimeout,
				streamTimeout: context.config.streamTimeout,
				connectTimeout: context.config.connectTimeout,
				keepAlive: context.config.keepAlive,
			}).listModels();
			return result.isOk()
				? result.value.map((model) => `${name}/${model}`)
				: [`${name}: ${result.error.message}`];
		}),
	);
	const models = groups.flat();
	return handled(models.length > 0 ? models.join("\n") : "No models available");
};

const selectModel = async (
	context: AppCommandContext,
	argument: string,
): Promise<CommandResult> => {
	const { provider: providerName, model } = resolveProviderModel(
		argument,
		context.config.providers,
		context.engine.getProvider().name,
	);
	const entry = context.config.providers[providerName];
	if (!entry) return handled(`Provider "${providerName}" is not configured`);

	const health = await pingProvider(providerName, entry, context.config.connectTimeout * 1000);
	if (health.status !== "healthy")
		return handled(`Provider "${providerName}": ${health.message ?? health.status}`);

	if (context.engine.getProvider().name !== providerName) {
		context.engine.setProvider(
			makeProvider(providerName, entry, {
				firstTokenTimeout: context.config.firstTokenTimeout,
				streamTimeout: context.config.streamTimeout,
				connectTimeout: context.config.connectTimeout,
				keepAlive: context.config.keepAlive,
			}),
		);
	}
	context.activeProviderName = providerName;
	context.engine.setModel(model);
	return handled(`Switched to: ${providerName}/${model}`);
};

const modelCommand = async (
	context: AppCommandContext,
	argument: string,
): Promise<CommandResult> => {
	const model = argument.trim();
	return model ? selectModel(context, model) : listModels(context);
};

const skillCommand = (context: AppCommandContext, argument: string): CommandResult => {
	const name = argument.trim();
	if (!name)
		return handled(
			context.availableSkills
				.map((skill) => `${skill.name}${skill.name === context.activeSkill?.name ? " *" : ""}`)
				.join("\n") || "No skills found",
		);
	const skill = context.availableSkills.find((candidate) => candidate.name === name);
	if (!skill) return handled(`Skill "${name}" not found`);
	context.setActiveSkill(skill);
	context.activeSkill = skill;
	return handled(`Activated: ${skill.name}`);
};

const agentCommand = (context: AppCommandContext, argument: string): CommandResult => {
	const name = argument.trim();
	if (!name)
		return handled(
			context.availableAgents
				.map(
					(agent) =>
						`${agent.name}${agent.name === context.activeAgent?.name ? " *" : ""}${
							agent.description ? ` — ${agent.description}` : ""
						}`,
				)
				.join("\n") || "No agents found",
		);
	const agent = context.availableAgents.find((candidate) => candidate.name === name);
	if (!agent) return handled(`Agent "${name}" not found`);
	context.setActiveAgent(agent);
	context.activeAgent = agent;
	return handled(`Activated agent: ${agent.name}`);
};

const compactCommand = async (context: AppCommandContext): Promise<CommandResult> => {
	const messages = [...context.engine.messages()];
	const before = Math.round(messages.map((message) => message.content).join("").length / 4);
	const result = await compactHistory(
		context.engine.getProvider(),
		context.engine.model(),
		messages,
		{ contextSize: context.config.contextSize },
	);
	if (result.isErr()) return handled(`Compaction failed: ${result.error.message}`);
	context.engine.loadMessages(result.value);
	const after = Math.round(result.value.map((message) => message.content).join("").length / 4);
	const saveMessage = saveCommandChanges(context);
	return handled(
		`Compacted context: ~${before.toLocaleString()} → ~${after.toLocaleString()} tokens${saveMessage ? `\n${saveMessage}` : ""}`,
	);
};

const rewindCommand = (context: AppCommandContext, argument: string): CommandResult => {
	const turns = Number(argument.trim());
	const messages = [...context.engine.messages()];
	const userIndices = messages.flatMap((message, index) =>
		message.role === "user" ? [index] : [],
	);
	if (!Number.isInteger(turns) || turns < 1 || turns > userIndices.length)
		return handled(`Usage: /rewind N (1-${userIndices.length} user turns)`);
	const nextUserIndex = userIndices[turns] ?? messages.length;
	context.engine.loadMessages(messages.slice(0, nextUserIndex));
	const saveMessage = saveCommandChanges(context, { promptTokens: 0, totalTokens: 0 });
	return handled(`Rewound to turn ${turns}${saveMessage ? `\n${saveMessage}` : ""}`, {
		resetUsage: true,
	});
};

const historyCommand = (context: AppCommandContext): CommandResult => {
	const sessions = listSessions(context.historyDir);
	const rows = sessions.slice(0, 10).map((session, index) => {
		const loaded = loadSession(context.historyDir, session.id);
		const preview = loaded.isOk()
			? (loaded.value.messages.find((message) => message.role === "user")?.content ?? "")
					.replace(/\n/g, " ")
					.slice(0, 50)
			: `[load failed: ${loaded.error}]`;
		const marker = session.id === context.session.id() ? " *" : "";
		return `${index + 1}. ${session.id}${marker} ${preview}`;
	});
	return handled(rows.join("\n") || "No saved sessions");
};

const resumeCommand = (context: AppCommandContext, argument: string): CommandResult => {
	const id = argument.trim();
	if (!id) return handled("Usage: /resume <session-id>");
	const matches = listSessions(context.historyDir).filter((session) => session.id.startsWith(id));
	if (matches.length !== 1)
		return handled(
			matches.length === 0 ? `Session "${id}" not found` : `Session id "${id}" is ambiguous`,
		);
	const session = matches[0];
	if (!session) return handled(`Session "${id}" not found`);
	const loaded = loadSession(context.historyDir, session.id);
	if (loaded.isErr()) return handled(`Couldn't load session: ${loaded.error}`);
	const repaired = repairHistory(loaded.value.messages);
	context.engine.loadMessages(repaired.messages);
	context.session.resume(session.id);
	const saveMessage = saveCommandChanges(context, loaded.value.tokenUsage);
	const note = repaired.hasUnansweredUser ? "; last request has no assistant reply" : "";
	const message = `Resumed session ${session.id}${note}${saveMessage ? `\n${saveMessage}` : ""}`;
	return loaded.value.tokenUsage
		? handled(message, { usage: loaded.value.tokenUsage })
		: handled(message);
};

const retryCommand = (context: AppCommandContext): CommandResult => {
	const messages = [...context.engine.messages()];
	const userIndex = messages.findLastIndex((message) => message.role === "user");
	const lastUser = messages[userIndex];
	if (userIndex < 0 || !lastUser || lastUser.role !== "user")
		return handled("No user request to retry");
	context.engine.loadMessages(messages.slice(0, userIndex));
	return { kind: "submit", input: lastUser.content };
};

/** Create the shared, headless command registry for both interactive interfaces. */
export const createAppCommandRegistry = (context: AppCommandContext): CommandRegistry =>
	createCommandRegistry([
		{
			name: "model",
			description: "List or switch provider/model",
			execute: (argument) => modelCommand(context, argument),
		},
		{
			name: "agent",
			description: "List or switch agents",
			execute: (argument) => agentCommand(context, argument),
		},
		{
			name: "skill",
			description: "List or activate a skill",
			execute: (argument) => skillCommand(context, argument),
		},
		{
			name: "plan",
			description: "Ask for a step-by-step plan",
			execute: (argument) =>
				argument.trim()
					? {
							kind: "submit",
							input: `Break this task into numbered steps (just the steps, no explanation):\n${argument.trim()}`,
						}
					: handled("Usage: /plan <task description>"),
		},
		{
			name: "compact",
			description: "Compact conversation history",
			execute: () => compactCommand(context),
		},
		{
			name: "rewind",
			description: "Keep the first N user turns",
			execute: (argument) => rewindCommand(context, argument),
		},
		{
			name: "history",
			description: "List saved sessions",
			execute: () => historyCommand(context),
		},
		{
			name: "resume",
			description: "Resume a saved session by id",
			execute: (argument) => resumeCommand(context, argument),
		},
		{
			name: "retry",
			description: "Retry the last user request",
			execute: () => retryCommand(context),
		},
		{
			name: "continue",
			description: "Continue after a round cap or output limit",
			execute: () => ({ kind: "continue" }),
		},
		{
			name: "new",
			description: "Start a new session",
			execute: () => {
				context.engine.reset();
				context.session.startNew();
				const saveMessage = saveCommandChanges(context, { promptTokens: 0, totalTokens: 0 });
				return handled(`New session started${saveMessage ? `\n${saveMessage}` : ""}`, {
					resetUsage: true,
				});
			},
		},
	]);
