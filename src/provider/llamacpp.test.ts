import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isLlamaCppProvider } from "../shared/bootstrap.js";
import { createLlamaCppProvider, type LlamaCppProvider } from "./llamacpp.js";
import type { ProviderConfig, StreamChunk } from "./types.js";

const BASE_URL = "http://localhost:8080";
const config: ProviderConfig = { endpoint: BASE_URL, streamTimeout: 2, connectTimeout: 2 };

const collect = async (iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
	const chunks: StreamChunk[] = [];
	for await (const chunk of iter) chunks.push(chunk);
	return chunks;
};

/** Build SSE response from chat completion chunks. */
const sse = (chunks: Record<string, unknown>[]): string =>
	`${chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("llamacpp provider", () => {
	describe("streamChat", () => {
		it("streams content via /v1/chat/completions", async () => {
			server.use(
				http.post(`${BASE_URL}/v1/chat/completions`, () => {
					const body = sse([
						{
							choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
						},
						{
							choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }],
							usage: { prompt_tokens: 10, total_tokens: 12 },
						},
					]);
					return new HttpResponse(body, {
						headers: { "Content-Type": "text/event-stream" },
					});
				}),
			);

			const provider = createLlamaCppProvider("llamacpp", config);
			const result = await provider.streamChat(
				"my-model",
				[{ role: "user", content: "hi" }],
				[],
				{},
			);
			expect(result.isOk()).toBe(true);
			const chunks = await collect(result._unsafeUnwrap());

			expect(chunks.filter((c) => c.content)).toHaveLength(2);
			expect(chunks[0]?.content).toBe("Hello");
			expect(chunks[1]?.content).toBe(" world");
		});

		it("handles tool calls", async () => {
			server.use(
				http.post(`${BASE_URL}/v1/chat/completions`, () => {
					const body = sse([
						{
							choices: [
								{
									index: 0,
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_1",
												function: { name: "read_file", arguments: '{"path":"foo.ts"}' },
											},
										],
									},
									finish_reason: "tool_calls",
								},
							],
						},
					]);
					return new HttpResponse(body, {
						headers: { "Content-Type": "text/event-stream" },
					});
				}),
			);

			const provider = createLlamaCppProvider("llamacpp", config);
			const result = await provider.streamChat(
				"my-model",
				[{ role: "user", content: "read foo" }],
				[{ name: "read_file", description: "Read a file", parameters: {} }],
				{},
			);
			expect(result.isOk()).toBe(true);
			const chunks = await collect(result._unsafeUnwrap());
			const toolChunk = chunks.find((c) => c.toolCall);
			expect(toolChunk?.toolCall?.name).toBe("read_file");
			expect(toolChunk?.toolCall?.id).toBe("call_1");
		});
	});

	describe("checkHealth", () => {
		it("returns ok when server is healthy", async () => {
			server.use(http.get(`${BASE_URL}/health`, () => HttpResponse.json({ status: "ok" })));

			const provider = createLlamaCppProvider("llamacpp", config) as LlamaCppProvider;
			const result = await provider.checkHealth();
			expect(result.isOk()).toBe(true);
		});

		it("returns error when model is loading", async () => {
			server.use(
				http.get(`${BASE_URL}/health`, () =>
					HttpResponse.json(
						{ error: { code: 503, message: "Loading model", type: "unavailable_error" } },
						{ status: 503 },
					),
				),
			);

			const provider = createLlamaCppProvider("llamacpp", config) as LlamaCppProvider;
			const result = await provider.checkHealth();
			expect(result.isErr()).toBe(true);
			expect(result._unsafeUnwrapErr().kind).toBe("connection");
		});
	});

	describe("fetchContextSize", () => {
		it("returns training context size from model metadata", async () => {
			server.use(
				http.get(`${BASE_URL}/v1/models`, () =>
					HttpResponse.json({
						object: "list",
						data: [
							{
								id: "my-model",
								object: "model",
								meta: { n_ctx_train: 131072, n_params: 8030261312 },
							},
						],
					}),
				),
			);

			const provider = createLlamaCppProvider("llamacpp", config) as LlamaCppProvider;
			const result = await provider.fetchContextSize();
			expect(result.isOk()).toBe(true);
			expect(result._unsafeUnwrap()).toBe(131072);
		});

		it("returns undefined when meta is null", async () => {
			server.use(
				http.get(`${BASE_URL}/v1/models`, () =>
					HttpResponse.json({
						object: "list",
						data: [{ id: "my-model", object: "model", meta: null }],
					}),
				),
			);

			const provider = createLlamaCppProvider("llamacpp", config) as LlamaCppProvider;
			const result = await provider.fetchContextSize();
			expect(result.isOk()).toBe(true);
			expect(result._unsafeUnwrap()).toBeUndefined();
		});
	});

	describe("listModels", () => {
		it("returns model list from /v1/models", async () => {
			server.use(
				http.get(`${BASE_URL}/v1/models`, () =>
					HttpResponse.json({
						object: "list",
						data: [{ id: "qwen3:8b", object: "model" }],
					}),
				),
			);

			const provider = createLlamaCppProvider("llamacpp", config);
			const result = await provider.listModels();
			expect(result.isOk()).toBe(true);
			expect(result._unsafeUnwrap()).toEqual(["qwen3:8b"]);
		});
	});
});

describe("isLlamaCppProvider", () => {
	it("matches known provider names", () => {
		expect(isLlamaCppProvider("llamacpp")).toBe(true);
		expect(isLlamaCppProvider("llama.cpp")).toBe(true);
		expect(isLlamaCppProvider("llama-cpp")).toBe(true);
	});

	it("rejects other names", () => {
		expect(isLlamaCppProvider("ollama")).toBe(false);
		expect(isLlamaCppProvider("openrouter")).toBe(false);
		expect(isLlamaCppProvider("litellm")).toBe(false);
	});
});
