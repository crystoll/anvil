import { okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import { createEngine } from "../engine/engine.js";
import type { Provider, StreamChunk } from "../provider/types.js";
import { createRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/registry.js";
import { createAgentLoop } from "./loop.js";
import type { AgentEvent } from "./loop.js";

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
