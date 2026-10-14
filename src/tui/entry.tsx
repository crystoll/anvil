import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { createAppCommandRegistry } from "../controller/app-commands.js";
import { createSessionController } from "../controller/controller.js";
import { bootstrap, expandFileRefs, makeProvider, parseFlags } from "../shared/bootstrap.js";
import { guardProcess } from "../shared/crash-guard.js";
import { createGracefulExit } from "../shared/graceful-exit.js";
import { App } from "./app.js";

const flags = parseFlags(process.argv);
const ctx = await bootstrap(flags);
if (flags.path) process.chdir(ctx.projectRoot);

const commands = createAppCommandRegistry(ctx);
const controller = createSessionController({
	agent: ctx.agent,
	engine: ctx.engine,
	session: ctx.session,
	shutdown: ctx.shutdown,
	commands,
	expandInput: (input) => expandFileRefs(input, ctx.projectRoot),
});

let lastPromptTokens = 0;
commands.register({
	name: "usage",
	description: "Show session token usage",
	execute: () => {
		const usage = controller.getState().tokens;
		return {
			kind: "handled",
			message: `${usage.totalTokens} tok | ${ctx.engine.messages().length} msgs`,
		};
	},
});
commands.register({
	name: "context",
	description: "Show context window usage",
	execute: () => {
		const pct =
			lastPromptTokens > 0 ? Math.round((lastPromptTokens / ctx.config.contextSize) * 100) : 0;
		const tools = ctx.registry.all().length;
		const toolTokens = Math.round(JSON.stringify(ctx.registry.schemas()).length / 4);
		const trimAt = Math.round(ctx.config.contextSize * 0.8);
		return {
			kind: "handled",
			message: [
				"[context]",
				`  limit:     ${ctx.config.contextSize.toLocaleString()} tokens`,
				`  used:      ~${lastPromptTokens.toLocaleString()} (${pct}%)`,
				`  tools:     ${tools} (~${toolTokens.toLocaleString()} tokens)`,
				`  trim at:   80% (~${trimAt.toLocaleString()} tokens)`,
				"  compact:   on overflow (auto)",
				pct >= 60 ? "  hint: /compact to manually free context" : "",
			]
				.filter(Boolean)
				.join("\n"),
		};
	},
});
commands.register({
	name: "transcript",
	description: "Export the conversation to Markdown",
	execute: () => {
		const messages = ctx.engine.messages();
		if (messages.length === 0) return { kind: "handled", message: "No messages to export." };
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
		return { kind: "handled", message: `Transcript saved: ${path}` };
	},
});

const listModels = async (): Promise<string[]> => {
	const healthyProviders = Object.entries(ctx.config.providers).filter(
		([name]) => ctx.healthyProviders.get(name)?.status === "healthy",
	);
	const results = await Promise.all(
		healthyProviders.map(async ([name, entry]) => {
			const result = await makeProvider(name, entry, {
				streamTimeout: ctx.config.streamTimeout,
				connectTimeout: ctx.config.connectTimeout,
			}).listModels();
			return result.match(
				(models) => ({
					kind: "models" as const,
					models: models.map((model) => `${name}/${model}`),
				}),
				(error) => ({ kind: "error" as const, message: `${name}: ${error.message}` }),
			);
		}),
	);
	const failures = results.filter((result) => result.kind === "error");
	if (failures.length > 0) throw new Error(failures.map((failure) => failure.message).join("\n"));
	return results.flatMap((result) => (result.kind === "models" ? result.models : []));
};

let requestExit = (): void => undefined;
const initialNotices = [
	...(ctx.healthyProviders.get(ctx.activeProviderName)?.status !== "healthy"
		? [
				`${ctx.activeProviderName}: ${ctx.healthyProviders.get(ctx.activeProviderName)?.message ?? "provider unavailable"} — use /model to switch`,
			]
		: []),
	...ctx.mcpWarnings,
];
const app = render(
	<App
		controller={controller}
		providerName={() => ctx.activeProviderName}
		activeSkillName={() => ctx.activeSkill?.name}
		contextSize={ctx.config.contextSize}
		initialNotices={initialNotices}
		commandNames={[...commands.list().map(({ name }) => name), "exit"]}
		skillNames={ctx.availableSkills.map((skill) => skill.name)}
		listModels={listModels}
		onTurnComplete={ctx.fireStopHooks}
		onPromptUsage={(tokens) => {
			lastPromptTokens = tokens;
		}}
		onExit={() => requestExit()}
	/>,
	{ exitOnCtrlC: false },
);
const gracefulExit = createGracefulExit({
	cancel: controller.cancel,
	closeUi: () => app.unmount(),
	flush: ctx.session.save,
	shutdown: ctx.shutdown,
	print: (message) => process.stderr.write(message),
	exit: (code) => {
		process.exitCode = code;
		process.stderr.write("", () => process.stdout.write("", () => process.exit(code)));
	},
});
requestExit = () => {
	void gracefulExit.run();
};
gracefulExit.install(process);
guardProcess({ flush: ctx.session.save, restoreTerminal: () => app.unmount() });
