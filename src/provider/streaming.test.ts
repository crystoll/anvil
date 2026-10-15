import { afterEach, describe, expect, it } from "vitest";
import { startMockOllama } from "../test-support/mock-ollama.js";
import { startMockOpenAI } from "../test-support/mock-openai.js";
import type { MockStreamServer } from "../test-support/mock-stream-server.js";
import { createOllamaProvider } from "./ollama-native.js";
import { createProvider } from "./openai-compatible.js";
import type { Provider, ProviderConfig, StreamChunk } from "./types.js";

const servers: MockStreamServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((mock) => mock.close()));
});

const collect = async (iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
	const chunks: StreamChunk[] = [];
	for await (const chunk of iterable) chunks.push(chunk);
	return chunks;
};

const ollamaFrame = (content: string, done = false, doneReason?: string) => ({
	message: { role: "assistant", content },
	done,
	...(doneReason ? { done_reason: doneReason } : {}),
});

const openAIFrame = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
	choices: [{ delta, finish_reason: finishReason }],
});

const startOllama = async (script: Parameters<typeof startMockOllama>[0]) => {
	const mock = await startMockOllama(script);
	servers.push(mock);
	return mock;
};

const startOpenAI = async (script: Parameters<typeof startMockOpenAI>[0]) => {
	const mock = await startMockOpenAI(script);
	servers.push(mock);
	return mock;
};

const consume = async (provider: Provider, signal?: AbortSignal) => {
	const result = await provider.streamChat(
		"test-model",
		[{ role: "user", content: "hi" }],
		[],
		signal ? { signal } : {},
	);
	if (result.isErr()) throw result.error;
	return collect(result.value);
};

describe("streaming provider contracts", () => {
	it("reports an Ollama socket drop after preserving partial content", async () => {
		const mock = await startOllama({ frames: [ollamaFrame("partial")], dropAfter: 1 });
		const chunks = await consume(createOllamaProvider("ollama", { endpoint: mock.endpoint }));

		expect(chunks).toMatchObject([
			{ content: "partial", done: false },
			{ done: true, error: { kind: "connection" } },
		]);
	});

	it("reports Ollama runner errors as API errors", async () => {
		const mock = await startOllama({
			frames: [ollamaFrame("partial")],
			errorLine: "model runner has unexpectedly stopped",
		});
		const chunks = await consume(createOllamaProvider("ollama", { endpoint: mock.endpoint }));

		expect(chunks.at(-1)).toMatchObject({
			done: true,
			error: { kind: "api", message: "model runner has unexpectedly stopped" },
		});
	});

	it("reports an Ollama mid-stream stall as a timeout", async () => {
		const mock = await startOllama({ frames: [ollamaFrame("partial")], stallAfter: 1 });
		const chunks = await consume(
			createOllamaProvider("ollama", { endpoint: mock.endpoint, streamTimeout: 0.05 }),
		);

		expect(chunks.at(-1)).toMatchObject({ done: true, error: { kind: "timeout" } });
	});

	it("allows more time for the first Ollama chunk than for a later stall", async () => {
		const mock = await startOllama({
			frames: [ollamaFrame("first")],
			delayMs: 200,
			stallAfter: 1,
		});
		const providerConfig: ProviderConfig = {
			endpoint: mock.endpoint,
			firstTokenTimeout: 0.5,
			streamTimeout: 0.05,
		};
		const chunks = await consume(createOllamaProvider("ollama", providerConfig));

		expect(chunks).toMatchObject([
			{ content: "first", done: false },
			{ done: true, error: { kind: "timeout" } },
		]);
	});

	it("times out if Ollama does not produce a first chunk in time", async () => {
		const mock = await startOllama({
			frames: [ollamaFrame("late", true, "stop")],
			delayMs: 100,
		});
		const providerConfig: ProviderConfig = {
			endpoint: mock.endpoint,
			firstTokenTimeout: 0.02,
			streamTimeout: 1,
		};
		const chunks = await consume(createOllamaProvider("ollama", providerConfig));

		expect(chunks.at(-1)).toMatchObject({ done: true, error: { kind: "timeout" } });
	});

	it("uses the first-token timeout for OpenAI-compatible streams", async () => {
		const mock = await startOpenAI({
			frames: [openAIFrame({ content: "late" }, "stop")],
			delayMs: 100,
		});
		const providerConfig: ProviderConfig = {
			endpoint: `${mock.endpoint}/v1`,
			firstTokenTimeout: 0.02,
			streamTimeout: 1,
		};
		const chunks = await consume(createProvider("test", providerConfig));

		expect(chunks.at(-1)).toMatchObject({ done: true, error: { kind: "timeout" } });
	});

	it("reports cancellation and closes the Ollama socket", async () => {
		const mock = await startOllama({ frames: [ollamaFrame("partial")], stallAfter: 1 });
		const controller = new AbortController();
		const pending = consume(
			createOllamaProvider("ollama", { endpoint: mock.endpoint, streamTimeout: 5 }),
			controller.signal,
		);
		await waitForRequest(mock);
		controller.abort();

		const chunks = await pending;
		await mock.clientDisconnected;
		expect(chunks.at(-1)).toMatchObject({ done: true, error: { kind: "cancelled" } });
	});

	it("preserves Ollama length finish reason", async () => {
		const mock = await startOllama({ frames: [ollamaFrame("partial", true, "length")] });
		const chunks = await consume(createOllamaProvider("ollama", { endpoint: mock.endpoint }));

		expect(chunks.at(-1)).toMatchObject({ done: true, finishReason: "length" });
	});

	it("reports an OpenAI-compatible socket drop after preserving partial content", async () => {
		const mock = await startOpenAI({
			frames: [openAIFrame({ content: "partial" })],
			dropAfter: 1,
		});
		const chunks = await consume(createProvider("test", { endpoint: `${mock.endpoint}/v1` }));

		expect(chunks).toMatchObject([
			{ content: "partial", done: false },
			{ done: true, error: { kind: "connection" } },
		]);
	});

	it("reports an OpenAI-compatible abort as cancellation", async () => {
		const mock = await startOpenAI({
			frames: [openAIFrame({ content: "partial" })],
			stallAfter: 1,
		});
		const controller = new AbortController();
		const pending = consume(
			createProvider("test", { endpoint: `${mock.endpoint}/v1`, streamTimeout: 5 }),
			controller.signal,
		);
		await waitForRequest(mock);
		controller.abort();

		const chunks = await pending;
		await mock.clientDisconnected;
		expect(chunks.at(-1)).toMatchObject({ done: true, error: { kind: "cancelled" } });
	});

	it("closes the OpenAI-compatible socket when the consumer stops early", async () => {
		const mock = await startOpenAI({
			frames: [openAIFrame({ content: "first" }), openAIFrame({ content: "second" })],
			delayMs: 20,
		});
		const result = await createProvider("test", { endpoint: `${mock.endpoint}/v1` }).streamChat(
			"test-model",
			[{ role: "user", content: "hi" }],
			[],
			{},
		);
		if (result.isErr()) throw result.error;
		const iterator = result.value[Symbol.asyncIterator]();

		expect((await iterator.next()).value).toMatchObject({ content: "first", done: false });
		await iterator.return?.();
		await mock.clientDisconnected;
	});

	it("reports OpenAI-compatible stream error events", async () => {
		const mock = await startOpenAI({ errorLine: "upstream model failed" });
		const chunks = await consume(createProvider("test", { endpoint: `${mock.endpoint}/v1` }));

		expect(chunks.at(-1)).toMatchObject({
			done: true,
			error: { kind: "api", message: "upstream model failed" },
		});
	});

	it("reports malformed SSE data as a parse error with one terminal chunk", async () => {
		const mock = await startOpenAI({ rawLine: "data: {invalid-json" });
		const chunks = await consume(createProvider("test", { endpoint: `${mock.endpoint}/v1` }));

		expect(chunks.at(-1)).toMatchObject({ done: true, error: { kind: "parse" } });
		expect(chunks.filter((chunk) => chunk.done)).toHaveLength(1);
	});

	it("rejects a clean OpenAI-compatible EOF without a finish reason", async () => {
		const mock = await startOpenAI({ frames: [openAIFrame({ content: "partial" })] });
		const chunks = await consume(createProvider("test", { endpoint: `${mock.endpoint}/v1` }));

		expect(chunks.at(-1)).toMatchObject({ done: true, error: { kind: "connection" } });
		expect(chunks.filter((chunk) => chunk.done)).toHaveLength(1);
	});

	it("emits every OpenAI-compatible tool call in one delta", async () => {
		const mock = await startOpenAI({
			frames: [
				openAIFrame({
					tool_calls: [
						{ index: 0, id: "call-1", function: { name: "read_file", arguments: "{}" } },
						{ index: 1, id: "call-2", function: { name: "search", arguments: "{}" } },
					],
				}),
				openAIFrame({}, "tool_calls"),
			],
		});
		const chunks = await consume(createProvider("test", { endpoint: `${mock.endpoint}/v1` }));

		expect(chunks.filter((chunk) => chunk.toolCall).map((chunk) => chunk.toolCall?.id)).toEqual([
			"call-1",
			"call-2",
		]);
	});

	it("does not leak a thinking tag split across SSE chunks", async () => {
		const mock = await startOpenAI({
			frames: [
				openAIFrame({ content: "<thi" }),
				openAIFrame({ content: "nk>reason</think>answer" }),
				openAIFrame({}, "stop"),
			],
		});
		const chunks = await consume(createProvider("test", { endpoint: `${mock.endpoint}/v1` }));

		expect(chunks.map((chunk) => chunk.content).join("")).toBe("answer");
		expect(chunks.map((chunk) => chunk.reasoning).join("")).toBe("reason");
	});

	it("marks interrupted assistant history for OpenAI-compatible providers", async () => {
		const mock = await startOpenAI({ frames: [openAIFrame({}, "stop")] });
		const result = await createProvider("test", { endpoint: `${mock.endpoint}/v1` }).streamChat(
			"test-model",
			[{ role: "assistant", content: "partial", status: "interrupted" }],
			[],
			{},
		);
		if (result.isErr()) throw result.error;
		await collect(result.value);

		expect(mock.requests[0]).toMatchObject({
			messages: [{ role: "assistant", content: "partial\n[response interrupted]" }],
		});
	});

	it("marks errored assistant history for Ollama providers", async () => {
		const mock = await startOllama({ frames: [ollamaFrame("ok", true)] });
		const result = await createOllamaProvider("ollama", { endpoint: mock.endpoint }).streamChat(
			"test-model",
			[{ role: "assistant", content: "partial", status: "error" }],
			[],
			{},
		);
		if (result.isErr()) throw result.error;
		await collect(result.value);

		expect(mock.requests[0]).toMatchObject({
			messages: [{ role: "assistant", content: "partial\n[response ended with an error]" }],
		});
	});
});

const waitForRequest = async (mock: MockStreamServer): Promise<void> => {
	const deadline = Date.now() + 1000;
	while (mock.requests.length === 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(mock.requests).toHaveLength(1);
};
