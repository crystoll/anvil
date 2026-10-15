import type { AgentEvent, createAgentLoop, PendingCall } from "../agent/loop.js";
import type { Engine } from "../engine/engine.js";
import type { TokenUsage } from "../provider/types.js";
import type { SessionStatus } from "../session/session.js";
import type { SessionWriter } from "../session/writer.js";
import { type CommandRegistry, type CommandResult, createCommandRegistry } from "./commands.js";

export type ControllerPhase =
	| "idle"
	| "streaming"
	| "executing"
	| "awaiting_approval"
	| "cancelling"
	| "compacting";

export type PendingApproval = { call: PendingCall; index: number; total: number };

export type ControllerState = {
	phase: ControllerPhase;
	pending: PendingApproval | undefined;
	streamingText: string;
	sessionId: string | undefined;
	model: string;
	tokens: TokenUsage;
};

export type ControllerEvent =
	| { type: "agent"; event: AgentEvent }
	| { type: "state"; state: ControllerState }
	| { type: "notice"; message: string }
	| { type: "quit" };

export type SessionController = {
	submit: (input: string) => Promise<void>;
	approve: (scope: "once" | "always") => Promise<void>;
	reject: (reason?: string) => Promise<void>;
	cancel: () => Promise<void>;
	subscribe: (listener: (event: ControllerEvent) => void) => () => void;
	getState: () => ControllerState;
	shutdown: () => Promise<void>;
};

export type SessionControllerOptions = {
	agent: ReturnType<typeof createAgentLoop>;
	engine: Pick<Engine, "messages" | "model">;
	session: SessionWriter;
	shutdown: () => Promise<void>;
	commands?: CommandRegistry;
	expandInput?: (input: string) => string;
};

const phaseForAgentEvent = (event: AgentEvent): ControllerPhase | undefined => {
	if (event.kind === "state") {
		if (event.state === "streaming") return "streaming";
		if (event.state === "executing") return "executing";
		if (event.state === "pending") return "awaiting_approval";
		if (event.state === "idle" || event.state === "done" || event.state === "stuck") return "idle";
	}
	if (event.kind === "pending") return "awaiting_approval";
	if (event.kind === "compacting") return "compacting";
	return undefined;
};

const sessionStatusForEvent = (event: AgentEvent): SessionStatus | undefined => {
	switch (event.kind) {
		case "done":
			return "complete";
		case "stuck":
			return "error";
		case "error":
			return event.status === "interrupted" ? "interrupted" : "error";
		default:
			return undefined;
	}
};

/** Own turn orchestration and expose a UI-independent event and command surface. */
export const createSessionController = (options: SessionControllerOptions): SessionController => {
	const listeners = new Set<(event: ControllerEvent) => void>();
	const approvedTools = new Set<string>();
	const commands = options.commands ?? createCommandRegistry();
	let activeOperations = 0;
	let agentActive = false;
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | undefined;
	let turnStatus: SessionStatus | undefined;
	let turnInterrupted = false;
	let operationsFinished = Promise.resolve();
	let finishOperations = (): void => undefined;
	let state: ControllerState = {
		phase: "idle",
		pending: undefined,
		streamingText: "",
		sessionId: options.session.id(),
		model: options.engine.model(),
		tokens: { promptTokens: 0, totalTokens: 0 },
	};

	const snapshot = (): ControllerState => ({
		...state,
		pending: state.pending ? { ...state.pending } : undefined,
		tokens: { ...state.tokens },
		model: options.engine.model(),
		sessionId: options.session.id(),
	});

	const emit = (event: ControllerEvent): void => {
		for (const listener of listeners) listener(event);
	};

	const updateState = (update: Partial<ControllerState>): void => {
		state = { ...state, ...update };
		emit({ type: "state", state: snapshot() });
	};

	const notice = (message: string): void => emit({ type: "notice", message });
	const isBusy = (): boolean => activeOperations > 0 || state.phase !== "idle";
	const beginOperation = (): void => {
		if (activeOperations === 0) {
			operationsFinished = new Promise<void>((resolve) => {
				finishOperations = resolve;
			});
		}
		activeOperations++;
	};
	const endOperation = (): void => {
		activeOperations--;
		if (activeOperations === 0) finishOperations();
	};

	const saveSession = (): void => {
		const result = options.session.save(state.tokens);
		if (result.isErr()) {
			notice(`Couldn't save session: ${result.error}`);
			return;
		}
		updateState({ sessionId: result.value });
	};

	const applyAgentEvent = (event: AgentEvent): void => {
		const status = sessionStatusForEvent(event);
		if (status) turnStatus = status;
		const phase = phaseForAgentEvent(event);
		const update: Partial<ControllerState> = {};
		if (phase) update.phase = phase;
		if (event.kind === "pending")
			update.pending = { call: event.call, index: event.index, total: event.total };
		if (event.kind === "state" && event.state !== "pending") update.pending = undefined;
		if (event.kind === "content") update.streamingText = state.streamingText + event.text;
		if (event.kind === "usage") {
			update.tokens = {
				promptTokens: state.tokens.promptTokens + event.promptTokens,
				totalTokens: state.tokens.totalTokens + event.totalTokens,
			};
		}
		if (Object.keys(update).length > 0) updateState(update);
		emit({ type: "agent", event });
	};

	const consumeAgentEvents = async (events: AsyncGenerator<AgentEvent>): Promise<void> => {
		for await (const event of events) {
			if (event.kind === "pending" && approvedTools.has(event.call.tool.name)) {
				const approvedEvents = options.agent.approve();
				updateState({ phase: "executing", pending: undefined });
				await consumeAgentEvents(approvedEvents);
				continue;
			}
			applyAgentEvent(event);
		}
	};

	const runAgent = async (
		events: AsyncGenerator<AgentEvent>,
		initialState?: Partial<ControllerState>,
	): Promise<void> => {
		beginOperation();
		agentActive = true;
		turnStatus = undefined;
		turnInterrupted = false;
		options.session.setStatus("interrupted");
		try {
			if (initialState) updateState(initialState);
			await consumeAgentEvents(events);
		} finally {
			agentActive = false;
			try {
				if (state.phase !== "awaiting_approval") updateState({ phase: "idle", pending: undefined });
				const status =
					state.phase === "awaiting_approval" || turnInterrupted
						? "interrupted"
						: (turnStatus ?? "complete");
				options.session.setStatus(status);
				saveSession();
			} finally {
				endOperation();
			}
		}
	};

	const applyHandledCommand = (result: Extract<CommandResult, { kind: "handled" }>): void => {
		if (result.message) notice(result.message);
		const tokens =
			result.usage ?? (result.resetUsage ? { promptTokens: 0, totalTokens: 0 } : state.tokens);
		updateState({
			model: options.engine.model(),
			sessionId: options.session.id(),
			tokens,
		});
	};

	const dispatchInput = async (input: string): Promise<void> => {
		const result = await commands.dispatch(input);
		if (result?.kind === "handled") {
			applyHandledCommand(result);
			return;
		}
		if (result?.kind === "quit") {
			emit({ type: "quit" });
			return;
		}
		if (result?.kind === "continue") {
			await runAgent(options.agent.continue(), {
				phase: "streaming",
				streamingText: "",
			});
			return;
		}
		const message = result?.kind === "submit" ? result.input : input;
		await runAgent(options.agent.send(options.expandInput?.(message) ?? message), {
			phase: "streaming",
			streamingText: "",
		});
	};

	const submit = async (input: string): Promise<void> => {
		if (shuttingDown) {
			notice("Cannot submit while the session is shutting down");
			return;
		}
		if (isBusy()) {
			notice("Cannot submit while a turn is active");
			return;
		}
		const trimmed = input.trim();
		if (!trimmed) return;

		beginOperation();
		try {
			updateState({ streamingText: "" });
			await dispatchInput(trimmed);
		} finally {
			endOperation();
		}
	};

	const approve = async (scope: "once" | "always"): Promise<void> => {
		if (shuttingDown) return;
		const pending = state.pending;
		if (state.phase !== "awaiting_approval" || !pending) {
			notice("No tool call is awaiting approval");
			return;
		}
		if (scope === "always") approvedTools.add(pending.call.tool.name);
		await runAgent(options.agent.approve(), {
			phase: "executing",
			pending: undefined,
			streamingText: "",
		});
	};

	const reject = async (reason?: string): Promise<void> => {
		if (shuttingDown) return;
		if (state.phase !== "awaiting_approval" || !state.pending) {
			notice("No tool call is awaiting approval");
			return;
		}
		await runAgent(options.agent.reject(reason), {
			phase: "executing",
			pending: undefined,
			streamingText: "",
		});
	};

	const cancel = async (): Promise<void> => {
		if (state.phase === "idle" && !agentActive) return;
		turnInterrupted = true;
		options.session.setStatus("interrupted");
		const completion = operationsFinished;
		updateState({ phase: "cancelling", pending: undefined });
		await options.agent.cancel();
		await completion;
		if (!agentActive) {
			updateState({ phase: "idle" });
			saveSession();
		}
	};

	const shutdown = (): Promise<void> => {
		if (shutdownPromise) return shutdownPromise;
		shuttingDown = true;
		shutdownPromise = (async () => {
			await cancel();
			await operationsFinished;
			saveSession();
			await options.shutdown();
		})();
		return shutdownPromise;
	};

	return {
		submit,
		approve,
		reject,
		cancel,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getState: snapshot,
		shutdown,
	};
};
