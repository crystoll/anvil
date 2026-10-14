import { describe, expect, it } from "vitest";
import type { Message } from "../provider/types.js";
import { repairHistory, validateHistory } from "./history.js";

const invalidHistories: { issue: string; history: Message[] }[] = [
	{
		issue: "an unanswered call",
		history: [
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
			},
		],
	},
	{
		issue: "an orphan result",
		history: [{ role: "tool", toolCallId: "orphan", content: "stale result" }],
	},
];

const interrupted = (toolCallId: string): Message => ({
	role: "tool",
	toolCallId,
	content: "[not executed: session was interrupted]",
});

describe("repairHistory", () => {
	it("fills unanswered calls and flags the request without a final assistant reply", () => {
		const history: Message[] = [
			{ role: "user", content: "Read both files" },
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{ id: "call-1", name: "read_file", arguments: "{}" },
					{ id: "call-2", name: "read_file", arguments: "{}" },
				],
			},
			{ role: "tool", toolCallId: "call-1", content: "first file" },
		];

		const repaired = repairHistory(history);

		expect(repaired.messages).toEqual([...history, interrupted("call-2")]);
		expect(repaired.hasUnansweredUser).toBe(true);
		expect(history).toHaveLength(3);
	});

	it("keeps tool results in the original call order when an earlier call is missing", () => {
		const history: Message[] = [
			{ role: "user", content: "Read both files" },
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{ id: "call-1", name: "read_file", arguments: "{}" },
					{ id: "call-2", name: "read_file", arguments: "{}" },
				],
			},
			{ role: "tool", toolCallId: "call-2", content: "second file" },
		];

		const repaired = repairHistory(history);

		expect(repaired.messages).toEqual([history[0], history[1], interrupted("call-1"), history[2]]);
	});

	it("drops orphan and duplicate results while preserving matched tool output", () => {
		const history: Message[] = [
			{ role: "user", content: "Read a file" },
			{ role: "tool", toolCallId: "orphan", content: "stale result" },
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
			},
			{ role: "tool", toolCallId: "call-1", content: "file contents" },
			{ role: "tool", toolCallId: "call-1", content: "duplicate result" },
			{ role: "assistant", content: "Done" },
		];

		const repaired = repairHistory(history);

		expect(repaired.messages).toEqual([history[0], history[2], history[3], history[5]]);
		expect(repaired.hasUnansweredUser).toBe(false);
	});

	it("closes an interrupted tool-call group before the next user message", () => {
		const history: Message[] = [
			{ role: "user", content: "First request" },
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
			},
			{ role: "user", content: "Second request" },
			{ role: "assistant", content: "Second response" },
		];

		const repaired = repairHistory(history);

		expect(repaired.messages).toEqual([
			history[0],
			history[1],
			interrupted("call-1"),
			history[2],
			history[3],
		]);
		expect(repaired.hasUnansweredUser).toBe(false);
	});

	it("closes an interrupted tool-call group before a later assistant reply", () => {
		const history: Message[] = [
			{ role: "user", content: "Read a file" },
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
			},
			{ role: "assistant", content: "Here is the result." },
		];

		const repaired = repairHistory(history);

		expect(repaired.messages).toEqual([history[0], history[1], interrupted("call-1"), history[2]]);
		expect(repaired.hasUnansweredUser).toBe(false);
	});

	it("returns an intact exchange without changes", () => {
		const history: Message[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi" },
		];

		const repaired = repairHistory(history);

		expect(repaired).toEqual({ messages: history, hasUnansweredUser: false });
	});

	it("flags a trailing user message with no assistant response", () => {
		const history: Message[] = [{ role: "user", content: "Unfinished request" }];

		expect(repairHistory(history)).toEqual({
			messages: history,
			hasUnansweredUser: true,
		});
	});

	it("accepts well-paired tool calls and results", () => {
		const history: Message[] = [
			{ role: "user", content: "Read a file" },
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
			},
			{ role: "tool", toolCallId: "call-1", content: "file contents" },
			{ role: "user", content: "Thanks" },
		];

		expect(validateHistory(history).isOk()).toBe(true);
	});

	it("rejects tool results that are out of call order", () => {
		const history: Message[] = [
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{ id: "call-1", name: "read_file", arguments: "{}" },
					{ id: "call-2", name: "read_file", arguments: "{}" },
				],
			},
			{ role: "tool", toolCallId: "call-2", content: "second file" },
			{ role: "tool", toolCallId: "call-1", content: "first file" },
		];

		expect(validateHistory(history).isErr()).toBe(true);
	});

	it.each(invalidHistories)("rejects history with $issue", ({ history }) => {
		expect(validateHistory(history).isErr()).toBe(true);
	});
});
