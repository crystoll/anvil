import { errAsync, okAsync, ResultAsync } from "neverthrow";
import type {
	CompleteOptions,
	CompletionResult,
	Message,
	Provider,
	ProviderConfig,
	ProviderError,
	StreamChunk,
	StreamOptions,
	ToolCall,
	ToolCallDelta,
	ToolSchema,
} from "./types.js";

/** Creates a native Ollama provider using /api/chat with options.num_ctx support. */
export const createOllamaProvider = (name: string, config: ProviderConfig): Provider => {
	const streamTimeout = (config.streamTimeout ?? 30) * 1000;
	const connectTimeout = (config.connectTimeout ?? 3) * 1000;
	const baseUrl = config.endpoint.replace(/\/$/, "");

	const buildMessages = (messages: Message[]) =>
		messages.map((m, i) => {
			const msg: Record<string, unknown> = { role: m.role, content: m.content };

			if (m.role === "assistant") {
				if (m.reasoning) msg.thinking = m.reasoning;
				if (m.toolCalls?.length) {
					msg.tool_calls = m.toolCalls.map((tc, idx) => ({
						type: "function",
						function: { index: idx, name: tc.name, arguments: JSON.parse(tc.arguments) },
					}));
				}
			}

			if (m.role === "tool" && m.toolCallId) {
				msg.tool_name = resolveToolName(messages, i, m.toolCallId);
			}

			return msg;
		});

	/** Resolve tool name from the preceding assistant message's tool_calls by matching ID. */
	const resolveToolName = (messages: Message[], toolIdx: number, toolCallId: string): string => {
		for (let i = toolIdx - 1; i >= 0; i--) {
			const tc = messages[i]?.toolCalls?.find((c) => c.id === toolCallId);
			if (tc) return tc.name;
		}
		return "unknown";
	};

	const buildTools = (tools: ToolSchema[]) =>
		tools.map((t) => ({
			type: "function" as const,
			function: { name: t.name, description: t.description, parameters: t.parameters },
		}));

	const parseToolCalls = (msg: Record<string, unknown>): ToolCallDelta[] => {
		const calls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
		if (!calls?.length) return [];
		return calls.map((tc, idx) => {
			const fn = tc.function as Record<string, unknown>;
			return {
				index: idx,
				id: (tc.id as string) ?? "",
				name: (fn.name as string) ?? "",
				argumentsFragment: JSON.stringify(fn.arguments),
			};
		});
	};

	const parseUsage = (data: Record<string, unknown>): StreamChunk["usage"] => {
		if (data.prompt_eval_count == null && data.eval_count == null) return undefined;
		const prompt = (data.prompt_eval_count as number) ?? 0;
		const eval_ = (data.eval_count as number) ?? 0;
		return { promptTokens: prompt, totalTokens: prompt + eval_ };
	};

	const buildChunks = (data: Record<string, unknown>): StreamChunk[] => {
		const msg = (data.message ?? {}) as Record<string, unknown>;
		const base: StreamChunk = { done: data.done === true };
		if (msg.content) base.content = msg.content as string;
		if (msg.thinking) base.reasoning = msg.thinking as string;
		if (data.done_reason) base.finishReason = data.done_reason as string;
		if (data.done) {
			const usage = parseUsage(data);
			if (usage) base.usage = usage;
		}
		const toolCalls = parseToolCalls(msg);
		if (toolCalls.length === 0) return [base];
		return toolCalls.map((tc, i) =>
			i === 0 ? { ...base, toolCall: tc } : { done: false, toolCall: tc },
		);
	};

	const parseChunks = (line: string): StreamChunk[] => {
		if (!line.trim()) return [];
		try {
			return buildChunks(JSON.parse(line));
		} catch {
			return [];
		}
	};

	const streamChat = (
		model: string,
		messages: Message[],
		tools: ToolSchema[],
		opts: StreamOptions,
	): ResultAsync<AsyncIterable<StreamChunk>, ProviderError> => {
		const body: Record<string, unknown> = {
			model,
			messages: buildMessages(messages),
			stream: true,
		};
		if (tools.length > 0) body.tools = buildTools(tools);
		if (opts.contextSize != null) body.options = { num_ctx: opts.contextSize };
		if (opts.temperature != null) body.temperature = opts.temperature;

		const signals: AbortSignal[] = [];
		const connectController = new AbortController();
		const connectTimer = setTimeout(() => connectController.abort(), connectTimeout);
		signals.push(connectController.signal);
		if (opts.signal) signals.push(opts.signal);

		return ResultAsync.fromPromise(
			fetch(`${baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.any(signals),
			}),
			(e) => toConnectionError(e),
		).andThen((response) => {
			clearTimeout(connectTimer);
			if (!response.ok) {
				return errAsync<AsyncIterable<StreamChunk>, ProviderError>({
					kind: "api",
					status: response.status,
					message: `Ollama API returned ${response.status}`,
				});
			}
			if (!response.body) {
				return errAsync<AsyncIterable<StreamChunk>, ProviderError>({
					kind: "unknown",
					message: "Response has no body",
				});
			}
			return okAsync(parseNDJSONStream(response.body, streamTimeout));
		});
	};

	const parseLines = function* (
		lines: string[],
		counter: { value: number },
	): Generator<StreamChunk> {
		for (const line of lines) {
			for (const chunk of parseChunks(line)) {
				if (chunk.toolCall) {
					chunk.toolCall = { ...chunk.toolCall, index: counter.value++ };
				}
				yield chunk;
			}
		}
	};

	async function* parseNDJSONStream(
		body: ReadableStream<Uint8Array>,
		timeout: number,
	): AsyncIterable<StreamChunk> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const toolCallCounter = { value: 0 };
		let timer: ReturnType<typeof setTimeout> | undefined;
		const clearTimer = () => {
			if (timer) clearTimeout(timer);
		};
		const resetTimer = () => {
			clearTimer();
			timer = setTimeout(() => reader.cancel(), timeout);
		};

		resetTimer();
		try {
			for await (const value of readStream(reader)) {
				resetTimer();
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				yield* parseLines(lines, toolCallCounter);
			}
			if (buffer.trim()) yield* parseLines([buffer], toolCallCounter);
		} finally {
			clearTimer();
			reader.releaseLock();
		}
	}

	async function* readStream(
		reader: ReadableStreamDefaultReader<Uint8Array>,
	): AsyncGenerator<Uint8Array> {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	}

	const completeChat = (
		model: string,
		messages: Message[],
		tools: ToolSchema[],
		opts: CompleteOptions,
	): ResultAsync<CompletionResult, ProviderError> => {
		const body: Record<string, unknown> = {
			model,
			messages: buildMessages(messages),
			stream: false,
		};
		if (tools.length > 0) body.tools = buildTools(tools);
		if (opts.temperature != null) body.temperature = opts.temperature;

		return ResultAsync.fromPromise(
			fetch(`${baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(connectTimeout + streamTimeout),
			}).then((r) => {
				if (!r.ok)
					throw { kind: "api", status: r.status, message: `Ollama API returned ${r.status}` };
				return r.json();
			}),
			(e) => toProviderError(e),
		).map(parseResponseBody);
	};

	const parseResponseBody = (json: unknown): CompletionResult => {
		const data = json as Record<string, unknown>;
		const msg = (data.message as Record<string, unknown>) ?? {};
		const toolCalls: ToolCall[] = [];
		const rawCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
		if (rawCalls) {
			for (const tc of rawCalls) {
				const fn = tc.function as Record<string, unknown>;
				toolCalls.push({
					id: (tc.id as string) ?? "",
					name: (fn?.name as string) ?? "",
					arguments: JSON.stringify(fn?.arguments ?? {}),
				});
			}
		}
		const result: CompletionResult = { content: (msg.content as string) ?? "", toolCalls };
		const usage = parseUsage(data);
		if (usage) result.usage = usage;
		return result;
	};

	const listModels = (): ResultAsync<string[], ProviderError> =>
		ResultAsync.fromPromise(
			fetch(`${baseUrl}/api/tags`, {
				signal: AbortSignal.timeout(connectTimeout),
			}).then((r) => {
				if (!r.ok)
					throw { kind: "api", status: r.status, message: `Ollama API returned ${r.status}` };
				return r.json();
			}),
			(e) => toConnectionError(e),
		).map((json) => {
			const models = (json as { models?: { name: string }[] }).models ?? [];
			return models.map((m) => m.name);
		});

	return { name, streamChat, completeChat, supportsTools: () => true, listModels };
};

const toConnectionError = (e: unknown): ProviderError => {
	if (e instanceof Error && e.name === "TimeoutError") {
		return { kind: "timeout", message: "Request timed out" };
	}
	if (e instanceof DOMException && e.name === "AbortError") {
		return { kind: "timeout", message: "Connection timed out (model may be loading)" };
	}
	return { kind: "connection", message: e instanceof Error ? e.message : String(e) };
};

const toProviderError = (e: unknown): ProviderError => {
	if (typeof e === "object" && e !== null && "kind" in e) return e as ProviderError;
	return toConnectionError(e);
};
