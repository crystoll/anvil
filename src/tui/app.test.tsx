import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ControllerEvent,
	ControllerState,
	SessionController,
} from "../controller/controller.js";
import type { Tool } from "../tools/registry.js";
import { App } from "./app.js";

const editTool: Tool = {
	name: "edit_file",
	description: "Replace text in a file",
	schema: {},
	needsApproval: true,
	timeout: 1_000,
	execute: async () => "",
};

const createController = (initialState: Partial<ControllerState> = {}) => {
	let state: ControllerState = {
		phase: "idle",
		pending: undefined,
		streamingText: "",
		sessionId: undefined,
		model: "small-model",
		tokens: { promptTokens: 0, totalTokens: 0 },
		...initialState,
	};
	const listeners = new Set<(event: ControllerEvent) => void>();
	const controller: SessionController = {
		submit: vi.fn(async () => undefined),
		approve: vi.fn(async () => undefined),
		reject: vi.fn(async () => undefined),
		cancel: vi.fn(async () => undefined),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getState: () => state,
		shutdown: vi.fn(async () => undefined),
	};

	return {
		controller,
		updateState: (update: Partial<ControllerState>) => {
			state = { ...state, ...update };
			for (const listener of listeners) listener({ type: "state", state });
		},
		emitNotice: (message: string) => {
			for (const listener of listeners) listener({ type: "notice", message });
		},
	};
};

const renderApp = (
	controller: SessionController,
	options: { onExit?: () => void; initialNotices?: string[] } = {},
) =>
	render(
		<App
			controller={controller}
			providerName={() => "ollama"}
			activeSkillName={() => undefined}
			contextSize={8_192}
			initialNotices={options.initialNotices ?? []}
			commandNames={["help", "model", "quit"]}
			skillNames={[]}
			listModels={async () => []}
			onTurnComplete={async () => undefined}
			onPromptUsage={() => undefined}
			onExit={options.onExit ?? (() => undefined)}
		/>,
	);

const screens: Array<ReturnType<typeof renderApp>> = [];

const mountApp = (
	controller: SessionController,
	options: { onExit?: () => void; initialNotices?: string[] } = {},
) => {
	const screen = renderApp(controller, options);
	screens.push(screen);
	return screen;
};

afterEach(() => {
	for (const screen of screens.splice(0)) screen.unmount();
	vi.restoreAllMocks();
});

describe("TUI App", () => {
	it.each([
		["y", "approve", "once"],
		["n", "reject", "User declined"],
		["a", "approve", "always"],
	] as const)("maps approval key %s to %s(%s)", async (key, method, argument) => {
		const { controller } = createController({
			phase: "awaiting_approval",
			pending: {
				call: { tool: editTool, args: { path: "notes.md" }, callId: "call-1", raw: "{}" },
				index: 1,
				total: 2,
			},
		});
		const screen = mountApp(controller);

		screen.stdin.write(key);

		await vi.waitFor(() => expect(controller[method]).toHaveBeenCalledWith(argument));
	});

	it("cancels when Esc is pressed while a response is streaming", async () => {
		const { controller } = createController({ phase: "streaming" });
		const screen = mountApp(controller);

		screen.stdin.write("\u001b");

		await vi.waitFor(() => expect(controller.cancel).toHaveBeenCalledOnce());
	});

	it("cancels a pending approval when Esc is pressed", async () => {
		const { controller } = createController({
			phase: "awaiting_approval",
			pending: {
				call: { tool: editTool, args: { path: "notes.md" }, callId: "call-1", raw: "{}" },
				index: 1,
				total: 1,
			},
		});
		const screen = mountApp(controller);

		screen.stdin.write("\u001b");

		await vi.waitFor(() => expect(controller.cancel).toHaveBeenCalledOnce());
	});

	it("uses Ctrl+C to cancel while awaiting approval", async () => {
		const { controller } = createController({
			phase: "awaiting_approval",
			pending: {
				call: { tool: editTool, args: { path: "notes.md" }, callId: "call-1", raw: "{}" },
				index: 1,
				total: 1,
			},
		});
		const screen = mountApp(controller);

		screen.stdin.write("\u0003");

		await vi.waitFor(() => expect(controller.cancel).toHaveBeenCalledOnce());
	});

	it("uses Ctrl+C to cancel while busy and exits on a second idle press", async () => {
		const busy = createController({ phase: "streaming" });
		const busyScreen = mountApp(busy.controller);
		busyScreen.stdin.write("\u0003");
		await vi.waitFor(() => expect(busy.controller.cancel).toHaveBeenCalledOnce());

		const onExit = vi.fn();
		const idle = createController();
		const idleScreen = mountApp(idle.controller, { onExit });
		idleScreen.stdin.write("\u0003");
		await vi.waitFor(() => expect(idleScreen.lastFrame()).toContain("press Ctrl+C again to exit"));
		idleScreen.stdin.write("\u0003");
		expect(onExit).toHaveBeenCalledOnce();
	});

	it("navigates submitted input history with the up and down arrows", async () => {
		const { controller } = createController();
		const screen = mountApp(controller);

		screen.stdin.write("first prompt");
		await vi.waitFor(() => expect(screen.lastFrame()).toContain("first prompt"));
		screen.stdin.write("\r");
		await vi.waitFor(() => expect(controller.submit).toHaveBeenCalledWith("first prompt"));
		screen.stdin.write("second prompt");
		await vi.waitFor(() => expect(screen.lastFrame()).toContain("second prompt"));
		screen.stdin.write("\r");
		await vi.waitFor(() => expect(controller.submit).toHaveBeenCalledTimes(2));
		screen.stdin.write("\u001b[A");
		await vi.waitFor(() => expect(screen.lastFrame()).toContain("second prompt"));
		screen.stdin.write("\u001b[A");
		await vi.waitFor(() => expect(screen.lastFrame()).toContain("first prompt"));
		screen.stdin.write("\u001b[B");
		await vi.waitFor(() => expect(screen.lastFrame()).toContain("second prompt"));
		screen.stdin.write("\r");

		await vi.waitFor(() => expect(controller.submit).toHaveBeenLastCalledWith("second prompt"));
	});

	it("renders approval queue position and edit previews", () => {
		const { controller } = createController({
			phase: "awaiting_approval",
			pending: {
				call: {
					tool: editTool,
					args: { path: "notes.md", search: "old text", replace: "new text" },
					callId: "call-1",
					raw: "{}",
				},
				index: 2,
				total: 3,
			},
		});

		const screen = mountApp(controller);

		expect(screen.lastFrame()).toContain("[2/3] edit_file(notes.md)");
		expect(screen.lastFrame()).toContain("- old text");
		expect(screen.lastFrame()).toContain("+ new text");
	});

	it("renders streamed text and controller notices", async () => {
		const { controller, emitNotice, updateState } = createController();
		const screen = mountApp(controller);

		updateState({ phase: "streaming", streamingText: "partial response" });
		await vi.waitFor(() => expect(screen.lastFrame()).toContain("anvil: partial response"));
		emitNotice("Session saved");
		await vi.waitFor(() => expect(screen.lastFrame()).toContain("Session saved"));
	});

	it("renders startup notices", () => {
		const { controller } = createController();

		const screen = mountApp(controller, { initialNotices: ["Ollama unavailable"] });

		expect(screen.lastFrame()).toContain("Ollama unavailable");
	});
});
