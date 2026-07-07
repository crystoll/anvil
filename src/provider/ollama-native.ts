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

/** Creates a native Ollama provider using /api/chat with options.num_ctx support. */
export const createOllamaProvider = (name: string, config: ProviderConfig): Provider => {
	const streamTimeout = (config.streamTimeout ?? 30) * 1000;
	const connectTimeout = (config.connectTimeout ?? 3) * 1000;
	const baseUrl = config.endpoint.replace(/\/$/, "");

	const buildMessages = (messages: Message[]) =>
		messages.map((m) => {
			const msg: Record<string, unknown> = { role: m.role, content: m.content };
			if (m.toolCallId) msg.tool_call_id = m.toolCallId;
			if (m.toolCalls?.length) {
				msg.tool_calls = m.toolCalls.map((tc) => ({
					id: tc.id,
					function: { name: tc.name, arguments: JSON.parse(tc.arguments) },
				}));
			}
			return msg;
		});

	const buildTools = (tools: ToolSchema[]) =>
		tools.map((t) => ({
			type: "function" as const,
			function: { name: t.name, description: t.description, parameters: t.parameters },
		}));

	const parseToolCall = (msg: Record<string, unknown>): StreamChunk["toolCall"] => {
		const calls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
		const tc = calls?.[0];
		if (!tc) return undefined;
		const fn = tc.function as Record<string, unknown>;
		return {
			index: 0,
			id: tc.id as string,
			name: fn.name as string,
			argumentsFragment: JSON.stringify(fn.arguments),
		};
	};

	const parseUsage = (data: Record<string, unknown>): StreamChunk["usage"] => {
		if (data.prompt_eval_count == null && data.eval_count == null) return undefined;
		const prompt = (data.prompt_eval_count as number) ?? 0;
		const eval_ = (data.eval_count as number) ?? 0;
		return { promptTokens: prompt, totalTokens: prompt + eval_ };
	};

	const buildChunk = (data: Record<string, unknown>): StreamChunk => {
		const msg = (data.message ?? {}) as Record<string, unknown>;
		const chunk: StreamChunk = { done: data.done === true };
		if (msg.content) chunk.content = msg.content as string;
		if (msg.thinking) chunk.reasoning = msg.thinking as string;
		if (data.done_reason) chunk.finishReason = data.done_reason as string;
		const toolCall = parseToolCall(msg);
		if (toolCall) chunk.toolCall = toolCall;
		if (data.done) {
			const usage = parseUsage(data);
			if (usage) chunk.usage = usage;
		}
		return chunk;
	};

	const parseChunk = (line: string): StreamChunk | undefined => {
		if (!line.trim()) return undefined;
		try {
			return buildChunk(JSON.parse(line));
		} catch {
			return undefined;
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

	const parseLines = function* (lines: string[]): Generator<StreamChunk> {
		for (const line of lines) {
			const chunk = parseChunk(line);
			if (chunk) yield chunk;
		}
	};

	async function* parseNDJSONStream(
		body: ReadableStream<Uint8Array>,
		timeout: number,
	): AsyncIterable<StreamChunk> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
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
				yield* parseLines(lines);
			}
			if (buffer.trim()) yield* parseLines([buffer]);
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
		return { kind: "timeout", message: "Connection timed out" };
	}
	if (e instanceof DOMException && e.name === "AbortError") {
		return { kind: "timeout", message: "Connection timed out" };
	}
	return { kind: "connection", message: e instanceof Error ? e.message : String(e) };
};

const toProviderError = (e: unknown): ProviderError => {
	if (typeof e === "object" && e !== null && "kind" in e) return e as ProviderError;
	return toConnectionError(e);
};
