import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { requestMessageContent } from "./request-message.js";
import { readWithTimeout, type StreamReadResult } from "./stream-reader.js";
import {
	DEFAULT_CONNECT_TIMEOUT_SECONDS,
	DEFAULT_FIRST_TOKEN_TIMEOUT_SECONDS,
	DEFAULT_STREAM_TIMEOUT_SECONDS,
} from "./timeouts.js";
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
	ToolSchema,
} from "./types.js";

/** Creates an OpenAI-compatible provider (works with Ollama, LM Studio, llama.cpp, LiteLLM). */
export const createProvider = (name: string, config: ProviderConfig): Provider => {
	const firstTokenTimeout =
		(config.firstTokenTimeout ?? DEFAULT_FIRST_TOKEN_TIMEOUT_SECONDS) * 1000;
	const streamTimeout = (config.streamTimeout ?? DEFAULT_STREAM_TIMEOUT_SECONDS) * 1000;
	const connectTimeout = (config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000;
	const baseUrl = config.endpoint.replace(/\/$/, "");

	const headers = (): Record<string, string> => {
		const h: Record<string, string> = { "Content-Type": "application/json" };
		if (config.apiKey) h.Authorization = `Bearer ${config.apiKey}`;
		return h;
	};

	const buildToolsPayload = (tools: ToolSchema[]) =>
		tools.map((t) => ({
			type: "function" as const,
			function: { name: t.name, description: t.description, parameters: t.parameters },
		}));

	const buildMessages = (messages: Message[]) =>
		messages.map((m) => {
			const msg: Record<string, unknown> = {
				role: m.role,
				content: requestMessageContent(m),
			};
			if (m.toolCallId) msg.tool_call_id = m.toolCallId;
			if (m.toolCalls?.length) {
				msg.tool_calls = m.toolCalls.map((tc) => ({
					id: tc.id,
					type: "function",
					function: { name: tc.name, arguments: tc.arguments },
				}));
			}
			return msg;
		});

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
			stream_options: { include_usage: true },
		};
		if (tools.length > 0) body.tools = buildToolsPayload(tools);
		if (opts.temperature != null) body.temperature = opts.temperature;
		if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;
		const connectController = new AbortController();
		const connectTimer = setTimeout(() => connectController.abort(), connectTimeout);
		const signals: AbortSignal[] = [connectController.signal];
		if (opts.signal) signals.push(opts.signal);
		const fetchSignal = AbortSignal.any(signals);

		return ResultAsync.fromPromise(
			fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: headers(),
				body: JSON.stringify(body),
				signal: fetchSignal,
			}),
			(e): ProviderError => {
				clearTimeout(connectTimer);
				return opts.signal?.aborted
					? { kind: "cancelled", message: "Request cancelled" }
					: toConnectionError(e);
			},
		).andThen((response) => {
			clearTimeout(connectTimer);
			if (!response.ok) {
				return errAsync<AsyncIterable<StreamChunk>, ProviderError>({
					kind: "api",
					status: response.status,
					message: `API returned ${response.status}`,
				});
			}
			if (!response.body) {
				return errAsync<AsyncIterable<StreamChunk>, ProviderError>({
					kind: "unknown",
					message: "Response has no body",
				});
			}
			return okAsync(parseSSEStream(response.body, firstTokenTimeout, streamTimeout, opts.signal));
		});
	};

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
		if (tools.length > 0) {
			body.tools = buildToolsPayload(tools);
			if (opts.forceTool) {
				body.tool_choice = { type: "function", function: { name: opts.forceTool } };
			}
		}
		if (opts.temperature != null) body.temperature = opts.temperature;
		if (opts.maxTokens != null) body.max_tokens = opts.maxTokens;

		return ResultAsync.fromPromise(
			fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: headers(),
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(connectTimeout + firstTokenTimeout + streamTimeout),
			}).then((r) => {
				if (!r.ok) throw { kind: "api", status: r.status, message: `API returned ${r.status}` };
				return r.json();
			}),
			(e) => toProviderError(e),
		).map((json) => parseCompletionResponse(json));
	};

	const listModels = (): ResultAsync<string[], ProviderError> =>
		ResultAsync.fromPromise(
			fetch(`${baseUrl}/models`, {
				headers: headers(),
				signal: AbortSignal.timeout(connectTimeout),
			}).then((r) => {
				if (!r.ok) throw { kind: "api", status: r.status, message: `API returned ${r.status}` };
				return r.json();
			}),
			(e) => toConnectionError(e),
		).map((json) => {
			const data = (json as { data?: { id: string }[] }).data ?? [];
			return data.map((m) => m.id);
		});

	return {
		name,
		streamChat,
		completeChat,
		supportsTools: () => true,
		listModels,
	};
};

type ThinkState = { inside: boolean; pending: string };
type SSEState = {
	finishReason?: string;
	usage?: StreamChunk["usage"];
	think: ThinkState;
};

/** Parse an SSE line into chunks, a terminal marker, or nothing. */
const parseSSELine = (line: string): StreamChunk[] | "done" | undefined => {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":")) return undefined;
	if (!trimmed.startsWith("data:")) return undefined;
	const data = trimmed.slice(5).trimStart();
	return data === "[DONE]" ? "done" : parseChunkJSON(data);
};

/** Parse SSE stream into data chunks followed by exactly one terminal chunk. */
async function* parseSSEStream(
	body: ReadableStream<Uint8Array>,
	firstTokenTimeout: number,
	streamTimeout: number,
	signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SSEState = { think: { inside: false, pending: "" } };
	let buffer = "";

	for await (const result of readWithTimeout(reader, firstTokenTimeout, streamTimeout, signal)) {
		const decoded = decodeSSERead(result, buffer, decoder);
		if (decoded.kind === "failure") {
			yield* terminalFailure(state, decoded.error);
			return;
		}
		buffer = decoded.buffer;
		const lineResult = yield* processSSELines(decoded.lines, state);
		if (lineResult === "done") {
			yield* terminalSuccess(state);
			return;
		}
		if (lineResult) {
			yield* terminalFailure(state, lineResult);
			return;
		}
		if (decoded.ended) {
			yield* terminalSuccess(state);
			return;
		}
	}

	yield* terminalFailure(state, {
		kind: "connection",
		message: "Stream ended before a terminal response",
	});
}

type DecodedSSERead =
	| { kind: "failure"; error: ProviderError }
	| { kind: "lines"; lines: string[]; buffer: string; ended: boolean };

const decodeSSERead = (
	result: StreamReadResult,
	buffer: string,
	decoder: TextDecoder,
): DecodedSSERead => {
	const failure = readFailure(result);
	if (failure) return { kind: "failure", error: failure };
	if (result.kind !== "chunk" && result.kind !== "end") {
		return {
			kind: "failure",
			error: { kind: "connection", message: "Invalid stream reader state" },
		};
	}
	const ended = result.kind === "end";
	const text = ended ? decoder.decode() : decoder.decode(result.value, { stream: true });
	const lines = (buffer + text).split("\n");
	return ended
		? { kind: "lines", lines, buffer: "", ended }
		: { kind: "lines", lines: lines.slice(0, -1), buffer: lines.at(-1) ?? "", ended };
};

const readFailure = (result: StreamReadResult): ProviderError | undefined => {
	if (result.kind === "timeout") return { kind: "timeout", message: "Stream stalled" };
	if (result.kind === "cancelled") return { kind: "cancelled", message: "Request cancelled" };
	if (result.kind === "error") {
		return { kind: "connection", message: errorText(result.cause) };
	}
	return undefined;
};

const terminalSuccess = function* (state: SSEState): Generator<StreamChunk> {
	const pending = flushThinkState(state.think);
	if (pending) yield pending;
	if (!state.finishReason) {
		yield {
			done: true,
			error: { kind: "connection", message: "Stream ended without a finish reason" },
		};
		return;
	}
	yield {
		done: true,
		finishReason: state.finishReason,
		...(state.usage ? { usage: state.usage } : {}),
	};
};

const terminalFailure = function* (state: SSEState, error: ProviderError): Generator<StreamChunk> {
	const pending = flushThinkState(state.think);
	if (pending) yield pending;
	yield { done: true, error };
};

const processSSELines = function* (
	lines: string[],
	state: SSEState,
): Generator<StreamChunk, ProviderError | "done" | undefined> {
	for (const line of lines) {
		const parsed = processSSELine(line, state);
		if (parsed === "done") return "done";
		if (!parsed) continue;
		for (const chunk of parsed) {
			if (chunk.error) return chunk.error;
			yield chunk;
		}
	}
	return undefined;
};

const processSSELine = (line: string, state: SSEState): StreamChunk[] | "done" | undefined => {
	const parsed = parseSSELine(line);
	if (parsed === "done" || !parsed) return parsed;
	return parsed.flatMap((chunk) => {
		if (chunk.error) return [chunk];
		if (chunk.finishReason) state.finishReason = chunk.finishReason;
		if (chunk.usage) state.usage = chunk.usage;
		const payload = reclassifyThinkBlock(chunk, state.think);
		return payload.content || payload.reasoning || payload.toolCall
			? [{ ...payload, done: false }]
			: [];
	});
};

const reclassifyThinkBlock = (chunk: StreamChunk, state: ThinkState): StreamChunk => {
	if (chunk.content === undefined) return chunk;
	let text = state.pending + chunk.content;
	state.pending = "";
	let content = "";
	let reasoning = chunk.reasoning ?? "";

	while (text) {
		const next = consumeThinkText(text, state, content, reasoning);
		content = next.content;
		reasoning = next.reasoning;
		if (!next.found) break;
		text = next.remaining;
	}

	const result: StreamChunk = { ...chunk };
	if (content) result.content = content;
	else delete result.content;
	if (reasoning) result.reasoning = reasoning;
	else delete result.reasoning;
	return result;
};

const consumeThinkText = (
	text: string,
	state: ThinkState,
	content: string,
	reasoning: string,
): { content: string; reasoning: string; remaining: string; found: boolean } => {
	const delimiter = state.inside ? "</think>" : "<think>";
	const index = text.indexOf(delimiter);
	if (index < 0) {
		const pendingLength = partialSuffixLength(text, delimiter);
		const completeText = text.slice(0, text.length - pendingLength);
		state.pending = text.slice(text.length - pendingLength);
		return {
			content: state.inside ? content : content + completeText,
			reasoning: state.inside ? reasoning + completeText : reasoning,
			remaining: "",
			found: false,
		};
	}

	const before = text.slice(0, index);
	state.inside = !state.inside;
	return {
		content: state.inside ? content + before : content,
		reasoning: state.inside ? reasoning : reasoning + before,
		remaining: text.slice(index + delimiter.length),
		found: true,
	};
};

const partialSuffixLength = (text: string, delimiter: string): number => {
	const maxLength = Math.min(text.length, delimiter.length - 1);
	for (let length = maxLength; length > 0; length--) {
		if (text.endsWith(delimiter.slice(0, length))) return length;
	}
	return 0;
};

const flushThinkState = (state: ThinkState): StreamChunk | undefined => {
	if (!state.pending) return undefined;
	const content = state.inside ? undefined : state.pending;
	const reasoning = state.inside ? state.pending : undefined;
	state.pending = "";
	return {
		done: false,
		...(content ? { content } : {}),
		...(reasoning ? { reasoning } : {}),
	};
};

const parseToolCallDeltas = (
	delta: Record<string, unknown>,
): NonNullable<StreamChunk["toolCall"]>[] => {
	const calls = delta.tool_calls as Record<string, unknown>[] | undefined;
	return (calls ?? []).map((call) => {
		const fn = (call.function ?? {}) as Record<string, unknown>;
		const toolCall: NonNullable<StreamChunk["toolCall"]> = {
			index: (call.index as number) ?? 0,
			argumentsFragment: (fn.arguments as string) ?? "",
		};
		if (typeof call.id === "string") toolCall.id = call.id;
		if (typeof fn.name === "string") toolCall.name = fn.name;
		return toolCall;
	});
};

const parseUsage = (data: Record<string, unknown>): StreamChunk["usage"] => {
	const usage = data.usage as { prompt_tokens?: number; total_tokens?: number } | undefined;
	return usage
		? { promptTokens: usage.prompt_tokens ?? 0, totalTokens: usage.total_tokens ?? 0 }
		: undefined;
};

const parseChunkJSON = (json: string): StreamChunk[] => {
	try {
		const data = JSON.parse(json) as Record<string, unknown>;
		const error = parseStreamError(data);
		if (error) return [{ done: true, error }];
		const choice = (data.choices as Record<string, unknown>[] | undefined)?.[0];
		return choice ? parseChoiceChunks(choice, data) : parseUsageChunk(data);
	} catch (error) {
		return [{ done: true, error: parseFailure(error, json) }];
	}
};

const parseStreamError = (data: Record<string, unknown>): ProviderError | undefined => {
	if (data.error === undefined) return undefined;
	const error = data.error;
	const message =
		typeof error === "string"
			? error
			: typeof error === "object" && error !== null && "message" in error
				? String(error.message)
				: "Provider returned a stream error";
	const status =
		typeof data.status === "number"
			? data.status
			: typeof error === "object" && error !== null && "status" in error
				? Number(error.status)
				: 500;
	return { kind: "api", status, message };
};

const parseChoiceChunks = (
	choice: Record<string, unknown>,
	data: Record<string, unknown>,
): StreamChunk[] => {
	const delta = (choice.delta ?? {}) as Record<string, unknown>;
	const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
	const base: StreamChunk = { done: false };
	if (finishReason) base.finishReason = finishReason;
	if (typeof delta.content === "string") base.content = delta.content;
	const reasoning = delta.reasoning_content ?? delta.reasoning;
	if (typeof reasoning === "string") base.reasoning = reasoning;
	const usage = parseUsage(data);
	if (usage) base.usage = usage;
	const toolCalls = parseToolCallDeltas(delta);
	if (toolCalls.length === 0) return [base];
	return toolCalls.map((toolCall, index) =>
		index === 0 ? { ...base, toolCall } : { done: false, toolCall },
	);
};

const parseUsageChunk = (data: Record<string, unknown>): StreamChunk[] => {
	const usage = parseUsage(data);
	return usage ? [{ done: false, usage }] : [];
};

const parseFailure = (error: unknown, json: string): ProviderError => ({
	kind: "parse",
	message: `Invalid OpenAI-compatible stream data: ${errorText(error)}`,
	raw: json,
});

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const parseCompletionResponse = (json: unknown): CompletionResult => {
	const data = json as Record<string, unknown>;
	const choices = (data.choices as Record<string, unknown>[]) ?? [];
	const choice = choices[0] ?? {};
	const message = (choice.message as Record<string, unknown>) ?? {};
	const toolCalls: ToolCall[] = [];

	const rawCalls = message.tool_calls as Record<string, unknown>[] | undefined;
	if (rawCalls) {
		for (const tc of rawCalls) {
			const fn = tc.function as Record<string, unknown>;
			toolCalls.push({
				id: (tc.id as string) ?? "",
				name: (fn?.name as string) ?? "",
				arguments: (fn?.arguments as string) ?? "",
			});
		}
	}

	const usage = data.usage as Record<string, number> | undefined;
	const result: CompletionResult = { content: (message.content as string) ?? "", toolCalls };
	if (usage) {
		result.usage = { promptTokens: usage.prompt_tokens ?? 0, totalTokens: usage.total_tokens ?? 0 };
	}
	return result;
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
