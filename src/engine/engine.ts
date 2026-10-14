import type {
	Message,
	Provider,
	ProviderError,
	StreamChunk,
	StreamOptions,
	ToolSchema,
} from "../provider/types.js";
import { prepareHistoryForRequest } from "./history.js";

export type EngineOptions = {
	debug?: boolean;
};

/** Engine state during a conversation turn. */
export type EngineState = "idle" | "streaming" | "cancelled";

/** Event emitted by the engine during streaming. */
export type EngineEvent =
	| { kind: "chunk"; chunk: StreamChunk }
	| { kind: "done"; message: Message }
	| { kind: "error"; error: ProviderError }
	| { kind: "cancelled" };

/** Chat engine — manages message history and delegates streaming to a provider. */
export type Engine = {
	messages: () => readonly Message[];
	model: () => string;
	state: () => EngineState;
	setSystem: (content: string) => void;
	setModel: (m: string) => void;
	setProvider: (p: Provider) => void;
	addUser: (content: string, options?: { synthetic?: boolean }) => void;
	addToolResult: (toolCallId: string, content: string) => void;
	loadMessages: (msgs: Message[]) => void;
	stream: (
		tools: ToolSchema[],
		opts?: StreamOptions,
		requestMessages?: readonly Message[],
	) => AsyncIterable<EngineEvent>;
	cancel: () => void;
	reset: () => void;
	/** Trim oldest messages to stay within a token budget. Returns number of messages removed. */
	trimToFit: (maxTokens: number) => number;
	/** Rewrite last message content as a tool call (for proxy recovery). */
	rewriteLastAsToolCall: (call: { id: string; name: string; arguments: string }) => boolean;
	/**
	 * Hears each message as it joins the conversation, so it can be saved right away.
	 * Partial answers are committed with a status when streaming fails or is interrupted.
	 */
	onCommit: (listener: (message: Message) => void) => () => void;
};

type ToolCallAccum = { id: string; name: string; args: string };

type Accumulator = {
	content: string;
	reasoning: string;
	toolCalls: Map<number, ToolCallAccum>;
};

/** Process a single stream chunk. Returns a terminal event if streaming should stop, undefined to continue. */
const processChunk = (
	chunk: StreamChunk,
	signal: AbortSignal,
	accumulator: Accumulator,
): Extract<EngineEvent, { kind: "cancelled" | "error" }> | undefined => {
	if (signal.aborted) return { kind: "cancelled" };
	if (chunk.error?.kind === "cancelled") return { kind: "cancelled" };
	if (chunk.error) return { kind: "error", error: chunk.error };
	accumulateChunk(accumulator, chunk);
	return undefined;
};

const waitForAbort = (signal: AbortSignal): { promise: Promise<void>; dispose: () => void } => {
	let onAbort: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		onAbort = resolve;
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	return {
		promise,
		dispose: () => signal.removeEventListener("abort", onAbort),
	};
};

type StreamOutcome =
	| { kind: "success" }
	| { kind: "cancelled" }
	| { kind: "error"; error: ProviderError };

const requestStream = (
	provider: Provider,
	model: string,
	messages: Message[],
	tools: ToolSchema[],
	opts: StreamOptions,
	signal: AbortSignal,
	abortPromise: Promise<void>,
) =>
	Promise.race([
		Promise.resolve(provider.streamChat(model, messages, tools, { ...opts, signal })).then(
			(result) => ({ kind: "result" as const, result }),
		),
		abortPromise.then(() => ({ kind: "cancelled" as const })),
	]);

const consumeProviderStream = async function* (
	stream: AsyncIterable<StreamChunk>,
	signal: AbortSignal,
	abortPromise: Promise<void>,
	accumulator: Accumulator,
	onTerminal: (outcome: Exclude<StreamOutcome, { kind: "success" }>) => void,
): AsyncGenerator<EngineEvent, StreamOutcome> {
	const iterator = stream[Symbol.asyncIterator]();
	let completed = false;
	try {
		while (true) {
			const next = await Promise.race([
				iterator.next().then((value) => ({ kind: "next" as const, value })),
				abortPromise.then(() => ({ kind: "cancelled" as const })),
			]);
			if (next.kind === "cancelled") {
				const outcome = { kind: "cancelled" } as const;
				onTerminal(outcome);
				yield { kind: "cancelled" };
				return outcome;
			}
			if (next.value.done) {
				completed = true;
				return { kind: "success" };
			}

			const chunk = next.value.value;
			const terminal = processChunk(chunk, signal, accumulator);
			if (terminal) {
				const outcome =
					terminal.kind === "cancelled"
						? ({ kind: "cancelled" } as const)
						: ({ kind: "error", error: terminal.error } as const);
				onTerminal(outcome);
				yield terminal;
				return outcome;
			}
			yield { kind: "chunk", chunk };
		}
	} finally {
		if (!completed) await iterator.return?.();
	}
};

const runProviderStream = async function* (
	provider: Provider,
	model: string,
	messages: Message[],
	tools: ToolSchema[],
	opts: StreamOptions,
	signal: AbortSignal,
	abortPromise: Promise<void>,
	accumulator: Accumulator,
	onTerminal: (outcome: Exclude<StreamOutcome, { kind: "success" }>) => void,
): AsyncGenerator<EngineEvent, StreamOutcome> {
	const request = await requestStream(provider, model, messages, tools, opts, signal, abortPromise);
	if (request.kind === "cancelled") {
		const outcome = { kind: "cancelled" } as const;
		onTerminal(outcome);
		yield { kind: "cancelled" };
		return outcome;
	}
	if (request.result.isErr()) {
		const cancelled = signal.aborted || request.result.error.kind === "cancelled";
		const outcome: Exclude<StreamOutcome, { kind: "success" }> = cancelled
			? { kind: "cancelled" }
			: { kind: "error", error: request.result.error };
		onTerminal(outcome);
		yield cancelled ? { kind: "cancelled" } : { kind: "error", error: request.result.error };
		return outcome;
	}
	return yield* consumeProviderStream(
		request.result.value,
		signal,
		abortPromise,
		accumulator,
		onTerminal,
	);
};

const createAccumulator = (): Accumulator => ({
	content: "",
	reasoning: "",
	toolCalls: new Map(),
});

const accumulateChunk = (acc: Accumulator, chunk: StreamChunk): void => {
	if (chunk.content) acc.content += chunk.content;
	if (chunk.reasoning) acc.reasoning += chunk.reasoning;
	if (chunk.toolCall) accumulateToolCall(acc.toolCalls, chunk.toolCall);
};

const accumulateToolCall = (
	map: Map<number, ToolCallAccum>,
	tc: NonNullable<StreamChunk["toolCall"]>,
): void => {
	const existing = map.get(tc.index);
	if (existing) {
		existing.args += tc.argumentsFragment;
	} else {
		map.set(tc.index, { id: tc.id ?? "", name: tc.name ?? "", args: tc.argumentsFragment });
	}
};

const finalizeMessage = (acc: Accumulator, status?: Message["status"]): Message => {
	const message: Message = { role: "assistant", content: acc.content };
	if (status) message.status = status;
	if (acc.reasoning) message.reasoning = acc.reasoning;
	if (!status && acc.toolCalls.size > 0) {
		message.toolCalls = [...acc.toolCalls.values()].map((tc) => ({
			id: tc.id,
			name: tc.name,
			arguments: tc.args,
		}));
	}
	return message;
};

const hasPartialResponse = (acc: Accumulator): boolean => Boolean(acc.content || acc.reasoning);

const createStreamSignal = (controller: AbortController, external?: AbortSignal): AbortSignal =>
	external ? AbortSignal.any([controller.signal, external]) : controller.signal;

const streamException = (
	error: unknown,
	cancelled: boolean,
): Exclude<StreamOutcome, { kind: "success" }> =>
	cancelled
		? { kind: "cancelled" }
		: {
				kind: "error",
				error: {
					kind: "connection",
					message: `Stream interrupted: ${error instanceof Error ? error.message : String(error)}`,
				},
			};

/** Create a chat engine bound to a specific provider and model. */
export const createEngine = (
	initialProvider: Provider,
	initialModel: string,
	options: EngineOptions = {},
): Engine => {
	const history: Message[] = [];
	let currentState: EngineState = "idle";
	let abortController: AbortController | null = null;
	let model = initialModel;
	let provider = initialProvider;
	const commitListeners = new Set<(message: Message) => void>();

	const commit = (message: Message) => {
		history.push(message);
		for (const listener of commitListeners) listener(message);
	};

	const setSystem = (content: string) => {
		const idx = history.findIndex((m) => m.role === "system");
		if (idx >= 0) {
			history[idx] = { role: "system", content };
		} else {
			history.unshift({ role: "system", content });
		}
	};

	const addUser = (content: string, options?: { synthetic?: boolean }) => {
		const message: Message = { role: "user", content };
		if (options?.synthetic) message.synthetic = true;
		commit(message);
	};

	const addToolResult = (toolCallId: string, content: string) => {
		commit({ role: "tool", content, toolCallId });
	};

	const cancel = () => {
		if (currentState === "streaming" && abortController) {
			abortController.abort();
			currentState = "cancelled";
		}
	};

	const reset = () => {
		history.length = 0;
		currentState = "idle";
		abortController = null;
	};

	const repairBeforeRequest = () => {
		history.splice(0, history.length, ...prepareHistoryForRequest(history, options.debug));
	};

	const loadMessages = (msgs: Message[]) => {
		history.length = 0;
		history.push(...msgs);
	};

	async function* stream(
		tools: ToolSchema[],
		opts: StreamOptions = {},
		requestMessages: readonly Message[] = [],
	): AsyncIterable<EngineEvent> {
		if (currentState !== "idle") {
			yield { kind: "error", error: { kind: "unknown", message: "Already streaming" } };
			return;
		}

		currentState = "streaming";
		const controller = new AbortController();
		abortController = controller;
		const signal = createStreamSignal(controller, opts.signal);
		const abortWait = waitForAbort(signal);
		const accumulator = createAccumulator();
		let outcome: StreamOutcome | undefined;
		const markTerminal = (terminal: Exclude<StreamOutcome, { kind: "success" }>) => {
			outcome = terminal;
			commitPartial(accumulator, statusForOutcome(terminal));
		};

		try {
			repairBeforeRequest();
			outcome = yield* runProviderStream(
				provider,
				model,
				[...history, ...requestMessages],
				tools,
				opts,
				signal,
				abortWait.promise,
				accumulator,
				markTerminal,
			);
			if (outcome.kind === "success") {
				const message = finalizeMessage(accumulator);
				commit(message);
				yield { kind: "done", message };
			}
		} catch (error) {
			const terminal = streamException(error, signal.aborted);
			markTerminal(terminal);
			yield terminal.kind === "cancelled"
				? { kind: "cancelled" }
				: { kind: "error", error: terminal.error };
		} finally {
			abortWait.dispose();
			if (!outcome) commitPartial(accumulator, "interrupted");
			controller.abort();
			currentState = "idle";
			abortController = null;
		}
	}

	const statusForOutcome = (
		terminal: Exclude<StreamOutcome, { kind: "success" }>,
	): Message["status"] => (terminal.kind === "cancelled" ? "interrupted" : "error");

	const commitPartial = (accumulator: Accumulator, status: Message["status"]): void => {
		if (hasPartialResponse(accumulator)) commit(finalizeMessage(accumulator, status));
	};

	return {
		messages: () => history,
		model: () => model,
		state: () => currentState,
		setSystem,
		setModel: (m: string) => {
			model = m;
		},
		setProvider: (p: Provider) => {
			provider = p;
		},
		addUser,
		addToolResult,
		loadMessages,
		stream,
		cancel,
		reset,
		trimToFit: (maxTokens: number) => trimMessages(history, maxTokens),
		rewriteLastAsToolCall: (call) => {
			const last = history[history.length - 1];
			if (!last || last.toolCalls?.length || !last.content) return false;
			last.toolCalls = [call];
			last.content = "";
			return true;
		},
		onCommit: (listener) => {
			commitListeners.add(listener);
			return () => {
				commitListeners.delete(listener);
			};
		},
	};
};

/** Remove oldest messages (preserving system) until under budget. Keeps tool pairs atomic. */
const trimMessages = (history: Message[], maxTokens: number): number => {
	let currentTotal = history.reduce((a, m) => a + estimateMessageTokens(m), 0);
	if (currentTotal <= maxTokens) return 0;

	let removed = 0;
	while (history.length > 2 && currentTotal > maxTokens) {
		const msg = history[1];
		if (!msg) break;
		if (hasToolCalls(msg)) {
			const { count, tokens } = removeToolGroup(history);
			currentTotal -= tokens;
			removed += count;
		} else {
			currentTotal -= estimateMessageTokens(msg);
			history.splice(1, 1);
			removed++;
		}
	}
	return removed;
};

const hasToolCalls = (m: Message): boolean =>
	m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0;

const removeToolGroup = (history: Message[]): { count: number; tokens: number } => {
	const msg = history[1];
	if (!msg) return { count: 0, tokens: 0 };
	const ids = new Set((msg.toolCalls ?? []).map((tc) => tc.id));
	let tokens = estimateMessageTokens(msg);
	history.splice(1, 1);
	let count = 1;
	while (
		history.length > 1 &&
		history[1]?.role === "tool" &&
		ids.has(history[1].toolCallId ?? "")
	) {
		tokens += estimateMessageTokens(history[1]);
		history.splice(1, 1);
		count++;
	}
	return { count, tokens };
};

/** Rough token estimate for a message (~4 chars per token). */
const estimateMessageTokens = (m: Message): number => {
	const toolArgs = (m.toolCalls ?? []).reduce((a, tc) => a + tc.arguments.length, 0);
	return Math.round((m.content.length + (m.reasoning?.length ?? 0) + toolArgs) / 4) + 4;
};
