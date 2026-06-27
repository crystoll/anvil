import type { ResultAsync } from "neverthrow";

/** Roles in a chat conversation. */
export type Role = "system" | "user" | "assistant" | "tool";

/** A single message in a conversation. */
export type Message = {
	role: Role;
	content: string;
	reasoning?: string;
	toolCalls?: ToolCall[];
	toolCallId?: string;
};

/** A completed tool invocation requested by the model. */
export type ToolCall = {
	id: string;
	name: string;
	arguments: string;
};

/** Incremental fragment of a tool call during streaming. */
export type ToolCallDelta = {
	index: number;
	id?: string;
	name?: string;
	argumentsFragment: string;
};

/** A single chunk from a streaming response. */
export type StreamChunk = {
	content?: string;
	reasoning?: string;
	toolCall?: ToolCallDelta;
	done: boolean;
	finishReason?: string;
	error?: ProviderError;
	usage?: TokenUsage;
};

/** Token usage stats from a completion. */
export type TokenUsage = {
	promptTokens: number;
	totalTokens: number;
};

/** Result of a non-streaming completion. */
export type CompletionResult = {
	content: string;
	toolCalls: ToolCall[];
	usage?: TokenUsage;
};

/** JSON Schema description of a callable tool. */
export type ToolSchema = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
};

/** Options for streaming completions. */
export type StreamOptions = {
	temperature?: number;
	maxTokens?: number;
	contextSize?: number;
};

/** Options for non-streaming completions. */
export type CompleteOptions = {
	temperature?: number;
	maxTokens?: number;
	forceTool?: string;
};

/** Provider configuration from config file. */
export type ProviderConfig = {
	endpoint: string;
	apiKey?: string;
	/** Seconds without a chunk before aborting stream (default 30). */
	streamTimeout?: number;
	/** Seconds to establish connection (default 3). */
	connectTimeout?: number;
};

/** The provider interface — all LLM backends implement this. */
export type Provider = {
	name: string;
	streamChat: (
		model: string,
		messages: Message[],
		tools: ToolSchema[],
		opts: StreamOptions,
	) => ResultAsync<AsyncIterable<StreamChunk>, ProviderError>;
	completeChat: (
		model: string,
		messages: Message[],
		tools: ToolSchema[],
		opts: CompleteOptions,
	) => ResultAsync<CompletionResult, ProviderError>;
	supportsTools: () => boolean;
	listModels: () => ResultAsync<string[], ProviderError>;
};

/** Discriminated union of provider errors. */
export type ProviderError =
	| { kind: "timeout"; message: string }
	| { kind: "connection"; message: string }
	| { kind: "parse"; message: string; raw?: string }
	| { kind: "api"; status: number; message: string }
	| { kind: "unknown"; message: string; cause?: unknown };
