import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { okAsync } from "neverthrow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine/index.js";
import type { ConnectedServer } from "../mcp/index.js";
import type { Message, Provider, StreamChunk } from "../provider/types.js";
import { listSessions, loadSession, saveSession } from "../session/index.js";
import { openSession, pingProvider, shutdownServices } from "./bootstrap.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("pingProvider", () => {
	it("pings /api/tags for native Ollama endpoint", async () => {
		server.use(
			http.get("http://localhost:11434/api/tags", () => HttpResponse.json({ models: [] })),
		);

		const result = await pingProvider("ollama", { endpoint: "http://localhost:11434" }, 3000);
		expect(result.status).toBe("healthy");
	});

	it("pings /models for OpenAI-compatible endpoint", async () => {
		server.use(http.get("http://localhost:1234/v1/models", () => HttpResponse.json({ data: [] })));

		const result = await pingProvider("litellm", { endpoint: "http://localhost:1234/v1" }, 3000);
		expect(result.status).toBe("healthy");
	});

	it("pings /health for llama.cpp provider", async () => {
		server.use(http.get("http://localhost:8080/health", () => HttpResponse.json({ status: "ok" })));

		const result = await pingProvider("llamacpp", { endpoint: "http://localhost:8080" }, 3000);
		expect(result.status).toBe("healthy");
	});

	it("returns error when llama.cpp is loading (503)", async () => {
		server.use(
			http.get("http://localhost:8080/health", () => new HttpResponse(null, { status: 503 })),
		);

		const result = await pingProvider("llamacpp", { endpoint: "http://localhost:8080" }, 3000);
		expect(result.status).toBe("error");
		expect(result.message).toBe("Model is still loading");
	});

	it("returns auth_failed for 401", async () => {
		server.use(
			http.get("http://localhost:11434/api/tags", () => new HttpResponse(null, { status: 401 })),
		);

		const result = await pingProvider("ollama", { endpoint: "http://localhost:11434" }, 3000);
		expect(result.status).toBe("auth_failed");
	});

	it("returns error for non-OK status", async () => {
		server.use(
			http.get("http://localhost:11434/api/tags", () => new HttpResponse(null, { status: 500 })),
		);

		const result = await pingProvider("ollama", { endpoint: "http://localhost:11434" }, 3000);
		expect(result.status).toBe("error");
	});

	it("sends Authorization header when apiKey provided", async () => {
		let authHeader: string | null = null;
		server.use(
			http.get("http://localhost:4000/v1/models", ({ request }) => {
				authHeader = request.headers.get("Authorization");
				return HttpResponse.json({ data: [] });
			}),
		);

		await pingProvider(
			"litellm",
			{ endpoint: "http://localhost:4000/v1", apiKey: "sk-test" },
			3000,
		);
		expect(authHeader).toBe("Bearer sk-test");
	});
});

describe("shutdownServices", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	const stuckMcpServer = (): ConnectedServer => ({
		name: "stuck",
		client: { close: () => new Promise<void>(() => {}) } as unknown as ConnectedServer["client"],
		tools: [],
		autoApprove: new Set(),
		toolTimeoutMs: 60_000,
	});

	it("gives up on a hanging teardown after 3 s", async () => {
		const stuckLsp = { shutdown: () => new Promise<void>(() => {}) };
		const settled = vi.fn();
		shutdownServices([stuckMcpServer()], stuckLsp).then(settled);

		await vi.advanceTimersByTimeAsync(2999);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toHaveBeenCalled();
	});

	it("shuts down language servers without waiting for MCP servers", () => {
		const lsp = { shutdown: vi.fn(async () => {}) };

		shutdownServices([stuckMcpServer()], lsp);

		expect(lsp.shutdown).toHaveBeenCalled();
	});

	it("leaves no timer running after a quick teardown", async () => {
		await shutdownServices([], { shutdown: async () => {} });

		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("openSession", () => {
	const historyDir = join(tmpdir(), `anvil-open-session-test-${process.pid}`);
	afterEach(() => rmSync(historyDir, { recursive: true, force: true }));

	const interactive = { command: undefined, resume: false };
	const question: Message = { role: "user", content: "Fix the bug" };

	/** Answers "Done", letting the test look at the disk when the request goes out. */
	const providerThat = (onRequest: () => void): Provider => ({
		name: "mock",
		streamChat: () => {
			onRequest();
			async function* answer(): AsyncGenerator<StreamChunk> {
				yield { content: "Done", done: false };
				yield { done: true };
			}
			return okAsync(answer());
		},
		completeChat: () => {
			throw new Error("not implemented");
		},
		supportsTools: () => true,
		listModels: () => okAsync([]),
	});

	const latestSaved = (): Message[] => {
		const latest = listSessions(historyDir)[0];
		return latest ? loadSession(historyDir, latest.id)._unsafeUnwrap().messages : [];
	};

	const newEngine = (onRequest: () => void = () => undefined) =>
		createEngine(providerThat(onRequest), "test");

	const drain = async (events: AsyncIterable<unknown>): Promise<unknown[]> => {
		const seen: unknown[] = [];
		for await (const event of events) seen.push(event);
		return seen;
	};

	it("F9: saves the user message before the request goes out", async () => {
		let onDiskAtRequest: Message[] = [];
		const engine = newEngine(() => {
			onDiskAtRequest = latestSaved();
		});
		openSession(interactive, historyDir, engine);

		engine.addUser("Fix the bug");
		await drain(engine.stream([]));

		expect(onDiskAtRequest).toEqual([question]);
		expect(latestSaved()).toEqual([question, { role: "assistant", content: "Done" }]);
	});

	it("never saves a one-shot run", () => {
		const engine = newEngine();

		openSession({ command: "Fix the bug", resume: false }, historyDir, engine);
		engine.addUser("Fix the bug");

		expect(listSessions(historyDir)).toEqual([]);
	});

	it("continues the latest session with --resume", () => {
		const id = saveSession(historyDir, [question])._unsafeUnwrap();
		const engine = newEngine();

		const session = openSession({ command: undefined, resume: true }, historyDir, engine);
		engine.addUser("And the tests?");

		expect(session.id()).toBe(id);
		expect(listSessions(historyDir)).toHaveLength(1);
		expect(latestSaved()).toEqual([question, { role: "user", content: "And the tests?" }]);
	});

	it("repairs unanswered tool calls when resuming a session", () => {
		const interruptedHistory: Message[] = [
			question,
			{
				role: "assistant",
				content: "",
				toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
			},
		];
		const id = saveSession(historyDir, interruptedHistory)._unsafeUnwrap();
		const engine = newEngine();

		openSession({ command: undefined, resume: true }, historyDir, engine);
		engine.addUser("Continue");

		const repairedHistory: Message[] = [
			...interruptedHistory,
			{ role: "tool", toolCallId: "call-1", content: "[not executed: session was interrupted]" },
			{ role: "user", content: "Continue" },
		];

		expect(engine.messages()).toEqual(repairedHistory);
		expect(listSessions(historyDir)).toHaveLength(1);
		expect(loadSession(historyDir, id)._unsafeUnwrap().messages).toEqual(repairedHistory);
	});
});
