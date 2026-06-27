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
	ToolSchema,
} from "./types.js";

const DEFAULT_STREAM_TIMEOUT = 30_000;

/** Creates an OpenAI-compatible provider (works with Ollama, LM Studio, llama.cpp, LiteLLM). */
export const createProvider = (name: string, config: ProviderConfig): Provider => {
	const streamTimeout = (config.streamTimeout ?? 30) * 1000;
	const connectTimeout = (config.connectTimeout ?? 3) * 1000;
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
			const msg: Record<string, unknown> = { role: m.role, content: m.content };
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
		if (opts.contextSize != null) body.options = { num_ctx: opts.contextSize };

		return ResultAsync.fromPromise(
			fetchWithTimeout(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: headers(),
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(connectTimeout),
			}),
			(e) => toConnectionError(e),
		).andThen((response) => {
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
			return okAsync(parseSSEStream(response.body, streamTimeout));
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
			fetchWithTimeout(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: headers(),
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(connectTimeout + DEFAULT_STREAM_TIMEOUT),
			}).then((r) => {
				if (!r.ok) throw { kind: "api", status: r.status, message: `API returned ${r.status}` };
				return r.json();
			}),
			(e) => toProviderError(e),
		).map((json) => parseCompletionResponse(json));
	};

	const listModels = (): ResultAsync<string[], ProviderError> =>
		ResultAsync.fromPromise(
			fetchWithTimeout(`${baseUrl}/models`, {
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

/** Reads from a stream with a timeout watchdog, yielding raw byte arrays. */
async function* readWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeout: number,
): AsyncGenerator<Uint8Array | "timeout" | "end"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const clearWatchdog = () => {
		if (timer) clearTimeout(timer);
	};

	try {
		while (true) {
			const readPromise = reader.read();
			const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
				timer = setTimeout(() => resolve({ timedOut: true }), timeout);
			});

			const result = await Promise.race([readPromise, timeoutPromise]);
			clearWatchdog();

			if ("timedOut" in result) {
				reader.cancel();
				yield "timeout";
				return;
			}
			if (result.done) {
				yield "end";
				return;
			}
			yield result.value;
		}
	} finally {
		clearWatchdog();
		reader.releaseLock();
	}
}

/** Parse a single SSE line into a StreamChunk, or a terminal signal. */
const parseSSELine = (line: string): StreamChunk | "done" | undefined => {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":")) return undefined;
	if (trimmed === "data: [DONE]") return "done";
	if (!trimmed.startsWith("data: ")) return undefined;
	return parseChunkJSON(trimmed.slice(6));
};

/** Parse SSE stream into async iterable of StreamChunks with timeout watchdog. */
async function* parseSSEStream(
	body: ReadableStream<Uint8Array>,
	timeout: number,
): AsyncIterable<StreamChunk> {
	const decoder = new TextDecoder();
	let buffer = "";

	for await (const data of readWithTimeout(body.getReader(), timeout)) {
		if (data === "timeout") {
			yield {
				done: true,
				error: { kind: "timeout", message: "Stream stalled — no data received within timeout" },
			};
			return;
		}
		if (data === "end") {
			yield { done: true };
			return;
		}

		buffer += decoder.decode(data, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			const parsed = parseSSELine(line);
			if (parsed === "done") {
				yield { done: true };
				return;
			}
			if (parsed) yield parsed;
		}
	}
}

/** Parse a single SSE data line into a StreamChunk. */
const parseToolCallDelta = (delta: Record<string, unknown>): StreamChunk["toolCall"] => {
	const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
	const tc = tcs?.[0];
	if (!tc) return undefined;
	const fn = tc.function as Record<string, unknown> | undefined;
	const result: NonNullable<StreamChunk["toolCall"]> = {
		index: (tc.index as number) ?? 0,
		argumentsFragment: (fn?.arguments as string) ?? "",
	};
	if (tc.id) result.id = tc.id as string;
	if (fn?.name) result.name = fn.name as string;
	return result;
};

const parseUsage = (data: Record<string, unknown>): StreamChunk | undefined => {
	const u = data.usage as { prompt_tokens?: number; total_tokens?: number } | undefined;
	if (!u) return undefined;
	return {
		done: true,
		usage: { promptTokens: u.prompt_tokens ?? 0, totalTokens: u.total_tokens ?? 0 },
	};
};

const parseChunkJSON = (json: string): StreamChunk | undefined => {
	try {
		const data = JSON.parse(json);
		const choice = data.choices?.[0];

		if (!choice) return parseUsage(data);

		const delta = choice.delta ?? {};
		const chunk: StreamChunk = { done: choice.finish_reason != null };
		if (choice.finish_reason) chunk.finishReason = choice.finish_reason;

		if (delta.content) chunk.content = delta.content;
		if (delta.reasoning_content || delta.reasoning)
			chunk.reasoning = delta.reasoning_content ?? delta.reasoning;

		const toolCall = parseToolCallDelta(delta);
		if (toolCall) chunk.toolCall = toolCall;

		if (data.usage) {
			chunk.usage = {
				promptTokens: data.usage.prompt_tokens ?? 0,
				totalTokens: data.usage.total_tokens ?? 0,
			};
		}

		return chunk;
	} catch {
		return undefined;
	}
};

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

const fetchWithTimeout = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);

const toConnectionError = (e: unknown): ProviderError => {
	if (e instanceof Error && e.name === "TimeoutError") {
		return { kind: "timeout", message: "Connection timed out" };
	}
	return { kind: "connection", message: e instanceof Error ? e.message : String(e) };
};

const toProviderError = (e: unknown): ProviderError => {
	if (typeof e === "object" && e !== null && "kind" in e) return e as ProviderError;
	return toConnectionError(e);
};
