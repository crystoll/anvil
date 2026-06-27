import type {
	Message,
	Provider,
	ProviderError,
	StreamChunk,
	StreamOptions,
	ToolSchema,
} from "../provider/types.js";

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
	addUser: (content: string) => void;
	addToolResult: (toolCallId: string, content: string) => void;
	loadMessages: (msgs: Message[]) => void;
	stream: (tools: ToolSchema[], opts?: StreamOptions) => AsyncIterable<EngineEvent>;
	cancel: () => void;
	reset: () => void;
	/** Trim oldest messages to stay within a token budget. Returns number of messages removed. */
	trimToFit: (maxTokens: number) => number;
};

type ToolCallAccum = { id: string; name: string; args: string };

type Accumulator = {
	content: string;
	reasoning: string;
	toolCalls: Map<number, ToolCallAccum>;
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

const finalizeMessage = (acc: Accumulator): Message => {
	const message: Message = { role: "assistant", content: acc.content };
	if (acc.reasoning) message.reasoning = acc.reasoning;
	if (acc.toolCalls.size > 0) {
		message.toolCalls = [...acc.toolCalls.values()].map((tc) => ({
			id: tc.id,
			name: tc.name,
			arguments: tc.args,
		}));
	}
	return message;
};

/** Create a chat engine bound to a specific provider and model. */
export const createEngine = (initialProvider: Provider, initialModel: string): Engine => {
	const history: Message[] = [];
	let currentState: EngineState = "idle";
	let abortController: AbortController | null = null;
	let model = initialModel;
	let provider = initialProvider;

	const setSystem = (content: string) => {
		const idx = history.findIndex((m) => m.role === "system");
		if (idx >= 0) {
			history[idx] = { role: "system", content };
		} else {
			history.unshift({ role: "system", content });
		}
	};

	const addUser = (content: string) => {
		history.push({ role: "user", content });
	};

	const addToolResult = (toolCallId: string, content: string) => {
		history.push({ role: "tool", content, toolCallId });
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

	const loadMessages = (msgs: Message[]) => {
		history.length = 0;
		history.push(...msgs);
	};

	async function* stream(
		tools: ToolSchema[],
		opts: StreamOptions = {},
	): AsyncIterable<EngineEvent> {
		if (currentState === "streaming") {
			yield { kind: "error", error: { kind: "unknown", message: "Already streaming" } };
			return;
		}

		currentState = "streaming";
		abortController = new AbortController();

		const result = await provider.streamChat(model, [...history], tools, opts);

		if (result.isErr()) {
			currentState = "idle";
			yield { kind: "error", error: result.error };
			return;
		}

		const accumulator = createAccumulator();

		for await (const chunk of result.value) {
			if (abortController.signal.aborted) {
				currentState = "idle";
				yield { kind: "cancelled" };
				return;
			}

			if (chunk.error) {
				currentState = "idle";
				yield { kind: "error", error: chunk.error };
				return;
			}

			accumulateChunk(accumulator, chunk);
			yield { kind: "chunk", chunk };
		}

		const message = finalizeMessage(accumulator);
		history.push(message);
		currentState = "idle";
		abortController = null;
		yield { kind: "done", message };
	}

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
	};
};

/** Remove oldest messages (preserving system) until under budget. Keeps tool pairs atomic. */
const trimMessages = (history: Message[], maxTokens: number): number => {
	const total = () => history.reduce((a, m) => a + estimateMessageTokens(m), 0);
	if (total() <= maxTokens) return 0;

	let removed = 0;
	while (history.length > 2 && total() > maxTokens) {
		const msg = history[1];
		if (!msg) break;
		if (hasToolCalls(msg)) {
			removed += removeToolGroup(history);
		} else {
			history.splice(1, 1);
			removed++;
		}
	}
	return removed;
};

const hasToolCalls = (m: Message): boolean =>
	m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0;

const removeToolGroup = (history: Message[]): number => {
	const msg = history[1];
	if (!msg) return 0;
	const ids = new Set((msg.toolCalls ?? []).map((tc) => tc.id));
	history.splice(1, 1);
	let count = 1;
	while (
		history.length > 1 &&
		history[1]?.role === "tool" &&
		ids.has(history[1].toolCallId ?? "")
	) {
		history.splice(1, 1);
		count++;
	}
	return count;
};

/** Rough token estimate for a message (~4 chars per token). */
const estimateMessageTokens = (m: Message): number =>
	Math.round((m.content.length + (m.reasoning?.length ?? 0)) / 4) + 4;
