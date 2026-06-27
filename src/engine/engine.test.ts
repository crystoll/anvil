import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { Provider, StreamChunk } from "../provider/types.js";
import { createEngine } from "./engine.js";
import type { EngineEvent } from "./engine.js";

/** Helper: create a mock provider that streams the given chunks. */
const mockProvider = (chunks: StreamChunk[]): Provider => ({
	name: "mock",
	streamChat: () => {
		async function* generate() {
			for (const chunk of chunks) yield chunk;
		}
		return okAsync(generate());
	},
	completeChat: () => {
		throw new Error("not implemented");
	},
	supportsTools: () => true,
	listModels: () => okAsync([]),
});

/** Helper: collect all events from a stream. */
const collectEvents = async (iter: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> => {
	const events: EngineEvent[] = [];
	for await (const event of iter) events.push(event);
	return events;
};

describe("chat engine", () => {
	it("maintains message history", () => {
		const engine = createEngine(mockProvider([]), "test");

		engine.setSystem("You are helpful");
		engine.addUser("Hello");

		expect(engine.messages()).toEqual([
			{ role: "system", content: "You are helpful" },
			{ role: "user", content: "Hello" },
		]);
	});

	it("replaces system message if already set", () => {
		const engine = createEngine(mockProvider([]), "test");

		engine.setSystem("First");
		engine.setSystem("Second");

		expect(engine.messages()[0]).toEqual({ role: "system", content: "Second" });
		expect(engine.messages()).toHaveLength(1);
	});

	it("streams response and appends assistant message to history", async () => {
		const chunks: StreamChunk[] = [
			{ content: "Hello", done: false },
			{ content: " there", done: false },
			{ done: true },
		];
		const engine = createEngine(mockProvider(chunks), "test");
		engine.addUser("Hi");

		const events = await collectEvents(engine.stream([]));

		const chunkEvents = events.filter((e) => e.kind === "chunk");
		expect(chunkEvents).toHaveLength(3);

		const doneEvent = events.find((e) => e.kind === "done");
		expect(doneEvent).toBeDefined();
		if (doneEvent?.kind === "done") {
			expect(doneEvent.message.content).toBe("Hello there");
			expect(doneEvent.message.role).toBe("assistant");
		}

		// Assistant message should be in history now
		const last = engine.messages()[engine.messages().length - 1];
		expect(last?.content).toBe("Hello there");
		expect(last?.role).toBe("assistant");
	});

	it("accumulates tool calls from streaming deltas", async () => {
		const chunks: StreamChunk[] = [
			{
				toolCall: { index: 0, id: "call_1", name: "read_file", argumentsFragment: '{"path":' },
				done: false,
			},
			{ toolCall: { index: 0, argumentsFragment: '"index.ts"}' }, done: false },
			{ done: true },
		];
		const engine = createEngine(mockProvider(chunks), "test");
		engine.addUser("read it");

		const events = await collectEvents(engine.stream([]));
		const doneEvent = events.find((e) => e.kind === "done");

		expect(doneEvent?.kind).toBe("done");
		if (doneEvent?.kind === "done") {
			expect(doneEvent.message.toolCalls).toHaveLength(1);
			expect(doneEvent.message.toolCalls?.[0]?.name).toBe("read_file");
			expect(doneEvent.message.toolCalls?.[0]?.arguments).toBe('{"path":"index.ts"}');
		}
	});

	it("supports cancellation", async () => {
		// Provider that yields one chunk then hangs
		const provider: Provider = {
			name: "mock",
			streamChat: () => {
				async function* generate() {
					yield { content: "start", done: false } as StreamChunk;
					await new Promise((r) => setTimeout(r, 100));
					yield { content: "should not appear", done: false } as StreamChunk;
					yield { done: true } as StreamChunk;
				}
				return okAsync(generate());
			},
			completeChat: () => {
				throw new Error("not implemented");
			},
			supportsTools: () => true,
			listModels: () => okAsync([]),
		};

		const engine = createEngine(provider, "test");
		engine.addUser("hi");

		const events: EngineEvent[] = [];
		for await (const event of engine.stream([])) {
			events.push(event);
			if (event.kind === "chunk") {
				engine.cancel();
			}
		}

		expect(events.some((e) => e.kind === "cancelled")).toBe(true);
		expect(engine.state()).toBe("idle");
	});

	it("adds tool results to history", () => {
		const engine = createEngine(mockProvider([]), "test");
		engine.addToolResult("call_1", "file contents here");

		const last = engine.messages()[0];
		expect(last?.role).toBe("tool");
		expect(last?.toolCallId).toBe("call_1");
		expect(last?.content).toBe("file contents here");
	});

	it("resets all state", async () => {
		const engine = createEngine(mockProvider([{ done: true }]), "test");
		engine.setSystem("sys");
		engine.addUser("hi");
		await collectEvents(engine.stream([]));

		engine.reset();

		expect(engine.messages()).toHaveLength(0);
		expect(engine.state()).toBe("idle");
	});
});

describe("trimToFit", () => {
	it("does nothing when under budget", () => {
		const engine = createEngine(mockProvider([]), "m");
		engine.setSystem("system");
		engine.addUser("hello");
		const removed = engine.trimToFit(10000);
		expect(removed).toBe(0);
		expect(engine.messages()).toHaveLength(2);
	});

	it("removes oldest messages to fit budget", () => {
		const engine = createEngine(mockProvider([]), "m");
		engine.setSystem("sys");
		engine.addUser("a".repeat(400)); // ~100 tokens
		engine.addUser("b".repeat(400)); // ~100 tokens
		engine.addUser("c".repeat(400)); // ~100 tokens
		expect(engine.messages()).toHaveLength(4);
		const removed = engine.trimToFit(250); // budget for sys + ~2 messages
		expect(removed).toBeGreaterThan(0);
		// System is always kept
		expect(engine.messages()[0]?.role).toBe("system");
		// Most recent messages kept
		const last = engine.messages()[engine.messages().length - 1];
		expect(last?.content).toContain("c");
	});

	it("removes tool call + tool result as atomic pair", () => {
		const engine = createEngine(mockProvider([]), "m");
		engine.setSystem("sys");
		// Simulate assistant with tool call
		(engine.messages() as Array<unknown>).push({
			role: "assistant",
			content: "",
			toolCalls: [{ id: "tc1", name: "test", arguments: "{}" }],
		});
		(engine.messages() as Array<unknown>).push({
			role: "tool",
			content: "result".repeat(100),
			toolCallId: "tc1",
		});
		engine.addUser("latest");
		engine.trimToFit(100); // very tight budget
		// Should not orphan the tool result
		const hasOrphanTool = engine
			.messages()
			.some(
				(m) =>
					m.role === "tool" &&
					!engine
						.messages()
						.some(
							(a) => a.role === "assistant" && a.toolCalls?.some((tc) => tc.id === m.toolCallId),
						),
			);
		expect(hasOrphanTool).toBe(false);
	});
});
