import { render } from "ink";
import {
	createAppCommandRegistry,
	formatContextSummary,
	registerUiCommands,
} from "../controller/app-commands.js";
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
registerUiCommands(commands, ctx, {
	getTokenUsage: () => controller.getState().tokens,
	getLastPromptTokens: () => lastPromptTokens,
	formatContext: formatContextSummary,
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
