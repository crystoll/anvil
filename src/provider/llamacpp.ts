import { okAsync, ResultAsync } from "neverthrow";
import { createProvider } from "./openai-compatible.js";
import type {
	CompleteOptions,
	CompletionResult,
	Message,
	Provider,
	ProviderConfig,
	ProviderError,
	StreamChunk,
	StreamOptions,
	ToolSchema,
} from "./types.js";

/** Metadata returned by llama.cpp `/v1/models`. */
type LlamaCppModelMeta = {
	n_ctx_train?: number;
	n_params?: number;
};

type LlamaCppModelEntry = {
	id: string;
	meta?: LlamaCppModelMeta | null;
};

/** Extended provider type with llama.cpp-specific methods. */
export type LlamaCppProvider = Provider & {
	checkHealth: () => ResultAsync<boolean, ProviderError>;
	fetchContextSize: (modelId?: string) => ResultAsync<number | undefined, ProviderError>;
};

/**
 * Creates a llama.cpp provider that wraps the OpenAI-compatible provider
 * but adds health checking, context size auto-detection, and server-specific
 * metadata parsing.
 */
export const createLlamaCppProvider = (name: string, config: ProviderConfig): LlamaCppProvider => {
	const baseUrl = config.endpoint.replace(/\/$/, "");
	const connectTimeout = (config.connectTimeout ?? 3) * 1000;

	// Underlying OAI-compatible provider does the real streaming/completion work.
	// The llama.cpp server's /v1 endpoints are fully OpenAI-compatible.
	const inner = createProvider(name, {
		...config,
		endpoint: `${baseUrl}/v1`,
	});

	/** Check server health. Returns true if healthy, error otherwise. */
	const checkHealth = (): ResultAsync<boolean, ProviderError> =>
		ResultAsync.fromPromise(
			fetch(`${baseUrl}/health`, {
				signal: AbortSignal.timeout(connectTimeout),
			}).then((r) => {
				if (r.status === 503) {
					throw { kind: "connection", message: "llama.cpp server is still loading model" };
				}
				if (!r.ok) {
					throw { kind: "api", status: r.status, message: `Health check returned ${r.status}` };
				}
				return true;
			}),
			(e) => toProviderError(e),
		);

	/**
	 * Fetch model metadata from /v1/models.
	 * Returns training context size if available.
	 * When modelId is provided, looks for that specific model; otherwise uses first.
	 */
	const fetchContextSize = (modelId?: string): ResultAsync<number | undefined, ProviderError> =>
		ResultAsync.fromPromise(
			fetch(`${baseUrl}/v1/models`, {
				signal: AbortSignal.timeout(connectTimeout),
			}).then(async (r) => {
				if (!r.ok) return undefined;
				const json = (await r.json()) as { data?: LlamaCppModelEntry[] };
				const models = json.data ?? [];
				const model = modelId ? (models.find((m) => m.id === modelId) ?? models[0]) : models[0];
				return model?.meta?.n_ctx_train ?? undefined;
			}),
			() => undefined as never,
		).orElse(() => okAsync(undefined));

	const streamChat = (
		model: string,
		messages: Message[],
		tools: ToolSchema[],
		opts: StreamOptions,
	): ResultAsync<AsyncIterable<StreamChunk>, ProviderError> =>
		inner.streamChat(model, messages, tools, opts);

	const completeChat = (
		model: string,
		messages: Message[],
		tools: ToolSchema[],
		opts: CompleteOptions,
	): ResultAsync<CompletionResult, ProviderError> =>
		inner.completeChat(model, messages, tools, opts);

	const listModels = (): ResultAsync<string[], ProviderError> => inner.listModels();

	return {
		name,
		streamChat,
		completeChat,
		supportsTools: () => true,
		listModels,
		checkHealth,
		fetchContextSize,
	};
};

const toProviderError = (e: unknown): ProviderError => {
	if (typeof e === "object" && e !== null && "kind" in e) return e as ProviderError;
	if (e instanceof Error && e.name === "TimeoutError") {
		return { kind: "timeout", message: "Connection timed out" };
	}
	if (e instanceof DOMException && e.name === "AbortError") {
		return { kind: "timeout", message: "Connection timed out" };
	}
	return { kind: "connection", message: e instanceof Error ? e.message : String(e) };
};
