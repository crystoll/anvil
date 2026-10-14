import { okAsync, type ResultAsync } from "neverthrow";
import { prepareHistoryForRequest } from "../engine/history.js";
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
/** Number of recent messages to keep verbatim (accounts for tool-call interleaving). */
const KEEP_RECENT = 6;
const MAX_SUMMARY_INPUT_CHARS = 40_000;
const SUMMARY_OMISSION_MARKER = "[older content omitted]";

const groupMessages = (messages: Message[]): Message[][] => {
	const groups: Message[][] = [];
	for (let index = 0; index < messages.length; ) {
		const message = messages[index];
		if (!message) break;
		if (message.role !== "assistant" || !message.toolCalls?.length) {
			groups.push([message]);
			index++;
			continue;
		}

		const callIds = new Set(message.toolCalls.map((call) => call.id));
		const group = [message];
		index++;
		while (
			index < messages.length &&
			messages[index]?.role === "tool" &&
			callIds.has(messages[index]?.toolCallId ?? "")
		) {
			const result = messages[index];
			if (result) group.push(result);
			index++;
		}
		groups.push(group);
	}
	return groups;
};

const splitRecentGroups = (
	groups: Message[][],
	latestUser: Message | undefined,
): { toSummarize: Message[]; toKeep: Message[] } => {
	let keepStart = groups.length;
	let keptCount = 0;
	while (keepStart > 0 && keptCount < KEEP_RECENT) {
		keepStart--;
		keptCount += groups[keepStart]?.length ?? 0;
	}

	const latestUserGroup = latestUser ? groups.findIndex((group) => group.includes(latestUser)) : -1;
	if (latestUserGroup >= 0) keepStart = Math.min(keepStart, latestUserGroup);

	return {
		toSummarize: groups.slice(0, keepStart).flat(),
		toKeep: groups.slice(keepStart).flat(),
	};
};

const summaryInputLimit = (contextSize?: number): number =>
	contextSize && contextSize > 0
		? Math.min(MAX_SUMMARY_INPUT_CHARS, Math.floor(contextSize * 2))
		: MAX_SUMMARY_INPUT_CHARS;

const truncateKeepingHeadAndTail = (content: string, limit: number): string => {
	if (content.length <= limit) return content;
	if (limit <= SUMMARY_OMISSION_MARKER.length) {
		const headLength = Math.ceil(limit / 2);
		const tailLength = Math.floor(limit / 2);
		return `${content.slice(0, headLength)}${content.slice(-tailLength)}`;
	}

	const contentLength = limit - SUMMARY_OMISSION_MARKER.length;
	const headLength = Math.ceil(contentLength / 2);
	const tailLength = Math.floor(contentLength / 2);
	return `${content.slice(0, headLength)}${SUMMARY_OMISSION_MARKER}${content.slice(-tailLength)}`;
};

/** Compact conversation history by summarizing old messages and keeping recent ones. */
export const compactHistory = (
	provider: Provider,
	model: string,
	messages: Message[],
	options: { debug?: boolean; contextSize?: number } = {},
): ResultAsync<Message[], CompactError> => {
	const nonSystem = messages.filter((m) => m.role !== "system");
	if (nonSystem.length < MIN_MESSAGES) return okAsync(messages);

	const system = messages.filter((m) => m.role === "system");
	const task = nonSystem.find((message) => message.role === "user");
	const latestUser = nonSystem.findLast((message) => message.role === "user");
	const messagesWithoutTask = task ? nonSystem.filter((message) => message !== task) : nonSystem;
	const { toSummarize, toKeep } = splitRecentGroups(groupMessages(messagesWithoutTask), latestUser);
	if (toSummarize.length === 0) return okAsync(messages);

	// Build summarization input — exclude reasoning (too verbose)
	// Truncate input to prevent the summarization itself from overflowing
	const summaryContent = truncateKeepingHeadAndTail(
		toSummarize
			.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool")
			.map((m) => `[${m.role}]: ${m.content}`)
			.join("\n"),
		summaryInputLimit(options.contextSize),
	);

	const summaryInput: Message[] = [
		{ role: "system", content: SUMMARY_PROMPT },
		{ role: "user", content: summaryContent },
	];
	const requestHistory = prepareHistoryForRequest(summaryInput, options.debug);

	return provider
		.completeChat(model, requestHistory, [], { maxTokens: 1024 })
		.map((result) => [
			...system,
			...(task ? [task] : []),
			{ role: "user" as const, content: `[Previous conversation summary]\n${result.content}` },
			{
				role: "assistant" as const,
				content: "Understood. I have the context from our previous conversation.",
			},
			...toKeep,
		])
		.mapErr((e) => ({ message: e.message }));
};
