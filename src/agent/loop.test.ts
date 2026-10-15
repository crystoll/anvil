import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine/engine.js";
import { validateHistory } from "../engine/history.js";
import type { Message, Provider, StreamChunk } from "../provider/types.js";
import type { Tool } from "../tools/registry.js";
import { createRegistry } from "../tools/registry.js";
import type { AgentEvent } from "./loop.js";
import { createAgentLoop } from "./loop.js";

/** Mock provider that returns a sequence of chunk sets (one per stream call). */
const mockProvider = (
	responses: StreamChunk[][],
	onRequest?: (messages: Message[]) => void,
): Provider => {
	let callIdx = 0;
	return {
		name: "mock",
		streamChat: (_model, messages) => {
			onRequest?.(messages);
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

const createHangingProvider = () => {
	let markStarted: () => void = () => undefined;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	let markCleanupStarted: () => void = () => undefined;
	const cleanupStarted = new Promise<void>((resolve) => {
		markCleanupStarted = resolve;
	});
	let releaseCleanup: () => void = () => undefined;
	let signal: AbortSignal | undefined;
	const provider: Provider = {
		name: "hanging",
		streamChat: (_model, _messages, _tools, options) => {
			signal = options.signal;
			return okAsync({
				[Symbol.asyncIterator]: () => ({
					next: () => {
						markStarted();
						return new Promise<IteratorResult<StreamChunk>>(() => undefined);
					},
					return: () => {
						markCleanupStarted();
						return new Promise<IteratorResult<StreamChunk>>((resolve) => {
							releaseCleanup = () => resolve({ done: true, value: undefined });
						});
					},
				}),
			});
		},
		completeChat: () => {
			throw new Error("not used");
		},
		supportsTools: () => true,
		listModels: () => okAsync([]),
	};
	return {
		provider,
		started,
		cleanupStarted,
		releaseCleanup: () => releaseCleanup(),
		signal: () => signal,
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

const multiToolCallChunks = (
	...calls: Array<{ id: string; name: string; args: string }>
): StreamChunk[] => [
	...calls.map((call, index) => ({
		toolCall: {
			index,
			id: call.id,
			name: call.name,
			argumentsFragment: call.args,
		},
		done: false,
	})),
	{ done: true },
];

const autoReadTool: Tool = {
	...dummyReadTool,
	needsApproval: false,
};

const runCmdTool: Tool = {
	...dummyReadTool,
	name: "run_cmd",
	description: "run a command",
};

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

	it("reports errors for partial streamed answers", async () => {
		const requests: Message[][] = [];
		const provider = mockProvider(
			[
				[
					{ content: "partial", done: false },
					{ done: true, error: { kind: "connection", message: "socket closed" } },
				],
			],
			(messages) => requests.push(messages),
		);
		const engine = createEngine(provider, "test");
		const loop = createAgentLoop(engine, createRegistry(), {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "You are helpful",
		});

		const events = await collect(loop.send("hi"));

		expect(events).toContainEqual({
			kind: "error",
			message: "socket closed Partial answer kept. Use /retry to try again.",
			status: "error",
		});
		expect(requests).toHaveLength(1);
		expect(engine.messages().at(-1)).toMatchObject({
			content: "partial",
			status: "error",
		});
	});

	it("retries transient failures before output and reports each backoff", async () => {
		vi.useFakeTimers();
		try {
			const requests: Message[][] = [];
			const provider = mockProvider(
				[
					[{ done: true, error: { kind: "connection", message: "connection refused" } }],
					[{ done: true, error: { kind: "api", status: 503, message: "model loading" } }],
					[{ done: true, error: { kind: "timeout", message: "model loading" } }],
					[{ content: "ready", done: false }, { done: true }],
				],
				(messages) => requests.push(messages),
			);
			const loop = createAgentLoop(createEngine(provider, "test"), createRegistry(), {
				maxRounds: 3,
				projectRoot: "/tmp",
				systemPrompt: "test",
			});

			const result = collect(loop.send("hello"));
			await vi.runAllTimersAsync();
			const events = await result;

			expect(requests).toHaveLength(4);
			expect(
				events.filter((event) => event.kind === "warning").map((event) => event.message),
			).toEqual([
				"Retrying 1/3 in 2s after connection refused",
				"Retrying 2/3 in 5s after model loading",
				"Retrying 3/3 in 15s after model loading",
			]);
			expect(events).toContainEqual({ kind: "content", text: "ready" });
			expect(events.some((event) => event.kind === "error")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not recover JSON from a user message as a tool call", async () => {
		const userInput = '{"name":"list_dir","arguments":{"path":"."}}';
		const provider = mockProvider([
			[{ done: true, error: { kind: "api", status: 400, message: "invalid request" } }],
		]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		const execute = vi.fn(async () => "file1.ts");
		registry.register({ ...listDirTool, execute });
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		const events = await collect(loop.send(userInput));

		expect(events.some((event) => event.kind === "error")).toBe(true);
		expect(execute).not.toHaveBeenCalled();
		expect(engine.messages().find((message) => message.role === "user")?.content).toBe(userInput);
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

	it("feeds the tool schema and an example back when arguments cannot be repaired", async () => {
		const requests: Message[][] = [];
		const provider = mockProvider(
			[
				toolCallChunks("call_1", "read_file", "not valid JSON"),
				[{ content: "I understand the required format", done: false }, { done: true }],
			],
			(messages) => requests.push(messages),
		);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(autoReadTool);
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 2,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		await collect(loop.send("read a file"));

		const toolResult = requests[1]?.find((message) => message.role === "tool");
		expect(toolResult?.content).toContain(JSON.stringify(autoReadTool.schema));
		expect(toolResult?.content).toContain('Example: {"path":"..."}');
	});

	it.each([
		[
			"Qwen/Hermes tool_call tags",
			'<tool_call>{"name":"read_file","arguments":{"path":"index.ts"}}</tool_call>',
		],
		["fenced JSON", '```json\n{"name":"read_file","arguments":{"path":"index.ts"}}\n```'],
		["bare JSON", '{"name":"read_file","arguments":{"path":"index.ts"}}'],
	])("recovers %s emitted as assistant text", async (_format, content) => {
		const execute = vi.fn(async () => "contents of index.ts");
		const provider = mockProvider([
			[{ content, done: false }, { done: true }],
			[{ content: "Read the file", done: false }, { done: true }],
		]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register({ ...autoReadTool, execute });
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 2,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		const events = await collect(loop.send("read index.ts"));

		expect(execute).toHaveBeenCalledWith({ path: "index.ts" }, expect.anything());
		expect(events).toContainEqual({
			kind: "tool_result",
			name: "read_file",
			result: "contents of index.ts",
		});
	});

	it("does not execute a tool call that appears only in the user message", async () => {
		const execute = vi.fn(async () => "should not run");
		const provider = mockProvider([[{ content: "I will answer normally", done: true }]]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register({ ...autoReadTool, execute });
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 2,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		await collect(
			loop.send('<tool_call>{"name":"read_file","arguments":{"path":"index.ts"}}</tool_call>'),
		);

		expect(execute).not.toHaveBeenCalled();
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

	it("allows approval while the send consumer handles a pending event", async () => {
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
		const sendRun = loop.send("read it")[Symbol.asyncIterator]();
		let result = await sendRun.next();
		while (!result.done && result.value.kind !== "pending") result = await sendRun.next();

		const events = await collect(loop.approve());
		await sendRun.next();

		expect(
			events.some((event) => event.kind === "content" && event.text === "I read the file"),
		).toBe(true);
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

	it("resumes queued tool calls in order after approval and preserves request history", async () => {
		let nextRequest: Message[] = [];
		const provider = mockProvider(
			[
				multiToolCallChunks(
					{ id: "read_1", name: "read_file", args: '{"path":"before.txt"}' },
					{ id: "cmd_1", name: "run_cmd", args: '{"path":"echo ok"}' },
					{ id: "read_2", name: "read_file", args: '{"path":"after.txt"}' },
				),
				[{ content: "Finished", done: false }, { done: true }],
			],
			(messages) => {
				nextRequest = messages;
			},
		);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(autoReadTool);
		registry.register(runCmdTool);
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		const initialEvents = await collect(loop.send("read and run"));
		const pending = initialEvents.find((event) => event.kind === "pending");
		expect(pending).toMatchObject({ index: 2, total: 3 });

		const approvalEvents = await collect(loop.approve());
		const results = approvalEvents.filter(
			(event): event is AgentEvent & { kind: "tool_result" } => event.kind === "tool_result",
		);
		const requestResults = nextRequest.filter((message) => message.role === "tool");

		expect(results.map((event) => event.name)).toEqual(["run_cmd", "read_file"]);
		expect(requestResults.map((message) => message.toolCallId)).toEqual([
			"read_1",
			"cmd_1",
			"read_2",
		]);
		expect(
			approvalEvents.some((event) => event.kind === "content" && event.text === "Finished"),
		).toBe(true);
	});

	it("cancels pending and queued tool calls with valid history", async () => {
		const provider = mockProvider([
			multiToolCallChunks(
				{ id: "read_1", name: "read_file", args: '{"path":"before.txt"}' },
				{ id: "cmd_1", name: "run_cmd", args: '{"path":"echo ok"}' },
				{ id: "read_2", name: "read_file", args: '{"path":"after.txt"}' },
			),
		]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(autoReadTool);
		registry.register(runCmdTool);
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		await collect(loop.send("read and run"));
		await loop.cancel();

		const toolResults = engine.messages().filter((message) => message.role === "tool");
		expect(toolResults.map((message) => [message.toolCallId, message.content])).toEqual([
			["read_1", "contents of before.txt"],
			["cmd_1", "[cancelled by user]"],
			["read_2", "[cancelled by user]"],
		]);
		expect(validateHistory(engine.messages()).isOk()).toBe(true);
		expect(loop.state()).toBe("idle");
	});

	it("rejects a queued tool call with a reason and continues later calls", async () => {
		let nextRequest: Message[] = [];
		const provider = mockProvider(
			[
				multiToolCallChunks(
					{ id: "read_1", name: "read_file", args: '{"path":"before.txt"}' },
					{ id: "cmd_1", name: "run_cmd", args: '{"path":"echo ok"}' },
					{ id: "read_2", name: "read_file", args: '{"path":"after.txt"}' },
				),
				[{ content: "Finished", done: false }, { done: true }],
			],
			(messages) => {
				nextRequest = messages;
			},
		);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(autoReadTool);
		registry.register(runCmdTool);
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		await collect(loop.send("read and run"));
		await collect(loop.reject("command not permitted"));

		const requestResults = nextRequest.filter((message) => message.role === "tool");
		expect(requestResults.map((message) => message.toolCallId)).toEqual([
			"read_1",
			"cmd_1",
			"read_2",
		]);
		expect(requestResults.find((message) => message.toolCallId === "cmd_1")?.content).toBe(
			"REJECTED: command not permitted",
		);
		expect(requestResults.find((message) => message.toolCallId === "read_2")?.content).toBe(
			"contents of after.txt",
		);
	});

	it("pauses at each approval-required call and reports its original position", async () => {
		const provider = mockProvider([
			multiToolCallChunks(
				{ id: "cmd_1", name: "run_cmd", args: '{"path":"one"}' },
				{ id: "cmd_2", name: "run_cmd", args: '{"path":"two"}' },
				{ id: "cmd_3", name: "run_cmd", args: '{"path":"three"}' },
			),
			[{ content: "All done", done: false }, { done: true }],
		]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(runCmdTool);
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		const firstPending = (await collect(loop.send("run three commands"))).find(
			(event) => event.kind === "pending",
		);
		const secondPending = (await collect(loop.approve())).find((event) => event.kind === "pending");
		const thirdPending = (await collect(loop.reject("skip two"))).find(
			(event) => event.kind === "pending",
		);
		const finalEvents = await collect(loop.approve());

		expect(firstPending).toMatchObject({ index: 1, total: 3 });
		expect(secondPending).toMatchObject({ index: 2, total: 3 });
		expect(thirdPending).toMatchObject({ index: 3, total: 3 });
		expect(validateHistory(engine.messages()).isOk()).toBe(true);
		expect(finalEvents.some((event) => event.kind === "content" && event.text === "All done")).toBe(
			true,
		);
	});

	it("passes round reminders only in the request that needs them", async () => {
		const requests: Message[][] = [];
		const provider = mockProvider(
			[
				...Array.from({ length: 5 }, (_, index) =>
					toolCallChunks(`call_${index}`, "list_dir", `{"path":"dir-${index}"}`),
				),
				[{ content: "Finished", done: false }, { done: true }],
			],
			(messages) => requests.push(messages),
		);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(listDirTool);
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 6,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		await collect(loop.send("do five things"));

		expect(engine.messages().some((message) => /\[(Note|Reminder)/.test(message.content))).toBe(
			false,
		);
		expect(
			requests[4]?.some(
				(message) =>
					message.role === "user" &&
					message.content === "[Note: 1 rounds remaining. Wrap up or present what you have.]",
			),
		).toBe(true);
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
		expect(validateHistory(engine.messages()).isOk()).toBe(true);
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
		expect(validateHistory(engine.messages()).isOk()).toBe(true);
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

	it("continues for another round budget after reaching the round cap", async () => {
		const requests: Message[][] = [];
		const provider = mockProvider(
			[
				toolCallChunks("call_1", "list_dir", '{"path":"."}'),
				[{ content: "Task completed", done: false }, { done: true }],
			],
			(messages) => requests.push(messages),
		);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(listDirTool);
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 1,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		const stopped = await collect(loop.send("inspect the project"));
		const continued = await collect(loop.continue());

		expect(
			stopped.some((event) => event.kind === "error" && event.message.includes("Round cap")),
		).toBe(true);
		expect(
			continued.some((event) => event.kind === "content" && event.text === "Task completed"),
		).toBe(true);
		expect(requests).toHaveLength(2);
		expect(engine.messages().filter((message) => message.role === "user")).toHaveLength(1);
		expect(loop.rounds()).toBe(1);
	});

	it("continues a response cut short by the provider output limit", async () => {
		const requests: Message[][] = [];
		const provider = mockProvider(
			[
				[{ content: "First part", finishReason: "length", done: true }],
				[{ content: "second part", finishReason: "stop", done: true }],
			],
			(messages) => requests.push(messages),
		);
		const engine = createEngine(provider, "test");
		const loop = createAgentLoop(engine, createRegistry(), {
			maxRounds: 2,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		await collect(loop.send("explain the design"));
		const continued = await collect(loop.continue());

		expect(requests).toHaveLength(2);
		expect(requests[1]).toContainEqual(
			expect.objectContaining({
				role: "user",
				synthetic: true,
				content: expect.stringContaining("Continue exactly where you left off"),
			}),
		);
		expect(continued).toContainEqual({ kind: "content", text: "second part" });
		expect(engine.messages()).toContainEqual(
			expect.objectContaining({ role: "assistant", content: "First part" }),
		);
		expect(loop.rounds()).toBe(1);
	});

	it("does not continue a turn that finished normally", async () => {
		let requestCount = 0;
		const provider = mockProvider([[{ content: "Done", finishReason: "stop", done: true }]], () => {
			requestCount++;
		});
		const engine = createEngine(provider, "test");
		const loop = createAgentLoop(engine, createRegistry(), {
			maxRounds: 2,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		await collect(loop.send("finish this"));
		const continued = await collect(loop.continue());

		expect(requestCount).toBe(1);
		expect(continued).toContainEqual(
			expect.objectContaining({
				kind: "error",
				message: expect.stringContaining("Nothing to continue"),
			}),
		);
		expect(engine.messages().filter((message) => message.role === "user")).toHaveLength(1);
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

	it("F1: answers the next message after an interrupted answer", async () => {
		const provider = mockProvider([
			[{ content: "Partial", done: false }, { content: " answer", done: false }, { done: true }],
			[{ content: "Second answer", done: false }, { done: true }],
		]);
		const engine = createEngine(provider, "test");
		const loop = createAgentLoop(engine, createRegistry(), {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		for await (const event of loop.send("first")) {
			if (event.kind === "content") loop.cancel();
		}
		const events = await collect(loop.send("second"));

		expect(events.some((e) => e.kind === "content" && e.text === "Second answer")).toBe(true);
	});

	it("awaits stream cleanup when cancelling an active turn", async () => {
		const hanging = createHangingProvider();
		const engine = createEngine(hanging.provider, "test");
		const loop = createAgentLoop(engine, createRegistry(), {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});
		const activeRun = collect(loop.send("first"));
		await hanging.started;

		let cancellationSettled = false;
		const cancellation = loop.cancel().then(() => {
			cancellationSettled = true;
		});
		expect(hanging.signal()?.aborted).toBe(true);
		expect(cancellationSettled).toBe(false);
		await hanging.cleanupStarted;

		hanging.releaseCleanup();
		await cancellation;
		await activeRun;
		expect(loop.state()).toBe("idle");
	});

	it("aborts active tool execution and records a cancellation result", async () => {
		let markStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let toolSignal: AbortSignal | undefined;
		const tool: Tool = {
			...listDirTool,
			execute: async (_args, context) => {
				toolSignal = context.signal;
				markStarted();
				return new Promise<string>(() => undefined);
			},
		};
		const engine = createEngine(
			mockProvider([toolCallChunks("call_1", "list_dir", '{"path":"."}')]),
			"test",
		);
		const registry = createRegistry();
		registry.register(tool);
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});
		const activeRun = collect(loop.send("list files"));
		await started;

		await loop.cancel();
		const events = await activeRun;

		expect(toolSignal?.aborted).toBe(true);
		expect(events).toContainEqual({
			kind: "tool_result",
			name: "list_dir",
			result: "[cancelled by user]",
		});
		expect(validateHistory(engine.messages()).isOk()).toBe(true);
		expect(loop.state()).toBe("idle");
	});

	it("stops later calls and completes every tool result when cancelling a tool queue", async () => {
		let markStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let executionCount = 0;
		const tool: Tool = {
			...listDirTool,
			execute: async () => {
				executionCount++;
				markStarted();
				return new Promise<string>(() => undefined);
			},
		};
		const provider = mockProvider([
			multiToolCallChunks(
				{ id: "call_1", name: "list_dir", args: '{"path":"one"}' },
				{ id: "call_2", name: "list_dir", args: '{"path":"two"}' },
				{ id: "call_3", name: "list_dir", args: '{"path":"three"}' },
			),
		]);
		const engine = createEngine(provider, "test");
		const registry = createRegistry();
		registry.register(tool);
		const loop = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});
		const activeRun = collect(loop.send("list three directories"));
		await started;
		const startedAt = Date.now();

		await loop.cancel();
		const events = await activeRun;
		const results = engine.messages().filter((message) => message.role === "tool");

		expect(Date.now() - startedAt).toBeLessThan(1000);
		expect(executionCount).toBe(1);
		expect(results.map((result) => result.toolCallId)).toEqual(["call_1", "call_2", "call_3"]);
		expect(results.every((result) => result.content === "[cancelled by user]")).toBe(true);
		expect(events.filter((event) => event.kind === "tool_result")).toHaveLength(1);
		expect(validateHistory(engine.messages()).isOk()).toBe(true);
	});

	it("does not cancel the engine when no agent turn is active", async () => {
		const engine = createEngine(mockProvider([]), "test");
		const cancelEngine = vi.spyOn(engine, "cancel");
		const loop = createAgentLoop(engine, createRegistry(), {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});

		await loop.cancel();

		expect(cancelEngine).not.toHaveBeenCalled();
	});

	it("reports idle after five seconds but blocks overlapping turns until cleanup", async () => {
		vi.useFakeTimers();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const hanging = createHangingProvider();
			const engine = createEngine(hanging.provider, "test");
			const loop = createAgentLoop(engine, createRegistry(), {
				maxRounds: 5,
				projectRoot: "/tmp",
				systemPrompt: "test",
			});
			const activeRun = collect(loop.send("first"));
			await hanging.started;
			const cancellation = loop.cancel();
			await hanging.cleanupStarted;

			await vi.advanceTimersByTimeAsync(5000);
			await cancellation;
			expect(loop.state()).toBe("idle");
			expect(warning).toHaveBeenCalledWith("anvil: cancellation did not finish within 5 seconds");
			expect(await collect(loop.send("second"))).toContainEqual({
				kind: "error",
				message: "An agent turn is already active",
			});

			hanging.releaseCleanup();
			await activeRun;
		} finally {
			warning.mockRestore();
			vi.useRealTimers();
		}
	});

	it("rejects a concurrent turn without changing conversation history", async () => {
		const hanging = createHangingProvider();
		const engine = createEngine(hanging.provider, "test");
		const loop = createAgentLoop(engine, createRegistry(), {
			maxRounds: 5,
			projectRoot: "/tmp",
			systemPrompt: "test",
		});
		const activeRun = collect(loop.send("first"));
		await hanging.started;

		const rejectedRun = await collect(loop.send("second"));
		expect(rejectedRun).toContainEqual({
			kind: "error",
			message: "An agent turn is already active",
		});
		expect(engine.messages().filter((message) => message.role === "user")).toEqual([
			{ role: "user", content: "first" },
		]);

		const cancellation = loop.cancel();
		await hanging.cleanupStarted;
		hanging.releaseCleanup();
		await cancellation;
		await activeRun;
	});

	it("keeps the tool's own result when post-processing throws", async () => {
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
			transformToolResult: async () => {
				throw new Error("LSP crashed");
			},
		});

		await collect(loop.send("read it"));
		const events = await collect(loop.approve());

		expect(events).toContainEqual({
			kind: "tool_result",
			name: "read_file",
			result: "contents of index.ts",
		});
		expect(events).toContainEqual({
			kind: "warning",
			message: expect.stringContaining("LSP crashed"),
		});
		expect(events.some((e) => e.kind === "content" && e.text === "I read the file")).toBe(true);
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
	expect(
		engine.messages().find((message) => message.role === "user" && message.synthetic)?.synthetic,
	).toBe(true);
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

it("nudges once when the assistant response is empty", async () => {
	const requests: Message[][] = [];
	const provider = mockProvider(
		[[{ done: true }], [{ content: "answer", done: false }, { done: true }]],
		(messages) => requests.push(messages),
	);
	const engine = createEngine(provider, "test");
	const loop = createAgentLoop(engine, createRegistry(), {
		maxRounds: 5,
		projectRoot: "/tmp",
		systemPrompt: "test",
	});

	await collect(loop.send("do something"));

	expect(requests).toHaveLength(2);
	expect(requests[1]?.find((message) => message.synthetic)?.content).toContain(
		"Your response was empty",
	);
	expect(
		engine.messages().filter((message) => message.role === "user" && message.synthetic),
	).toHaveLength(1);
});

it("does not nudge while a tool call awaits approval", async () => {
	const requests: Message[][] = [];
	const provider = mockProvider(
		[toolCallChunks("call_1", "read_file", '{"path":"file.txt"}')],
		(messages) => requests.push(messages),
	);
	const engine = createEngine(provider, "test");
	const registry = createRegistry();
	registry.register(dummyReadTool);
	const loop = createAgentLoop(engine, registry, {
		maxRounds: 5,
		projectRoot: "/tmp",
		systemPrompt: "test",
	});

	const events = await collect(loop.send("read the file"));

	expect(events.some((event) => event.kind === "pending")).toBe(true);
	expect(requests).toHaveLength(1);
	expect(engine.messages().some((message) => message.synthetic)).toBe(false);
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
	const requests: Message[][] = [];
	const provider = mockProvider(
		[
			toolCallChunks("c1", "list_dir", '{"path":"a"}'),
			toolCallChunks("c2", "list_dir", '{"path":"b"}'),
			toolCallChunks("c3", "list_dir", '{"path":"c"}'),
			toolCallChunks("c4", "list_dir", '{"path":"d"}'),
			[{ content: "Done wrapping up", done: false }, { done: true }],
		],
		(messages) => requests.push(messages),
	);
	const engine = createEngine(provider, "test");
	const registry = createRegistry();
	registry.register(listDirTool);

	const loop = createAgentLoop(engine, registry, {
		maxRounds: 5,
		projectRoot: "/tmp",
		systemPrompt: "test",
	});

	await collect(loop.send("keep going"));

	expect(engine.messages().some((message) => message.content.includes("rounds remaining"))).toBe(
		false,
	);
	expect(
		requests[3]?.some(
			(message) =>
				message.role === "user" &&
				message.content === "[Note: 1 rounds remaining. Wrap up or present what you have.]",
		),
	).toBe(true);
});

it("injects goal reminder into the request every 5 rounds after round 5", async () => {
	const requests: Message[][] = [];
	const provider = mockProvider(
		[
			...Array.from({ length: 10 }, (_, i) =>
				toolCallChunks(`c${i}`, "list_dir", `{"path":"${String.fromCharCode(97 + i)}"}`),
			),
			[{ content: "All done", done: false }, { done: true }],
		],
		(messages) => requests.push(messages),
	);
	const engine = createEngine(provider, "test");
	const registry = createRegistry();
	registry.register(listDirTool);

	const loop = createAgentLoop(engine, registry, {
		maxRounds: 25,
		projectRoot: "/tmp",
		systemPrompt: "test",
	});

	await collect(loop.send("find all TODO comments and summarize them"));

	expect(engine.messages().some((message) => message.content.includes("Reminder"))).toBe(false);
	expect(
		requests[9]?.some(
			(message) =>
				message.role === "user" &&
				message.content ===
					"[Reminder — your current task: find all TODO comments and summarize them]",
		),
	).toBe(true);
});

it("auto-compacts on overflow and retries", async () => {
	let callIdx = 0;
	const provider: Provider = {
		name: "mock",
		streamChat: () => {
			callIdx++;
			async function* gen() {
				if (callIdx === 1) {
					yield {
						content: "Potentially truncated output",
						done: true,
						usage: { promptTokens: 31_130, totalTokens: 31_131 },
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

it("proactively compacts after a final chunk reports 80% context usage", async () => {
	const provider: Provider = {
		...mockProvider([
			[
				{ content: "Finished", done: false },
				{ done: true, usage: { promptTokens: 800, totalTokens: 820 } },
			],
		]),
		completeChat: vi.fn(() => okAsync({ content: "Conversation summary", toolCalls: [] })),
	};
	const engine = createEngine(provider, "test");
	engine.loadMessages([
		{ role: "user", content: "Original task" },
		{ role: "assistant", content: "Old response" },
		{ role: "user", content: "Question one" },
		{ role: "assistant", content: "Answer one" },
		{ role: "user", content: "Question two" },
		{ role: "assistant", content: "Answer two" },
		{ role: "user", content: "Latest question" },
		{ role: "assistant", content: "Latest answer" },
	]);
	const loop = createAgentLoop(engine, createRegistry(), {
		maxRounds: 2,
		projectRoot: "/tmp",
		systemPrompt: "test",
		provider,
		streamOpts: { contextSize: 1000 },
	});

	const events = await collect(loop.send("hello"));

	expect(provider.completeChat).toHaveBeenCalledOnce();
	expect(events.map((event) => event.kind)).toContain("compacted");
	expect(events.some((event) => event.kind === "content" && event.text === "Finished")).toBe(true);
});

it("calibrates history trimming from provider-reported prompt usage", async () => {
	const requests: Message[][] = [];
	let streamCount = 0;
	const provider: Provider = {
		name: "mock",
		streamChat: (_model, messages) => {
			requests.push(messages);
			streamCount++;
			async function* chunks() {
				if (streamCount === 1) {
					yield {
						toolCall: {
							index: 0,
							id: "call-1",
							name: "list_dir",
							argumentsFragment: '{"path":"."}',
						},
						done: false,
					} satisfies StreamChunk;
					yield { done: true, usage: { promptTokens: 3_199, totalTokens: 3_201 } };
					return;
				}
				yield { content: "Finished", done: false };
				yield { done: true, usage: { promptTokens: 1_000, totalTokens: 1_001 } };
			}
			return okAsync(chunks());
		},
		completeChat: () => okAsync({ content: "Unused", toolCalls: [] }),
		supportsTools: () => true,
		listModels: () => okAsync([]),
	};
	const engine = createEngine(provider, "test");
	engine.loadMessages([
		{ role: "user", content: "task".repeat(300) },
		{ role: "assistant", content: "old".repeat(1_200) },
		{ role: "user", content: "question".repeat(100) },
		{ role: "assistant", content: "answer".repeat(300) },
		{ role: "user", content: "more".repeat(200) },
		{ role: "assistant", content: "history".repeat(200) },
	]);
	const registry = createRegistry();
	registry.register({
		...listDirTool,
		execute: async () => "tool result ".repeat(125),
	});
	const loop = createAgentLoop(engine, registry, {
		maxRounds: 3,
		projectRoot: "/tmp",
		systemPrompt: "test",
		provider,
		streamOpts: { contextSize: 4_000 },
	});

	await collect(loop.send("hello"));

	expect(streamCount).toBe(2);
	expect(requests[0]?.some((message) => message.content.startsWith("old".repeat(100)))).toBe(true);
	expect(requests[1]?.some((message) => message.content.startsWith("old".repeat(100)))).toBe(false);
});

it("uses live prompt, provider, and context size after switching settings", async () => {
	const requests: Message[][] = [];
	const oldProvider: Provider = {
		...mockProvider([]),
		completeChat: vi.fn(() => okAsync({ content: "Old summary", toolCalls: [] })),
	};
	const activeProvider: Provider = {
		...mockProvider(
			[
				[
					{
						error: { kind: "api", status: 400, message: "prompt exceeds max context length" },
						done: true,
					},
				],
				[{ content: "Recovered after compaction", done: false }, { done: true }],
			],
			(messages) => requests.push(messages),
		),
		completeChat: vi.fn(() => okAsync({ content: "Current summary", toolCalls: [] })),
	};
	const engine = createEngine(oldProvider, "test");
	engine.setProvider(activeProvider);
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
	const loop = createAgentLoop(engine, createRegistry(), {
		maxRounds: 5,
		projectRoot: "/tmp",
		systemPrompt: "boot prompt",
		provider: oldProvider,
		getSystemPrompt: () => "live skill prompt",
		getProvider: () => engine.getProvider(),
		getContextSize: () => 32768,
	});

	const events = await collect(loop.send("continue"));

	expect(requests[0]?.[0]).toMatchObject({ role: "system", content: "live skill prompt" });
	expect(activeProvider.completeChat).toHaveBeenCalledOnce();
	expect(oldProvider.completeChat).not.toHaveBeenCalled();
	expect(
		events.some((event) => event.kind === "content" && event.text === "Recovered after compaction"),
	).toBe(true);
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
	expect(events.some((event) => event.kind === "warning" && event.message.includes("failed"))).toBe(
		true,
	);
	// Should not infinitely loop — stops at round cap
	expect(callIdx).toBeLessThanOrEqual(2);
});
