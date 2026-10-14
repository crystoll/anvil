import { err, ok, type Result } from "neverthrow";
import type { Message } from "../provider/types.js";

const interruptedToolResult = (toolCallId: string): Message => ({
	role: "tool",
	toolCallId,
	content: "[not executed: session was interrupted]",
});

const closePendingCalls = (
	messages: Message[],
	pendingCalls: Set<string>,
	results: Map<string, Message>,
): void => {
	for (const toolCallId of pendingCalls) {
		messages.push(results.get(toolCallId) ?? interruptedToolResult(toolCallId));
	}
	pendingCalls.clear();
	results.clear();
};

/** Restores tool-call/result pairing after an interrupted session and flags an unanswered turn. */
export const repairHistory = (
	history: readonly Message[],
): { messages: Message[]; hasUnansweredUser: boolean } => {
	const messages: Message[] = [];
	const pendingCalls = new Set<string>();
	const results = new Map<string, Message>();

	for (const message of history) {
		if (message.role === "tool") {
			if (
				message.toolCallId !== undefined &&
				pendingCalls.has(message.toolCallId) &&
				!results.has(message.toolCallId)
			) {
				results.set(message.toolCallId, message);
			}
			continue;
		}

		closePendingCalls(messages, pendingCalls, results);
		messages.push(message);
		if (message.role === "assistant") {
			for (const call of message.toolCalls ?? []) pendingCalls.add(call.id);
		}
	}

	closePendingCalls(messages, pendingCalls, results);
	const lastUserIndex = history.findLastIndex((message) => message.role === "user");
	const hasAssistantReply = history
		.slice(lastUserIndex + 1)
		.some((message) => message.role === "assistant" && !message.toolCalls?.length);

	return {
		messages,
		hasUnansweredUser: lastUserIndex >= 0 && !hasAssistantReply,
	};
};

/** Rejects histories that would need tool-call repair before being sent to a provider. */
export const validateHistory = (history: readonly Message[]): Result<void, string> => {
	const repaired = repairHistory(history).messages;
	const isUnchanged =
		repaired.length === history.length &&
		repaired.every((message, index) => message === history[index]);

	return isUnchanged ? ok(undefined) : err("Tool calls and results are unmatched or out of order");
};

/** Returns valid provider input, repairing broken tool-call groups when needed. */
export const prepareHistoryForRequest = (history: readonly Message[], debug = false): Message[] => {
	const validation = validateHistory(history);
	if (validation.isOk()) return [...history];

	const repaired = repairHistory(history).messages;
	if (debug) console.debug(`anvil: repaired history before provider request: ${validation.error}`);
	return repaired;
};
