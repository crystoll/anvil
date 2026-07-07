import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { createEngine } from "../engine/engine.js";
import type { Provider, StreamChunk } from "../provider/types.js";
import type { Tool } from "../tools/registry.js";
import { createRegistry } from "../tools/registry.js";
import type { AgentEvent } from "./loop.js";
import { createAgentLoop } from "./loop.js";

/** Mock provider that returns a sequence of chunk sets (one per stream call). */
const mockProvider = (responses: StreamChunk[][]): Provider => {
	let callIdx = 0;
	return {
		name: "mock",
		streamChat: () => {
			const chunks = responses[callIdx] ?? [{ done: true }];
			callIdx++;
			async function* gen() {
				for (const c of chunks) yield c;
			}
			return okAsync(gen());
		},
		completeChat: () => {
			throw new Error("not used");
		},
		supportsTools: () => true,
		listModels: () => okAsync([]),
	};
};

const collect = async (iter: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
	const events: AgentEvent[] = [];
	for await (const e of iter) events.push(e);
	return events;
};

const dummyReadTool: Tool = {
	name: "read_file",
	description: "read a file",
	schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	needsApproval: true,
	timeout: 5000,
	execute: async (args) => `contents of ${args.path}`,
};

const listDirTool: Tool = {
	name: "list_dir",
	description: "list dir",
	schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	needsApproval: false,
	timeout: 5000,
	execute: async () => "file1.ts\nfile2.ts",
};

/** Tool call chunk helper */
const toolCallChunks = (id: string, name: string, args: string): StreamChunk[] => [
	{ toolCall: { index: 0, id, name, argumentsFragment: args }, done: false },
	{ done: true },
];

describe("agent loop", () => {
	it("streams content when no tool calls are made", async () => {
		const provider = mockProvider([[{ content: "Hello!", done: false }, { done: true }]]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "You are helpful",
		});

		const events = await collect(loop.send("hi"));

		expect(events.some((e) => e.kind === "content" && e.text === "Hello!")).toBe(true);
		expect(loop.state()).toBe("idle");
	});

	it("pauses on approval-required tool call", async () => {
		const provider = mockProvider([
			toolCallChunks("call_1", "read_file", '{"path":"src/index.ts"}'),
		]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(dummyReadTool);

		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		const events = await collect(loop.send("read the file"));

		expect(loop.state()).toBe("pending");
		expect(loop.pending()?.tool.name).toBe("read_file");
		expect(events.some((e) => e.kind === "pending")).toBe(true);
	});

	it("executes tool after approval and continues", async () => {
		const provider = mockProvider([
			toolCallChunks("call_1", "read_file", '{"path":"index.ts"}'),
			[{ content: "I read the file", done: false }, { done: true }],
		]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(dummyReadTool);

		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		await collect(loop.send("read it"));
		expect(loop.state()).toBe("pending");

		const events = await collect(loop.approve());

		expect(events.some((e) => e.kind === "tool_result")).toBe(true);
		expect(events.some((e) => e.kind === "content" && e.text === "I read the file")).toBe(true);
		expect(loop.state()).toBe("idle");
	});

	it("executes non-approval tools automatically", async () => {
		const provider = mockProvider([
			toolCallChunks("call_1", "list_dir", '{"path":"."}'),
			[{ content: "Found files", done: false }, { done: true }],
		]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(listDirTool);

		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		const events = await collect(loop.send("list files"));

		expect(events.some((e) => e.kind === "tool_result" && e.name === "list_dir")).toBe(true);
		expect(loop.state()).toBe("idle");
	});

	it("handles done signal", async () => {
		const provider = mockProvider([toolCallChunks("call_1", "done", '{"message":"All finished"}')]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();

		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		const events = await collect(loop.send("do stuff"));

		expect(events.some((e) => e.kind === "done" && e.message === "All finished")).toBe(true);
		expect(loop.state()).toBe("done");
	});

	it("handles stuck signal", async () => {
		const provider = mockProvider([
			toolCallChunks("call_1", "stuck", '{"message":"I cannot proceed"}'),
		]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();

		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		const events = await collect(loop.send("do something impossible"));

		expect(events.some((e) => e.kind === "stuck" && e.message === "I cannot proceed")).toBe(true);
		expect(loop.state()).toBe("stuck");
	});

	it("enforces round cap", async () => {
		// Provider always returns a non-approval tool call → infinite loop without cap
		const provider = mockProvider(
			Array.from({ length: 5 }, () => toolCallChunks("call_x", "list_dir", '{"path":"."}')),
		);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(listDirTool);

		const loop = createAgentLoop(engine, registry, {
			maxRounds: 3,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		const events = await collect(loop.send("keep going"));

		expect(events.some((e) => e.kind === "error" && e.message.includes("Round cap"))).toBe(true);
		expect(loop.rounds()).toBe(3);
	});

	it("handles rejection and continues", async () => {
		const provider = mockProvider([
			toolCallChunks("call_1", "read_file", '{"path":"secret.env"}'),
			[{ content: "OK, skipping that", done: false }, { done: true }],
		]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(dummyReadTool);

		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		await collect(loop.send("read secret"));
		expect(loop.state()).toBe("pending");

		const events = await collect(loop.reject("Not allowed"));

		expect(events.some((e) => e.kind === "content")).toBe(true);
		expect(loop.state()).toBe("idle");
	});
});

it("nudges model when it gives up without trying tools", async () => {
	const provider = mockProvider([
		// First response: model gives up
		[{ content: "I'm unable to access the filesystem.", done: false }, { done: true }],
		// After nudge: model uses tool
		toolCallChunks("call_1", "list_dir", '{"path":"."}'),
		// Final response after tool
		[{ content: "Found files", done: false }, { done: true }],
	]);
	const engine = createEngine(provider, "test");
	const registry = createRegistry();
	registry.register(listDirTool);

	const loop = createAgentLoop(engine, registry, {
		maxRounds: 5,
		projectRoot: "/tmp",
		systemPrompt: "test",
	});

	const events = await collect(loop.send("list the files"));

	expect(events.some((e) => e.kind === "tool_result" && e.name === "list_dir")).toBe(true);
	expect(loop.state()).toBe("idle");
});

it("does not nudge more than once per give-up", async () => {
	const provider = mockProvider([
		// First response: gives up
		[{ content: "I cannot do this.", done: false }, { done: true }],
		// After nudge: gives up again
		[{ content: "Unfortunately I still can't.", done: false }, { done: true }],
	]);
	const engine = createEngine(provider, "test");
	const registry = createRegistry();
	registry.register(listDirTool);

	const loop = createAgentLoop(engine, registry, {
		maxRounds: 5,
		projectRoot: "/tmp",
		systemPrompt: "test",
	});

	await collect(loop.send("do something"));

	// Should exit idle after one nudge attempt, not loop forever
	expect(loop.state()).toBe("idle");
	expect(loop.rounds()).toBe(2);
});

it("detects stall when same tool+args called 3 times", async () => {
	const provider = mockProvider([
		toolCallChunks("c1", "list_dir", '{"path":"."}'),
		toolCallChunks("c2", "list_dir", '{"path":"."}'),
		toolCallChunks("c3", "list_dir", '{"path":"."}'),
		// After stall injection, model responds with content
		[{ content: "Let me try differently", done: false }, { done: true }],
	]);
	const engine = createEngine(provider, "test");
	const registry = createRegistry();
	registry.register(listDirTool);

	const loop = createAgentLoop(engine, registry, {
		maxRounds: 10,
		projectRoot: "/tmp",
		systemPrompt: "test",
	});

	const events = await collect(loop.send("keep listing"));

	// Third call should NOT produce a tool_result from execution
	const toolResults = events.filter((e) => e.kind === "tool_result");
	expect(toolResults).toHaveLength(2); // Only first two actually execute
	expect(loop.state()).toBe("idle");
});

it("injects budget warning at 80% of rounds", async () => {
	// 5 rounds max, 80% = round 4. We need 4 rounds of tool calls + final content.
	const provider = mockProvider([
		toolCallChunks("c1", "list_dir", '{"path":"a"}'),
		toolCallChunks("c2", "list_dir", '{"path":"b"}'),
		toolCallChunks("c3", "list_dir", '{"path":"c"}'),
		toolCallChunks("c4", "list_dir", '{"path":"d"}'),
		[{ content: "Done wrapping up", done: false }, { done: true }],
	]);
	const engine = createEngine(provider, "test");
	const registry = createRegistry();
	registry.register(listDirTool);

	const loop = createAgentLoop(engine, registry, {
		maxRounds: 5,
		projectRoot: "/tmp",
		systemPrompt: "test",
	});

	await collect(loop.send("keep going"));

	// At round 4 (80%), a budget warning should have been injected as user message
	const messages = engine.messages();
	const budgetMsg = messages.find(
		(m) => m.role === "user" && (m.content ?? "").includes("rounds remaining"),
	);
	expect(budgetMsg).toBeDefined();
});

it("injects goal reminder every 5 rounds after round 5", async () => {
	// Need 10+ rounds to trigger goal echo (fires when rounds > 5 && rounds % 5 === 0)
	const provider = mockProvider([
		...Array.from({ length: 10 }, (_, i) =>
			toolCallChunks(`c${i}`, "list_dir", `{"path":"${String.fromCharCode(97 + i)}"}`),
		),
		[{ content: "All done", done: false }, { done: true }],
	]);
	const engine = createEngine(provider, "test");
	const registry = createRegistry();
	registry.register(listDirTool);

	const loop = createAgentLoop(engine, registry, {
		maxRounds: 25,
		projectRoot: "/tmp",
		systemPrompt: "test",
	});

	await collect(loop.send("find all TODO comments and summarize them"));

	const messages = engine.messages();
	const goalReminder = messages.find(
		(m) => m.role === "user" && (m.content ?? "").includes("Reminder"),
	);
	expect(goalReminder).toBeDefined();
	expect(goalReminder?.content).toContain("find all TODO comments");
});

it("auto-compacts on overflow and retries", async () => {
	let callIdx = 0;
	const provider: Provider = {
		name: "mock",
		streamChat: () => {
			callIdx++;
			async function* gen() {
				if (callIdx === 1) {
					// First call: simulate overflow (finish_reason: length + no content = context full)
					yield {
						content: "",
						finishReason: "length",
						done: true,
						usage: { promptTokens: 30000, totalTokens: 30001 },
					} satisfies StreamChunk;
				} else {
					// After compaction: normal response
					yield { content: "Success after compaction", done: false } satisfies StreamChunk;
					yield {
						done: true,
						usage: { promptTokens: 5000, totalTokens: 5100 },
					} satisfies StreamChunk;
				}
			}
			return okAsync(gen());
		},
		completeChat: () => okAsync({ content: "Summary of conversation.", toolCalls: [] }),
		supportsTools: () => true,
		listModels: () => okAsync([]),
	};

	const engine = createEngine(provider, "test");
	const registry = createRegistry();
	// Seed enough messages so compaction is worthwhile
	engine.addUser("First message");
	engine.loadMessages([
		{ role: "user", content: "msg1" },
		{ role: "assistant", content: "resp1" },
		{ role: "user", content: "msg2" },
		{ role: "assistant", content: "resp2" },
		{ role: "user", content: "msg3" },
		{ role: "assistant", content: "resp3" },
		{ role: "user", content: "msg4" },
		{ role: "assistant", content: "resp4" },
	]);

	const loop = createAgentLoop(engine, registry, {
		maxRounds: 5,
		projectRoot: "/tmp",
		systemPrompt: "test",
		provider,
		streamOpts: { contextSize: 32768 },
	});

	const events = await collect(loop.send("hello"));
	const kinds = events.map((e) => e.kind);

	expect(kinds).toContain("overflow");
	expect(kinds).toContain("compacting");
	expect(kinds).toContain("compacted");
	expect(kinds).toContain("content");
});

it("continues without retry when compaction fails", async () => {
	let callIdx = 0;
	const provider: Provider = {
		name: "mock",
		streamChat: () => {
			callIdx++;
			async function* gen() {
				// Always overflow
				yield {
					content: "",
					finishReason: "length",
					done: true,
					usage: { promptTokens: 30000, totalTokens: 30001 },
				} satisfies StreamChunk;
			}
			return okAsync(gen());
		},
		completeChat: () =>
			errAsync({ kind: "api" as const, status: 500, message: "model overloaded" }),
		supportsTools: () => true,
		listModels: () => okAsync([]),
	};

	const engine = createEngine(provider, "test");
	const registry = createRegistry();
	engine.loadMessages([
		{ role: "user", content: "msg1" },
		{ role: "assistant", content: "resp1" },
		{ role: "user", content: "msg2" },
		{ role: "assistant", content: "resp2" },
		{ role: "user", content: "msg3" },
		{ role: "assistant", content: "resp3" },
		{ role: "user", content: "msg4" },
		{ role: "assistant", content: "resp4" },
	]);

	const loop = createAgentLoop(engine, registry, {
		maxRounds: 2,
		projectRoot: "/tmp",
		systemPrompt: "test",
		provider,
		streamOpts: { contextSize: 32768 },
	});

	const events = await collect(loop.send("hello"));
	const kinds = events.map((e) => e.kind);

	// Should detect overflow and attempt compaction but not crash
	expect(kinds).toContain("overflow");
	expect(kinds).toContain("compacting");
	// Should NOT have compacted (it failed)
	expect(kinds).not.toContain("compacted");
	// Should not infinitely loop — stops at round cap
	expect(callIdx).toBeLessThanOrEqual(2);
});
