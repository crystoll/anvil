import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { createElement } from "react";
import type {
	ControllerEvent,
	ControllerState,
	SessionController,
} from "../src/controller/controller.js";
import type { TuiAppProps } from "../src/tui/app.js";
import { App } from "../src/tui/app.js";

type Demo = {
	title: string;
	filename: string;
	prompt: string;
	answer: string;
	toolResult?: string;
	promptTokens?: number;
	totalTokens?: number;
};

const demos: Demo[] = [
	{
		title: "Anvil — tool-assisted session",
		filename: "anvil-demo.svg",
		prompt: "Find the default model and context size",
		toolResult: "default_model is gemma4:e4b; context_size is 32768",
		answer: "Anvil defaults to gemma4:e4b with a 32k-token context window.",
	},
	{
		title: "Anvil — local Ollama model",
		filename: "anvil-local-ollama.svg",
		prompt: "Why should a coding agent save conversation history?",
		answer: process.argv[2] ?? "",
		promptTokens: 1_291,
		totalTokens: 1_405,
	},
];

if (!demos[1]?.answer) throw new Error("Pass the local Ollama response as the first argument.");

const createController = (demo: Demo): { controller: SessionController; finish: () => void } => {
	let state: ControllerState = {
		phase: "idle",
		pending: undefined,
		streamingText: "",
		sessionId: "demo-session",
		model: "gemma4:e4b",
		tokens: { promptTokens: 0, totalTokens: 0 },
	};
	const listeners = new Set<(event: ControllerEvent) => void>();
	const emit = (event: ControllerEvent): void => {
		for (const listener of listeners) listener(event);
	};
	const updateState = (update: Partial<ControllerState>): void => {
		state = { ...state, ...update };
		emit({ type: "state", state });
	};
	let completeSubmission = (): void => undefined;
	const submissionComplete = new Promise<void>((resolve) => {
		completeSubmission = resolve;
	});

	const controller: SessionController = {
		submit: async () => {
			updateState({ phase: "streaming", streamingText: "" });
			if (demo.toolResult)
				emit({
					type: "agent",
					event: { kind: "tool_result", name: "read_file", result: demo.toolResult },
				});
			state = {
				...state,
				streamingText: demo.answer,
				tokens: {
					promptTokens: demo.promptTokens ?? 0,
					totalTokens: demo.totalTokens ?? 0,
				},
			};
			emit({ type: "state", state });
			emit({ type: "agent", event: { kind: "content", text: demo.answer } });
			if (demo.totalTokens !== undefined)
				emit({
					type: "agent",
					event: {
						kind: "usage",
						promptTokens: demo.promptTokens ?? 0,
						totalTokens: demo.totalTokens,
					},
				});
			await submissionComplete;
			updateState({ phase: "idle" });
		},
		approve: async () => undefined,
		reject: async () => undefined,
		cancel: async () => undefined,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getState: () => state,
		shutdown: async () => undefined,
	};
	return {
		controller,
		finish: () => {
			completeSubmission();
		},
	};
};

const appProps = (controller: SessionController): TuiAppProps => ({
	controller,
	providerName: () => "ollama",
	activeSkillName: () => undefined,
	contextSize: 32_768,
	initialNotices: [],
	commandNames: ["help", "history", "model", "quit", "resume"],
	skillNames: [],
	listModels: async () => [],
	listSessions: () => [],
	onTurnComplete: async () => undefined,
	onPromptUsage: () => undefined,
	onExit: () => undefined,
});

const escapeXml = (value: string): string =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const renderSvg = (title: string, frame: string): string => {
	const rows = frame.split("\n").map((row) => row.replace(/\s+$/, ""));
	const width = Math.max(820, ...rows.map((row) => row.length * 9 + 52));
	const height = 76 + rows.length * 24;
	const renderedRows = rows
		.map((row, index) => {
			const color = row.includes("ollama/")
				? "#89b4fa"
				: row.includes("❯")
					? "#a6e3a1"
					: row.includes("↳")
						? "#a6adc8"
						: "#cdd6f4";
			return `<text x="28" y="${66 + index * 24}" fill="${color}">${escapeXml(row)}</text>`;
		})
		.join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
<rect width="100%" height="100%" rx="14" fill="#11131a"/>
<path d="M14 0h${width - 28}a14 14 0 0 1 14 14v34H0V14A14 14 0 0 1 14 0" fill="#242631"/>
<circle cx="22" cy="22" r="6" fill="#f38ba8"/>
<circle cx="44" cy="22" r="6" fill="#f9e2af"/>
<circle cx="66" cy="22" r="6" fill="#a6e3a1"/>
<text x="88" y="27" fill="#bac2de" font-family="sans-serif" font-size="13">${escapeXml(title)}</text>
<rect x="0" y="48" width="${width}" height="${height - 48}" fill="#11131a"/>
<g font-family="SFMono-Regular, Consolas, monospace" font-size="15">${renderedRows}</g>
</svg>`;
};

const waitForCompletedResponse = async (
	screen: ReturnType<typeof render>,
	demoController: ReturnType<typeof createController>,
	demo: Demo,
): Promise<string> => {
	const expected = demo.answer.slice(0, Math.min(30, demo.answer.length));
	for (let attempt = 0; attempt < 50; attempt++) {
		if (screen.lastFrame()?.includes(expected)) {
			demoController.finish();
			for (let completionAttempt = 0; completionAttempt < 50; completionAttempt++) {
				if (demoController.controller.getState().phase === "idle") {
					const frame = screen.lastFrame();
					if (frame?.includes(expected)) return renderSvg(demo.title, frame);
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(`UI did not finish the model response for ${demo.filename}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`UI did not render the model response for ${demo.filename}`);
};

const capture = async (demo: Demo): Promise<string> => {
	const demoController = createController(demo);
	const screen = render(createElement(App, appProps(demoController.controller)));
	try {
		screen.stdin.write(`${demo.prompt}\r`);
		return await waitForCompletedResponse(screen, demoController, demo);
	} finally {
		demoController.finish();
		await new Promise((resolve) => setTimeout(resolve, 10));
		screen.unmount();
	}
};

const outputDirectory = join(import.meta.dirname, "../docs/assets");
mkdirSync(outputDirectory, { recursive: true });
for (const demo of demos) {
	const svg = await capture(demo);
	writeFileSync(join(outputDirectory, demo.filename), svg);
}
