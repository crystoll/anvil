import { describe, expect, it } from "vitest";
import { extractReadable } from "./web-fetch.js";

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
});
