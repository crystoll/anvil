import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pingProvider } from "./bootstrap.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("pingProvider", () => {
	it("pings /api/tags for native Ollama endpoint", async () => {
		server.use(
			http.get("http://localhost:11434/api/tags", () => HttpResponse.json({ models: [] })),
		);

		const result = await pingProvider({ endpoint: "http://localhost:11434" }, 3000);
		expect(result.status).toBe("healthy");
	});

	it("pings /models for OpenAI-compatible endpoint", async () => {
		server.use(http.get("http://localhost:1234/v1/models", () => HttpResponse.json({ data: [] })));

		const result = await pingProvider({ endpoint: "http://localhost:1234/v1" }, 3000);
		expect(result.status).toBe("healthy");
	});

	it("returns auth_failed for 401", async () => {
		server.use(
			http.get("http://localhost:11434/api/tags", () => new HttpResponse(null, { status: 401 })),
		);

		const result = await pingProvider({ endpoint: "http://localhost:11434" }, 3000);
		expect(result.status).toBe("auth_failed");
	});

	it("returns error for non-OK status", async () => {
		server.use(
			http.get("http://localhost:11434/api/tags", () => new HttpResponse(null, { status: 500 })),
		);

		const result = await pingProvider({ endpoint: "http://localhost:11434" }, 3000);
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

		await pingProvider({ endpoint: "http://localhost:4000/v1", apiKey: "sk-test" }, 3000);
		expect(authHeader).toBe("Bearer sk-test");
	});
});
