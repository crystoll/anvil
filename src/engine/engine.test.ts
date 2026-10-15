import { okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Message, Provider, StreamChunk } from "../provider/types.js";
import type { Engine, EngineEvent } from "./engine.js";
import { createEngine } from "./engine.js";

/** Helper: create a mock provider that streams the given chunks. */
const mockProvider = (
	chunks: StreamChunk[],
	onRequest: (messages: Message[]) => void = () => undefined,
): Provider => ({
	name: "mock",
	streamChat: (_model, messages) => {
		onRequest(messages);
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

	it("repairs invalid tool history before sending a provider request", async () => {
		const requestedHistories: Message[][] = [];
		const log = vi.spyOn(console, "debug").mockImplementation(() => undefined);
		const provider = mockProvider([{ done: true }], (messages) => {
			requestedHistories.push(messages);
		});
		const engine = createEngine(provider, "test", { debug: true });
		const history: Message[] = [
			{ role: "user", content: "Read two files" },
			{
				role: "assistant",
				content: "",
				toolCalls: [
					{ id: "call-1", name: "read_file", arguments: "{}" },
					{ id: "call-2", name: "read_file", arguments: "{}" },
				],
			},
			{ role: "tool", toolCallId: "call-1", content: "first file" },
			{ role: "tool", toolCallId: "orphan", content: "stale result" },
		];
		engine.loadMessages(history);

		try {
			await collectEvents(engine.stream([]));
			expect(log).toHaveBeenCalledWith(expect.stringContaining("repaired"));
		} finally {
			log.mockRestore();
		}

		const requestedHistory = requestedHistories[0] ?? [];
		expect(requestedHistory).toEqual([
			history[0],
			history[1],
			history[2],
			{ role: "tool", toolCallId: "call-2", content: "[not executed: session was interrupted]" },
		]);
		expect(engine.messages()).toEqual([...requestedHistory, { role: "assistant", content: "" }]);
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
		expect(engine.messages().at(-1)).toMatchObject({
			role: "assistant",
			content: "start",
			status: "interrupted",
		});
	});

	it("cancels a stream even when the provider has not yielded a chunk", async () => {
		let requestCount = 0;
		let markRequestStarted: () => void = () => undefined;
		const requestStarted = new Promise<void>((resolve) => {
			markRequestStarted = resolve;
		});
		const provider: Provider = {
			...mockProvider([]),
			streamChat: (_model, _messages, _tools, opts) => {
				const requestIndex = requestCount++;
				if (requestIndex === 0) markRequestStarted();
				async function* generate() {
					if (requestIndex === 0) {
						await new Promise<void>((resolve) => {
							if (opts.signal?.aborted) resolve();
							else opts.signal?.addEventListener("abort", () => resolve(), { once: true });
						});
						yield { done: true };
						return;
					}
					yield { content: "next response", done: false };
					yield { done: true };
				}
				return okAsync(generate());
			},
		};
		const engine = createEngine(provider, "test");
		const controller = new AbortController();
		engine.addUser("first request");
		const pending = collectEvents(engine.stream([], { signal: controller.signal }));

		await requestStarted;
		expect(engine.state()).toBe("streaming");
		controller.abort();

		expect(await pending).toContainEqual({ kind: "cancelled" });
		expect(engine.state()).toBe("idle");
		engine.addUser("next request");
		expect(await collectEvents(engine.stream([]))).toContainEqual(
			expect.objectContaining({
				kind: "done",
				message: expect.objectContaining({ content: "next response" }),
			}),
		);
	});

	it("marks partial answers as errors and drops incomplete tool calls", async () => {
		const engine = createEngine(
			mockProvider([
				{ content: "partial", done: false },
				{
					toolCall: { index: 0, id: "call-1", name: "read_file", argumentsFragment: "{" },
					done: false,
				},
				{ done: true, error: { kind: "connection", message: "socket closed" } },
			]),
			"test",
		);

		const events = await collectEvents(engine.stream([]));

		expect(events.at(-1)).toEqual({
			kind: "error",
			error: { kind: "connection", message: "socket closed" },
		});
		expect(engine.messages().at(-1)).toEqual({
			role: "assistant",
			content: "partial",
			status: "error",
		});
	});

	it("marks partial answers interrupted when the consumer stops early", async () => {
		let providerClosed = false;
		const provider: Provider = {
			...mockProvider([]),
			streamChat: () => {
				async function* generate() {
					try {
						yield { content: "partial", done: false };
						await new Promise((resolve) => setTimeout(resolve, 100));
					} finally {
						providerClosed = true;
					}
				}
				return okAsync(generate());
			},
		};
		const engine = createEngine(provider, "test");
		const iterator = engine.stream([])[Symbol.asyncIterator]();

		expect((await iterator.next()).value).toMatchObject({ kind: "chunk" });
		await iterator.return?.();

		expect(providerClosed).toBe(true);
		expect(engine.state()).toBe("idle");
		expect(engine.messages().at(-1)).toEqual({
			role: "assistant",
			content: "partial",
			status: "interrupted",
		});
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

describe("commit listeners", () => {
	const recordCommits = (engine: Engine): Message[] => {
		const committed: Message[] = [];
		engine.onCommit((message) => {
			committed.push(message);
		});
		return committed;
	};

	it("hear about each user message, finished answer and tool result", async () => {
		const answer: StreamChunk[] = [{ content: "Hello", done: false }, { done: true }];
		const engine = createEngine(mockProvider(answer), "test");
		const committed = recordCommits(engine);

		engine.addUser("Hi");
		await collectEvents(engine.stream([]));
		engine.addToolResult("call_1", "file contents");

		expect(committed).toEqual([
			{ role: "user", content: "Hi" },
			{ role: "assistant", content: "Hello" },
			{ role: "tool", content: "file contents", toolCallId: "call_1" },
		]);
	});

	it("hears a partial answer that failed mid-stream", async () => {
		const dropped: StreamChunk[] = [
			{ content: "Hel", done: false },
			{ done: true, error: { kind: "connection", message: "socket hang up" } },
		];
		const engine = createEngine(mockProvider(dropped), "test");
		const committed = recordCommits(engine);

		await collectEvents(engine.stream([]));

		expect(committed).toEqual([{ role: "assistant", content: "Hel", status: "error" }]);
	});

	it("don't hear about the system prompt or replaced history", () => {
		const engine = createEngine(mockProvider([]), "test");
		const committed = recordCommits(engine);

		engine.setSystem("You are helpful");
		engine.loadMessages([{ role: "user", content: "Earlier" }]);
		engine.reset();

		expect(committed).toEqual([]);
	});

	it("stop hearing once unsubscribed", () => {
		const engine = createEngine(mockProvider([]), "test");
		const committed: Message[] = [];
		const unsubscribe = engine.onCommit((message) => {
			committed.push(message);
		});

		unsubscribe();
		engine.addUser("Hi");

		expect(committed).toEqual([]);
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

	it("uses observed token calibration when trimming history", () => {
		const engine = createEngine(mockProvider([]), "m");
		engine.setSystem("sys");
		engine.addUser("a".repeat(400));
		engine.addUser("b".repeat(400));

		expect(engine.trimToFit(300)).toBe(0);
		expect(engine.trimToFit(300, 2)).toBe(1);
		expect(engine.messages().map((message) => message.content)).toEqual(["sys", "a".repeat(400)]);
	});

	it("preserves the first user task when trimming", () => {
		const engine = createEngine(mockProvider([]), "m");
		engine.setSystem("sys");
		engine.addUser("original task");
		engine.addUser("old conversation ".repeat(100));
		engine.addUser("latest");

		engine.trimToFit(20);

		expect(engine.messages().find((message) => message.role === "user")?.content).toBe(
			"original task",
		);
	});

	it("does not leave an assistant or tool message at the start of a trimmed window", () => {
		const engine = createEngine(mockProvider([]), "m");
		engine.loadMessages([
			{ role: "assistant", content: "old answer" },
			{ role: "user", content: "original task" },
			{ role: "assistant", content: "recent answer ".repeat(30) },
		]);

		engine.trimToFit(10);

		expect(engine.messages()[0]?.role).toBe("user");
	});

	it("removes tool call + tool result as atomic pair", () => {
		const engine = createEngine(mockProvider([]), "m");
		engine.setSystem("sys");
		engine.addUser("original task");
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
		const messages = engine.messages();
		// Should not orphan the tool result
		const hasOrphanTool = messages.some(
			(m) =>
				m.role === "tool" &&
				!messages.some(
					(a) => a.role === "assistant" && a.toolCalls?.some((tc) => tc.id === m.toolCallId),
				),
		);
		expect(hasOrphanTool).toBe(false);
		const hasCall = messages.some((message) => message.role === "assistant" && message.toolCalls);
		const hasResult = messages.some((message) => message.role === "tool");
		expect(hasCall).toBe(hasResult);
	});
});
