import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Message, Provider } from "../provider/types.js";
import { compactHistory } from "./compact.js";

const mockProvider = (summary: string): Provider => ({
	name: "mock",
	streamChat: vi.fn() as unknown as Provider["streamChat"],
	completeChat: vi
		.fn()
		.mockReturnValue(okAsync({ content: summary, toolCalls: [], usage: undefined })),
	listModels: vi.fn().mockReturnValue(okAsync([])),
	supportsTools: () => true,
});

const failingProvider = (message: string): Provider => ({
	name: "mock",
	streamChat: vi.fn() as unknown as Provider["streamChat"],
	completeChat: vi.fn().mockReturnValue(errAsync({ kind: "api", status: 500, message })),
	listModels: vi.fn().mockReturnValue(okAsync([])),
	supportsTools: () => true,
});

describe("compactHistory", () => {
	it("replaces old messages with summary, keeps recent exchanges", async () => {
		const messages: Message[] = [
			{ role: "system", content: "You are helpful." },
			{ role: "user", content: "What is TypeScript?" },
			{ role: "assistant", content: "TypeScript is a typed superset of JavaScript." },
			{ role: "user", content: "How do I install it?" },
			{ role: "assistant", content: "Run: npm install -g typescript" },
			{ role: "user", content: "What about config?" },
			{ role: "assistant", content: "Create a tsconfig.json file." },
		];

		const provider = mockProvider("User asked about TypeScript basics and installation.");
		const result = await compactHistory(provider, "test-model", messages);

		expect(result.isOk()).toBe(true);
		const compacted = result._unsafeUnwrap();

		// Should retain system message
		expect(compacted[0]).toEqual({ role: "system", content: "You are helpful." });

		// Should have a summary message
		const summaryMsg = compacted.find((m) => m.content.includes("TypeScript basics"));
		expect(summaryMsg).toBeDefined();
		expect(summaryMsg?.role).toBe("user");

		// Should retain recent messages (last KEEP_RECENT messages)
		const lastMsg = compacted[compacted.length - 1];
		expect(lastMsg?.content).toBe("Create a tsconfig.json file.");
	});

	it("excludes reasoning from summary input", async () => {
		const messages: Message[] = [
			{ role: "user", content: "First task" },
			{
				role: "assistant",
				content: "Done first.",
				reasoning: "Very long internal thinking process...",
			},
			{ role: "user", content: "Second task" },
			{ role: "assistant", content: "Done second." },
			{ role: "user", content: "Third task" },
			{ role: "assistant", content: "Done third." },
			{ role: "user", content: "Latest task" },
			{ role: "assistant", content: "OK." },
		];

		const provider = mockProvider("User asked to complete tasks.");
		await compactHistory(provider, "test-model", messages);

		const calls = (provider.completeChat as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		const sentMessages = (calls[0] as unknown[])[1] as Message[];
		const sentContent = sentMessages.map((m) => m.content).join(" ");
		expect(sentContent).not.toContain("Very long internal thinking");
	});

	it("returns error when summarization fails", async () => {
		const messages: Message[] = [
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi" },
			{ role: "user", content: "More" },
			{ role: "assistant", content: "Sure" },
			{ role: "user", content: "Again" },
			{ role: "assistant", content: "Yep" },
			{ role: "user", content: "Last" },
			{ role: "assistant", content: "Done" },
		];

		const provider = failingProvider("model overloaded");
		const result = await compactHistory(provider, "test-model", messages);

		expect(result.isErr()).toBe(true);
		expect(result._unsafeUnwrapErr().message).toContain("model overloaded");
	});

	it("returns original messages if too few to compact", async () => {
		const messages: Message[] = [
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: "Hello" },
		];

		const provider = mockProvider("irrelevant");
		const result = await compactHistory(provider, "test-model", messages);

		expect(result.isOk()).toBe(true);
		expect(result._unsafeUnwrap()).toEqual(messages);
	});
});
