import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createProvider } from "./openai-compatible.js";
import type { ProviderConfig, StreamChunk } from "./types.js";

const BASE_URL = "http://localhost:11434/v1";
const config: ProviderConfig = { endpoint: BASE_URL, streamTimeout: 2, connectTimeout: 2 };

/** Helper: collect all chunks from an async iterable. */
const collect = async (iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
	const chunks: StreamChunk[] = [];
	for await (const chunk of iter) {
		chunks.push(chunk);
	}
	return chunks;
};

/** Helper: build SSE data lines from content strings. */
const sseLines = (contents: string[]): string => {
	const lines = contents.map(
		(c, i) =>
			`data: ${JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: i === contents.length - 1 ? "stop" : null }] })}\n\n`,
	);
	return lines.join("");
};

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("openai-compatible provider", () => {
	describe("streamChat", () => {
		it("streams content chunks and signals done", async () => {
			server.use(
				http.post(`${BASE_URL}/chat/completions`, () => {
					const body = `${sseLines(["Hello", " world"])}data: [DONE]\n\n`;
					return new HttpResponse(body, {
						headers: { "Content-Type": "text/event-stream" },
					});
				}),
			);

			const provider = createProvider("test", config);
			const result = await provider.streamChat(
				"test-model",
				[{ role: "user", content: "hi" }],
				[],
				{},
			);

			expect(result.isOk()).toBe(true);
			const chunks = await collect(result._unsafeUnwrap());

			const contentChunks = chunks.filter((c) => c.content);
			expect(contentChunks).toHaveLength(2);
			expect(contentChunks[0]?.content).toBe("Hello");
			expect(contentChunks[1]?.content).toBe(" world");
			expect(chunks.some((c) => c.done)).toBe(true);
		});

		it("streams tool call deltas", async () => {
			server.use(
				http.post(`${BASE_URL}/chat/completions`, () => {
					const chunks = [
						{
							choices: [
								{
									delta: {
										tool_calls: [
											{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } },
										],
									},
									finish_reason: null,
								},
							],
						},
						{
							choices: [
								{
									delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
									finish_reason: null,
								},
							],
						},
						{
							choices: [
								{
									delta: { tool_calls: [{ index: 0, function: { arguments: '"src/index.ts"}' } }] },
									finish_reason: "tool_calls",
								},
							],
						},
					];
					const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
					return new HttpResponse(body, {
						headers: { "Content-Type": "text/event-stream" },
					});
				}),
			);

			const provider = createProvider("test", config);
			const result = await provider.streamChat(
				"test-model",
				[{ role: "user", content: "read the file" }],
				[{ name: "read_file", description: "read a file", parameters: {} }],
				{},
			);

			expect(result.isOk()).toBe(true);
			const chunks = await collect(result._unsafeUnwrap());
			const toolChunks = chunks.filter((c) => c.toolCall);

			expect(toolChunks).toHaveLength(3);
			expect(toolChunks[0]?.toolCall?.id).toBe("call_1");
			expect(toolChunks[0]?.toolCall?.name).toBe("read_file");

			const fullArgs = toolChunks.map((c) => c.toolCall?.argumentsFragment).join("");
			expect(fullArgs).toBe('{"path":"src/index.ts"}');
		});

		it("returns timeout error when stream stalls", async () => {
			server.use(
				http.post(`${BASE_URL}/chat/completions`, () => {
					// Send one chunk then hang (never close)
					const body = sseLines(["start"]);
					return new HttpResponse(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(body));
								// Never close — simulates stall
							},
						}),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}),
			);

			const provider = createProvider("test", config);
			const result = await provider.streamChat(
				"test-model",
				[{ role: "user", content: "hi" }],
				[],
				{},
			);

			expect(result.isOk()).toBe(true);
			const chunks = await collect(result._unsafeUnwrap());
			const lastChunk = chunks[chunks.length - 1];

			expect(lastChunk?.done).toBe(true);
			expect(lastChunk?.error?.kind).toBe("timeout");
		});

		it("returns api error for non-200 responses", async () => {
			server.use(
				http.post(`${BASE_URL}/chat/completions`, () => {
					return new HttpResponse("rate limited", { status: 429 });
				}),
			);

			const provider = createProvider("test", config);
			const result = await provider.streamChat(
				"test-model",
				[{ role: "user", content: "hi" }],
				[],
				{},
			);

			expect(result.isErr()).toBe(true);
			const err = result._unsafeUnwrapErr();
			expect(err.kind).toBe("api");
			if (err.kind === "api") expect(err.status).toBe(429);
		});
	});

	describe("completeChat", () => {
		it("returns content from non-streaming completion", async () => {
			server.use(
				http.post(`${BASE_URL}/chat/completions`, () => {
					return HttpResponse.json({
						choices: [{ message: { content: "Hello!" } }],
						usage: { prompt_tokens: 10, total_tokens: 15 },
					});
				}),
			);

			const provider = createProvider("test", config);
			const result = await provider.completeChat(
				"test-model",
				[{ role: "user", content: "hi" }],
				[],
				{},
			);

			expect(result.isOk()).toBe(true);
			const completion = result._unsafeUnwrap();
			expect(completion.content).toBe("Hello!");
			expect(completion.usage?.promptTokens).toBe(10);
			expect(completion.usage?.totalTokens).toBe(15);
		});
	});

	describe("listModels", () => {
		it("returns model ids", async () => {
			server.use(
				http.get(`${BASE_URL}/models`, () => {
					return HttpResponse.json({
						data: [{ id: "qwen3:8b" }, { id: "gemma4:e4b" }],
					});
				}),
			);

			const provider = createProvider("test", config);
			const result = await provider.listModels();

			expect(result.isOk()).toBe(true);
			expect(result._unsafeUnwrap()).toEqual(["qwen3:8b", "gemma4:e4b"]);
		});
	});
});
