import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentLoop } from "../agent/loop.js";
import { createEngine } from "../engine/engine.js";
import { createOllamaProvider } from "../provider/ollama-native.js";
import { createSessionWriter } from "../session/writer.js";
import { startMockOllama } from "../test-support/mock-ollama.js";
import type { MockStreamServer, StreamFaultScript } from "../test-support/mock-stream-server.js";
import { createRegistry, type Tool } from "../tools/registry.js";
import { type AppCommandContext, createAppCommandRegistry } from "./app-commands.js";
import { createSessionController, type SessionController } from "./controller.js";

const servers: MockStreamServer[] = [];
const directories: string[] = [];
const controllers: SessionController[] = [];

const assistantFrames = (content: string) => [
	{ message: { role: "assistant", content }, done: false },
	{
		message: { role: "assistant", content: "" },
		done: true,
		prompt_eval_count: 10,
		eval_count: 5,
	},
];

const waitForRequests = async (server: MockStreamServer, count: number): Promise<void> => {
	await vi.waitFor(() => expect(server.requests).toHaveLength(count));
};

const createHarness = async (
	script: StreamFaultScript,
	tools: Tool[] = [],
	shutdown: () => Promise<void> = async () => undefined,
) => {
	const historyDir = mkdtempSync(join(tmpdir(), "anvil-controller-test-"));
	directories.push(historyDir);
	const mock = await startMockOllama(script);
	servers.push(mock);
	const provider = createOllamaProvider("ollama", {
		endpoint: mock.endpoint,
		streamTimeout: 5,
	});
	const engine = createEngine(provider, "test-model");
	const session = createSessionWriter(historyDir, engine.messages);
	engine.onCommit(() => session.save());
	const registry = createRegistry();
	for (const tool of tools) registry.register(tool);
	const agent = createAgentLoop(engine, registry, {
		maxRounds: 5,
		projectRoot: historyDir,
		systemPrompt: "Test system prompt",
		provider,
	});
	const controller = createSessionController({
		agent,
		engine,
		session,
		shutdown,
	});
	controllers.push(controller);
	return { controller, engine, historyDir, mock, session };
};

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(controllers.splice(0).map((controller) => controller.shutdown()));
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("session controller", () => {
	it("streams a real agent turn and persists committed messages", async () => {
		const { controller, engine, historyDir } = await createHarness({
			frames: assistantFrames("answer"),
		});
		const events: Array<{ type: string; kind?: string }> = [];
		controller.subscribe((event) => {
			events.push({
				type: event.type,
				...(event.type === "agent" ? { kind: event.event.kind } : {}),
			});
		});

		await controller.submit("question");

		expect(events).toContainEqual({ type: "agent", kind: "content" });
		expect(controller.getState()).toMatchObject({
			phase: "idle",
			model: "test-model",
			tokens: { promptTokens: 10, totalTokens: 15 },
			streamingText: "answer",
		});
		expect(engine.messages().map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
		]);
		expect(controller.getState().sessionId).toBeDefined();
		const sessionId = controller.getState().sessionId;
		if (!sessionId) throw new Error("session should be saved after the turn");
		expect(
			JSON.parse(readFileSync(join(historyDir, `${sessionId}.json`), "utf-8")).messages,
		).toHaveLength(3);

		await controller.shutdown();
	});

	it("rejects overlapping submits, then accepts a new turn after cancellation", async () => {
		const { controller, engine, mock } = await createHarness({
			frames: [{ message: { role: "assistant", content: "partial" }, done: false }],
			stallAfter: 1,
		});
		const notices: string[] = [];
		controller.subscribe((event) => {
			if (event.type === "notice") notices.push(event.message);
		});

		const pendingTurn = controller.submit("first request");
		await waitForRequests(mock, 1);
		await controller.submit("overlapping request");

		expect(notices).toContain("Cannot submit while a turn is active");
		expect(engine.messages().filter((message) => message.role === "user")).toHaveLength(1);

		await controller.cancel();
		expect(controller.getState()).toMatchObject({ phase: "idle", pending: undefined });
		await pendingTurn;
		await mock.clientDisconnected;

		mock.setScript({ frames: assistantFrames("follow-up works") });
		await controller.submit("follow-up");

		expect(mock.requests).toHaveLength(2);
		expect(controller.getState()).toMatchObject({
			phase: "idle",
			streamingText: "follow-up works",
		});
		await controller.shutdown();
	});

	it("can cancel from the streaming state notification before a request starts", async () => {
		const { controller, mock } = await createHarness({
			frames: assistantFrames("should not be requested"),
		});
		let cancellation: Promise<void> | undefined;
		controller.subscribe((event) => {
			if (event.type === "state" && event.state.phase === "streaming" && !cancellation)
				cancellation = controller.cancel();
		});

		const submit = controller.submit("cancel immediately");
		await vi.waitFor(() => expect(cancellation).toBeDefined());
		if (!cancellation) throw new Error("streaming state should request cancellation");
		await Promise.all([submit, cancellation]);

		expect(mock.requests).toHaveLength(0);
		expect(controller.getState().phase).toBe("idle");
	});

	it("waits for cancellation before shutting down and rejects later submits", async () => {
		const shutdown = vi.fn(async () => undefined);
		const { controller, mock } = await createHarness(
			{
				frames: [{ message: { role: "assistant", content: "partial" }, done: false }],
				stallAfter: 1,
			},
			[],
			shutdown,
		);
		const pendingTurn = controller.submit("request");
		await waitForRequests(mock, 1);

		await controller.shutdown();
		await pendingTurn;
		await mock.clientDisconnected;
		await controller.submit("after shutdown");

		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(controller.getState().phase).toBe("idle");
		expect(mock.requests).toHaveLength(1);
	});

	it("applies model, skill, and agent changes to the next request", async () => {
		const historyDir = mkdtempSync(join(tmpdir(), "anvil-controller-test-"));
		directories.push(historyDir);
		const mock = await startMockOllama({ frames: assistantFrames("answer") });
		servers.push(mock);
		const provider = createOllamaProvider("ollama", {
			endpoint: mock.endpoint,
			streamTimeout: 5,
		});
		const engine = createEngine(provider, "old-model");
		const session = createSessionWriter(historyDir, engine.messages);
		engine.onCommit(() => session.save());
		const registry = createRegistry();
		const skill = { name: "review", description: "Review code", body: "skill prompt" };
		const agentDefinition = { name: "reviewer", tools: [], prompt: "agent prompt" };
		const context: AppCommandContext = {
			config: {
				providers: { ollama: { endpoint: mock.endpoint } },
				contextSize: 4096,
				connectTimeout: 1,
				streamTimeout: 5,
			},
			engine,
			registry,
			activeProviderName: "ollama",
			healthyProviders: new Map([["ollama", { status: "healthy" as const }]]),
			availableSkills: [skill],
			activeSkill: undefined,
			availableAgents: [agentDefinition],
			activeAgent: undefined,
			historyDir,
			session,
			setActiveSkill: () => undefined,
			setActiveAgent: () => undefined,
		};
		const originalFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
			String(input).endsWith("/api/tags")
				? Promise.resolve(new Response(null, { status: 200 }))
				: originalFetch(input, init),
		);
		const getSystemPrompt = () =>
			[context.activeAgent?.prompt, context.activeSkill?.body, "base prompt"]
				.filter(Boolean)
				.join("\n");
		const agent = createAgentLoop(engine, registry, {
			maxRounds: 5,
			projectRoot: historyDir,
			systemPrompt: "base prompt",
			getSystemPrompt,
			provider,
			getProvider: engine.getProvider,
		});
		const controller = createSessionController({
			agent,
			engine,
			session,
			commands: createAppCommandRegistry(context),
			shutdown: async () => undefined,
		});
		controllers.push(controller);

		await controller.submit("/model smaller-model");
		await controller.submit("/skill review");
		await controller.submit("/agent reviewer");
		await controller.submit("question");

		expect(mock.requests).toHaveLength(1);
		expect(mock.requests[0]).toMatchObject({
			model: "smaller-model",
			messages: [
				{ role: "system", content: "agent prompt\nskill prompt\nbase prompt" },
				{ role: "user", content: "question" },
			],
		});
	});

	it("remembers approve always for later calls in the same tool queue", async () => {
		const tool: Tool = {
			name: "write_file",
			description: "write a file",
			schema: { type: "object", properties: {} },
			needsApproval: true,
			timeout: 1000,
			execute: vi.fn(async () => "written"),
		};
		const { controller, engine, mock } = await createHarness(
			{
				frames: [
					{
						message: {
							role: "assistant",
							content: "",
							tool_calls: [
								{ id: "call_1", function: { name: "write_file", arguments: {} } },
								{ id: "call_2", function: { name: "write_file", arguments: {} } },
							],
						},
						done: true,
					},
				],
			},
			[tool],
		);
		let pendingCount = 0;
		controller.subscribe((event) => {
			if (event.type === "agent" && event.event.kind === "pending") pendingCount++;
		});

		const submit = controller.submit("write twice");
		await waitForRequests(mock, 1);
		await vi.waitFor(() => expect(controller.getState().phase).toBe("awaiting_approval"));
		await submit;
		mock.setScript({ frames: assistantFrames("complete") });
		await controller.approve("always");

		expect(tool.execute).toHaveBeenCalledTimes(2);
		expect(pendingCount).toBe(1);
		expect(engine.messages().filter((message) => message.role === "tool")).toHaveLength(2);
		expect(controller.getState().phase).toBe("idle");
		await controller.shutdown();
	});
});
