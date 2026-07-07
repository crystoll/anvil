import { HttpResponse, http, passthrough } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createOllamaProvider } from "./ollama-native.js";
import type { ProviderConfig, StreamChunk } from "./types.js";

const BASE_URL = "http://localhost:11434";
const config: ProviderConfig = { endpoint: BASE_URL, streamTimeout: 2, connectTimeout: 2 };

/** Collect all chunks from an async iterable. */
const collect = async (iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
	const chunks: StreamChunk[] = [];
	for await (const chunk of iter) chunks.push(chunk);
	return chunks;
};

/** Build NDJSON response from Ollama-style chunk objects. */
const ndjson = (chunks: Record<string, unknown>[]): string =>
	chunks.map((c) => JSON.stringify(c)).join("\n");

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("ollama-native provider", () => {
	describe("streamChat", () => {
		it("streams content chunks and signals done", async () => {
			server.use(
				http.post(`${BASE_URL}/api/chat`, () => {
					const body = ndjson([
						{ model: "gemma4:e4b", message: { role: "assistant", content: "Hello" }, done: false },
						{ model: "gemma4:e4b", message: { role: "assistant", content: " world" }, done: false },
						{
							model: "gemma4:e4b",
							message: { role: "assistant", content: "" },
							done: true,
							done_reason: "stop",
							prompt_eval_count: 24,
							eval_count: 2,
						},
					]);
					return new HttpResponse(body, { headers: { "Content-Type": "application/x-ndjson" } });
				}),
			);

			const provider = createOllamaProvider("ollama", config);
			const result = await provider.streamChat(
				"gemma4:e4b",
				[{ role: "user", content: "hi" }],
				[],
				{},
			);
			expect(result.isOk()).toBe(true);
			const chunks = await collect(result._unsafeUnwrap());

			expect(chunks.filter((c) => c.content)).toHaveLength(2);
			expect(chunks[0]?.content).toBe("Hello");
			expect(chunks[1]?.content).toBe(" world");

			const done = chunks.find((c) => c.done);
			expect(done).toBeDefined();
			expect(done?.usage?.promptTokens).toBe(24);
			expect(done?.usage?.totalTokens).toBe(26);
		});

		it("streams thinking as reasoning field", async () => {
			server.use(
				http.post(`${BASE_URL}/api/chat`, () => {
					const body = ndjson([
						{
							model: "m",
							message: { role: "assistant", content: "", thinking: "Let me think" },
							done: false,
						},
						{
							model: "m",
							message: { role: "assistant", content: "", thinking: " about this" },
							done: false,
						},
						{ model: "m", message: { role: "assistant", content: "42" }, done: false },
						{
							model: "m",
							message: { role: "assistant", content: "" },
							done: true,
							done_reason: "stop",
							prompt_eval_count: 10,
							eval_count: 5,
						},
					]);
					return new HttpResponse(body, { headers: { "Content-Type": "application/x-ndjson" } });
				}),
			);

			const provider = createOllamaProvider("ollama", config);
			const result = await provider.streamChat("m", [{ role: "user", content: "q" }], [], {});
			const chunks = await collect(result._unsafeUnwrap());

			const reasoning = chunks.filter((c) => c.reasoning);
			expect(reasoning).toHaveLength(2);
			expect(reasoning[0]?.reasoning).toBe("Let me think");
			expect(reasoning[1]?.reasoning).toBe(" about this");
			expect(chunks.find((c) => c.content === "42")).toBeDefined();
		});

		it("parses tool calls as complete objects", async () => {
			server.use(
				http.post(`${BASE_URL}/api/chat`, () => {
					const body = ndjson([
						{
							model: "m",
							message: {
								role: "assistant",
								content: "",
								tool_calls: [
									{
										id: "call_123",
										function: { name: "read_file", arguments: { path: "src/main.ts" } },
									},
								],
							},
							done: false,
						},
						{
							model: "m",
							message: { role: "assistant", content: "" },
							done: true,
							done_reason: "stop",
							prompt_eval_count: 50,
							eval_count: 20,
						},
					]);
					return new HttpResponse(body, { headers: { "Content-Type": "application/x-ndjson" } });
				}),
			);

			const provider = createOllamaProvider("ollama", config);
			const result = await provider.streamChat("m", [{ role: "user", content: "read" }], [], {});
			const chunks = await collect(result._unsafeUnwrap());

			const toolChunk = chunks.find((c) => c.toolCall);
			expect(toolChunk?.toolCall).toMatchObject({
				index: 0,
				id: "call_123",
				name: "read_file",
				argumentsFragment: '{"path":"src/main.ts"}',
			});
		});

		it("formats tool results with tool_name, assistant with type/index, and reasoning as thinking", async () => {
			let capturedBody: Record<string, unknown> = {};
			server.use(
				http.post(`${BASE_URL}/api/chat`, async ({ request }) => {
					capturedBody = (await request.json()) as Record<string, unknown>;
					const body = ndjson([
						{
							model: "m",
							message: { role: "assistant", content: "done" },
							done: true,
							done_reason: "stop",
							prompt_eval_count: 100,
							eval_count: 5,
						},
					]);
					return new HttpResponse(body, { headers: { "Content-Type": "application/x-ndjson" } });
				}),
			);

			const provider = createOllamaProvider("ollama", config);
			const messages = [
				{ role: "user" as const, content: "read the file" },
				{
					role: "assistant" as const,
					content: "",
					reasoning: "I should read the file",
					toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"src/main.ts"}' }],
				},
				{ role: "tool" as const, content: "file contents here", toolCallId: "call_1" },
			];

			const result = await provider.streamChat("m", messages, [], {});
			await collect(result._unsafeUnwrap());

			const sent = capturedBody.messages as Record<string, unknown>[];

			// User message — unchanged
			expect(sent[0]).toEqual({ role: "user", content: "read the file" });

			// Assistant message — thinking field, type+index in tool_calls, no id
			expect(sent[1]).toEqual({
				role: "assistant",
				content: "",
				thinking: "I should read the file",
				tool_calls: [
					{
						type: "function",
						function: { index: 0, name: "read_file", arguments: { path: "src/main.ts" } },
					},
				],
			});

			// Tool result — tool_name, no tool_call_id
			expect(sent[2]).toEqual({
				role: "tool",
				content: "file contents here",
				tool_name: "read_file",
			});
		});

		it("parses tool calls as complete objects", async () => {
			server.use(
				http.post(`${BASE_URL}/api/chat`, () => {
					const body = ndjson([
						{
							model: "m",
							message: {
								role: "assistant",
								content: "",
								tool_calls: [
									{
										id: "call_123",
										function: { name: "read_file", arguments: { path: "src/main.ts" } },
									},
								],
							},
							done: false,
						},
						{
							model: "m",
							message: { role: "assistant", content: "" },
							done: true,
							done_reason: "stop",
							prompt_eval_count: 50,
							eval_count: 20,
						},
					]);
					return new HttpResponse(body, { headers: { "Content-Type": "application/x-ndjson" } });
				}),
			);

			const provider = createOllamaProvider("ollama", config);
			const result = await provider.streamChat("m", [{ role: "user", content: "read" }], [], {});
			const chunks = await collect(result._unsafeUnwrap());

			const toolChunk = chunks.find((c) => c.toolCall);
			expect(toolChunk?.toolCall).toMatchObject({
				index: 0,
				id: "call_123",
				name: "read_file",
				argumentsFragment: '{"path":"src/main.ts"}',
			});
		});

		it("sends num_ctx in options when contextSize provided", async () => {
			let capturedBody: Record<string, unknown> = {};
			server.use(
				http.post(`${BASE_URL}/api/chat`, async ({ request }) => {
					capturedBody = (await request.json()) as Record<string, unknown>;
					const body = ndjson([
						{
							model: "m",
							message: { role: "assistant", content: "" },
							done: true,
							done_reason: "stop",
							prompt_eval_count: 5,
							eval_count: 1,
						},
					]);
					return new HttpResponse(body, { headers: { "Content-Type": "application/x-ndjson" } });
				}),
			);

			const provider = createOllamaProvider("ollama", config);
			const result = await provider.streamChat("m", [{ role: "user", content: "hi" }], [], {
				contextSize: 65536,
			});
			await collect(result._unsafeUnwrap());

			expect(capturedBody.options).toEqual({ num_ctx: 65536 });
		});

		it("returns timeout error when stream stalls", async () => {
			server.use(
				http.post(`${BASE_URL}/api/chat`, () => {
					// Never send data — triggers timeout
					return new Promise(() => {});
				}),
			);

			const provider = createOllamaProvider("ollama", { ...config, connectTimeout: 1 });
			const result = await provider.streamChat("m", [{ role: "user", content: "hi" }], [], {});
			expect(result.isErr()).toBe(true);
			expect(result._unsafeUnwrapErr().kind).toBe("timeout");
		});

		it("returns connection error for refused connection", async () => {
			server.use(http.post("http://localhost:19999/api/chat", () => passthrough()));
			const badConfig: ProviderConfig = {
				endpoint: "http://localhost:19999",
				streamTimeout: 2,
				connectTimeout: 1,
			};
			const provider = createOllamaProvider("ollama", badConfig);
			const result = await provider.streamChat("m", [{ role: "user", content: "hi" }], [], {});
			expect(result.isErr()).toBe(true);
			expect(result._unsafeUnwrapErr().kind).toBe("connection");
		});
	});

	describe("listModels", () => {
		it("lists models from /api/tags", async () => {
			server.use(
				http.get(`${BASE_URL}/api/tags`, () =>
					HttpResponse.json({ models: [{ name: "gemma4:e4b" }, { name: "qwen3:8b" }] }),
				),
			);

			const provider = createOllamaProvider("ollama", config);
			const result = await provider.listModels();
			expect(result.isOk()).toBe(true);
			expect(result._unsafeUnwrap()).toEqual(["gemma4:e4b", "qwen3:8b"]);
		});
	});
});
