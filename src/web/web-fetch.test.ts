import { describe, expect, it, vi } from "vitest";
import { extractReadable, fetchAndExtract } from "./web-fetch.js";

describe("web_fetch extractReadable", () => {
	it("extracts article content from HTML", () => {
		const html = `
<!DOCTYPE html>
<html><head><title>Test Article</title></head>
<body>
<nav>Navigation stuff</nav>
<article>
<h1>Hello World</h1>
<p>This is the main content of the article. It has enough text to be considered readable content by the algorithm which needs a minimum amount of words.</p>
<p>Here is another paragraph with more meaningful content that helps Readability determine this is the main body of text on the page.</p>
</article>
<footer>Footer junk</footer>
</body></html>`;

		const result = extractReadable(html, "https://example.com/test");
		expect(result.isOk()).toBe(true);
		const content = result._unsafeUnwrap();
		expect(content).toContain("Hello World");
		expect(content).toContain("main content");
		expect(content).not.toContain("Navigation stuff");
		expect(content).not.toContain("Footer junk");
	});

	it("returns title + text content", () => {
		const html = `
<!DOCTYPE html>
<html><head><title>My Page Title</title></head>
<body>
<article>
<h1>Article Heading</h1>
<p>Substantial paragraph of text that contains enough words for Readability to consider it meaningful article content rather than boilerplate navigation text.</p>
<p>A second paragraph to ensure there is enough content density for the extraction algorithm to work properly and identify this as the main content area.</p>
</article>
</body></html>`;

		const result = extractReadable(html, "https://example.com");
		expect(result.isOk()).toBe(true);
		expect(result._unsafeUnwrap()).toContain("Article Heading");
	});

	it("truncates to maxLength", () => {
		const html = `
<!DOCTYPE html>
<html><head><title>Long</title></head>
<body>
<article>
<p>${"word ".repeat(1000)}</p>
<p>${"more ".repeat(1000)}</p>
</article>
</body></html>`;

		const result = extractReadable(html, "https://example.com", 200);
		expect(result.isOk()).toBe(true);
		expect(result._unsafeUnwrap().length).toBeLessThanOrEqual(220);
	});

	it("returns err for unparseable content", () => {
		const result = extractReadable("", "https://example.com");
		expect(result.isErr()).toBe(true);
	});

	it("combines caller cancellation with the request timeout", async () => {
		const controller = new AbortController();
		let requestSignal: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string | URL, options?: RequestInit) => {
				requestSignal = options?.signal instanceof AbortSignal ? options.signal : undefined;
				return new Promise<Response>((_resolve, reject) => {
					requestSignal?.addEventListener(
						"abort",
						() => reject(new DOMException("The operation was aborted", "AbortError")),
						{ once: true },
					);
				});
			}),
		);

		try {
			const resultPromise = fetchAndExtract("https://example.com", 8000, controller.signal);
			controller.abort();
			const result = await resultPromise;

			expect(result.isErr()).toBe(true);
			expect(requestSignal?.aborted).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("blocks redirects from allowlisted domains to unlisted domains", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(null, {
					status: 302,
					headers: { location: "https://outside.test/target" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		try {
			const result = await fetchAndExtract("https://docs.example.com/start", 8000, undefined, [
				"docs.example.com",
			]);

			expect(result.isErr()).toBe(true);
			if (result.isErr()) expect(result.error).toContain("outside.test");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("follows redirects only when each host is allowlisted", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "/guide" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					`<html><body><article><h1>Guide</h1><p>${"Useful article content ".repeat(12)}</p></article></body></html>`,
					{ status: 200, headers: { "content-type": "text/html" } },
				),
			);
		vi.stubGlobal("fetch", fetchMock);

		try {
			const result = await fetchAndExtract("https://docs.example.com/start", 8000, undefined, [
				"docs.example.com",
			]);

			expect(result.isOk()).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
