import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import { isPlainObject } from "remeda";
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
	ToolCallDelta,
	ToolSchema,
} from "./types.js";

const parseJson = Result.fromThrowable(
	(raw: string): unknown => JSON.parse(raw),
	() => "invalid JSON",
);

/** Stored arguments are raw model output; one malformed call must not break every later request. */
const parseStoredArguments = (raw: string): Result<Record<string, unknown>, string> =>
	parseJson(raw).andThen((value) =>
		isPlainObject(value) ? ok(value) : err("tool arguments are not a JSON object"),
	);

/** Creates a native Ollama provider using /api/chat with options.num_ctx support. */
export const createOllamaProvider = (name: string, config: ProviderConfig): Provider => {
	const firstTokenTimeout =
		(config.firstTokenTimeout ?? DEFAULT_FIRST_TOKEN_TIMEOUT_SECONDS) * 1000;
	const streamTimeout = (config.streamTimeout ?? DEFAULT_STREAM_TIMEOUT_SECONDS) * 1000;
	const connectTimeout = (config.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000;
	const baseUrl = config.endpoint.replace(/\/$/, "");

	const buildMessages = (messages: Message[]) =>
		messages.map((m, i) => {
			const msg: Record<string, unknown> = {
				role: m.role,
				content: requestMessageContent(m),
			};

			if (m.role === "assistant") {
				if (m.reasoning) msg.thinking = m.reasoning;
				if (m.toolCalls?.length) {
					msg.tool_calls = m.toolCalls.map((tc, idx) => ({
						type: "function",
						function: {
							index: idx,
							name: tc.name,
							arguments: parseStoredArguments(tc.arguments).unwrapOr({}),
						},
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

	const buildRequestOptions = (opts: {
		contextSize?: number;
		temperature?: number;
		maxTokens?: number;
	}): Record<string, number> => {
		const options: Record<string, number> = {};
		if (opts.contextSize != null) options.num_ctx = opts.contextSize;
		if (opts.temperature != null) options.temperature = opts.temperature;
		if (opts.maxTokens != null) options.num_predict = opts.maxTokens;
		return options;
	};

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
		const usage: NonNullable<StreamChunk["usage"]> = {
			promptTokens: prompt,
			totalTokens: prompt + eval_,
		};
		const evalDuration = data.eval_duration;
		if (
			typeof evalDuration === "number" &&
			Number.isFinite(evalDuration) &&
			evalDuration > 0 &&
			typeof eval_ === "number" &&
			Number.isFinite(eval_) &&
			eval_ > 0
		) {
			const tokensPerSecond = (eval_ / evalDuration) * 1_000_000_000;
			if (Number.isFinite(tokensPerSecond)) usage.tokensPerSecond = tokensPerSecond;
		}
		return usage;
	};

	const buildChunks = (data: Record<string, unknown>): StreamChunk[] => {
		if (typeof data.error === "string")
			return [{ done: true, error: { kind: "api", status: 500, message: data.error } }];
		const base = buildBaseChunk(data);
		const toolCalls = parseToolCalls((data.message ?? {}) as Record<string, unknown>);
		if (toolCalls.length === 0) return [base];
		const toolChunks = toolCalls.map((toolCall, index) =>
			index === 0 ? { ...base, done: false, toolCall } : { done: false, toolCall },
		);
		if (!base.done) return toolChunks;
		const terminal: StreamChunk = { done: true };
		if (base.finishReason) terminal.finishReason = base.finishReason;
		return [...toolChunks, terminal];
	};

	const buildBaseChunk = (data: Record<string, unknown>): StreamChunk => {
		const msg = (data.message ?? {}) as Record<string, unknown>;
		const base: StreamChunk = { done: data.done === true };
		if (msg.content) base.content = msg.content as string;
		if (msg.thinking) base.reasoning = msg.thinking as string;
		if (data.done_reason) base.finishReason = data.done_reason as string;
		if (base.done && !base.finishReason) base.finishReason = "stop";
		if (data.done) {
			const usage = parseUsage(data);
			if (usage) base.usage = usage;
		}
		return base;
	};

	const parseChunks = (line: string): StreamChunk[] => {
		if (!line.trim()) return [];
		try {
			const data = JSON.parse(line);
			if (typeof data !== "object" || data === null) throw new Error("Expected an object");
			return buildChunks(data as Record<string, unknown>);
		} catch (error) {
			return [
				{
					done: true,
					error: {
						kind: "parse",
						message: `Invalid Ollama stream data: ${error instanceof Error ? error.message : String(error)}`,
						raw: line,
					},
				},
			];
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
			keep_alive: config.keepAlive ?? "30m",
		};
		if (tools.length > 0) body.tools = buildTools(tools);
		const options = buildRequestOptions(opts);
		if (Object.keys(options).length > 0) body.options = options;

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
					message: `Ollama API returned ${response.status}`,
				});
			}
			if (!response.body) {
				return errAsync<AsyncIterable<StreamChunk>, ProviderError>({
					kind: "unknown",
					message: "Response has no body",
				});
			}
			return okAsync(
				parseNDJSONStream(response.body, firstTokenTimeout, streamTimeout, opts.signal),
			);
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

	const emitLines = async function* (
		lines: string[],
		counter: { value: number },
	): AsyncGenerator<StreamChunk, boolean> {
		for (const chunk of parseLines(lines, counter)) {
			yield chunk;
			if (chunk.done) return true;
		}
		return false;
	};

	const readFailure = (result: StreamReadResult): ProviderError | undefined => {
		if (result.kind === "timeout") return { kind: "timeout", message: "Ollama stream stalled" };
		if (result.kind === "cancelled") return { kind: "cancelled", message: "Request cancelled" };
		if (result.kind === "error") return { kind: "connection", message: errorText(result.cause) };
		return undefined;
	};

	type DecodedNDJSONRead =
		| { kind: "failure"; error: ProviderError }
		| { kind: "lines"; lines: string[]; buffer: string; ended: boolean };

	const decodeNDJSONRead = (
		result: StreamReadResult,
		buffer: string,
		decoder: TextDecoder,
	): DecodedNDJSONRead => {
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

	async function* parseNDJSONStream(
		body: ReadableStream<Uint8Array>,
		firstTokenTimeout: number,
		streamTimeout: number,
		signal?: AbortSignal,
	): AsyncIterable<StreamChunk> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const toolCallCounter = { value: 0 };
		for await (const result of readWithTimeout(reader, firstTokenTimeout, streamTimeout, signal)) {
			const decoded = decodeNDJSONRead(result, buffer, decoder);
			if (decoded.kind === "failure") {
				yield { done: true, error: decoded.error };
				return;
			}
			buffer = decoded.buffer;
			if (yield* emitLines(decoded.lines, toolCallCounter)) return;
			if (decoded.ended) {
				yield {
					done: true,
					error: { kind: "connection", message: "Ollama stream ended before its final chunk" },
				};
				return;
			}
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
			keep_alive: config.keepAlive ?? "30m",
		};
		if (tools.length > 0) body.tools = buildTools(tools);
		const options = buildRequestOptions(opts);
		if (Object.keys(options).length > 0) body.options = options;

		return ResultAsync.fromPromise(
			fetch(`${baseUrl}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(connectTimeout + firstTokenTimeout + streamTimeout),
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

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
