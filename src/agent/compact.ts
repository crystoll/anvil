import { okAsync, type ResultAsync } from "neverthrow";
import type { Message, Provider } from "../provider/types.js";

export type CompactError = { message: string };

const SUMMARY_PROMPT = `Summarize this conversation concisely. Preserve:
- Key decisions made
- File paths and code references mentioned
- Current task and goals
- Important constraints or requirements stated

Be brief — this summary replaces the conversation history. Use bullet points.`;

/** Minimum messages before compaction is worthwhile. */
const MIN_MESSAGES = 6;
/** Number of recent user+assistant exchanges to keep verbatim. */
const KEEP_RECENT = 4;

/** Compact conversation history by summarizing old messages and keeping recent ones. */
export const compactHistory = (
	provider: Provider,
	model: string,
	messages: Message[],
): ResultAsync<Message[], CompactError> => {
	const nonSystem = messages.filter((m) => m.role !== "system");
	if (nonSystem.length < MIN_MESSAGES) return okAsync(messages);

	const system = messages.filter((m) => m.role === "system");
	const toSummarize = nonSystem.slice(0, -KEEP_RECENT);
	const toKeep = nonSystem.slice(-KEEP_RECENT);

	// Build summarization input — exclude reasoning (too verbose)
	// Truncate input to prevent the summarization itself from overflowing
	const MAX_SUMMARY_INPUT_CHARS = 40_000; // ~10k tokens — safe for any context size
	const summaryContent = toSummarize
		.filter((m) => m.role === "user" || m.role === "assistant")
		.map((m) => `[${m.role}]: ${m.content}`)
		.join("\n")
		.slice(0, MAX_SUMMARY_INPUT_CHARS);

	const summaryInput: Message[] = [
		{ role: "system", content: SUMMARY_PROMPT },
		{ role: "user", content: summaryContent },
	];

	return provider
		.completeChat(model, summaryInput, [], { maxTokens: 1024 })
		.map((result) => [
			...system,
			{ role: "user" as const, content: `[Previous conversation summary]\n${result.content}` },
			{
				role: "assistant" as const,
				content: "Understood. I have the context from our previous conversation.",
			},
			...toKeep,
		])
		.mapErr((e) => ({ message: e.message }));
};
