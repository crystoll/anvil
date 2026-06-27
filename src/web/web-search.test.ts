import { describe, expect, it } from "vitest";
import { parseSearchResults } from "./web-search.js";

const SAMPLE_HTML = `
<div class="results">
  <div class="result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://example.com/page1">First Result Title</a>
    </h2>
    <a class="result__snippet" href="https://example.com/page1">This is the first result snippet text.</a>
  </div>
  <div class="result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://example.com/page2">Second Result</a>
    </h2>
    <a class="result__snippet" href="https://example.com/page2">Second snippet here.</a>
  </div>
</div>
`;

describe("web_search parseSearchResults", () => {
	it("extracts results from DDG HTML", () => {
		const results = parseSearchResults(SAMPLE_HTML);
		expect(results).toHaveLength(2);
		expect(results[0]?.title).toBe("First Result Title");
		expect(results[0]?.url).toBe("https://example.com/page1");
		expect(results[0]?.snippet).toBe("This is the first result snippet text.");
	});

	it("handles HTML entities in snippets", () => {
		const html = `
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="https://x.com">TypeScript&#x27;s async</a>
  </h2>
  <a class="result__snippet" href="https://x.com">Learn <b>TypeScript</b> &amp; async.</a>
</div>`;

		const results = parseSearchResults(html);
		expect(results[0]?.title).toBe("TypeScript's async");
		expect(results[0]?.snippet).toBe("Learn TypeScript & async.");
	});

	it("returns empty array for no results", () => {
		const results = parseSearchResults("<html><body>No results found</body></html>");
		expect(results).toHaveLength(0);
	});

	it("limits to maxResults", () => {
		const html = Array.from({ length: 20 })
			.map(
				(_, i) => `
<div class="result">
  <h2 class="result__title"><a class="result__a" href="https://x.com/${i}">R${i}</a></h2>
  <a class="result__snippet" href="https://x.com/${i}">Snippet ${i}</a>
</div>`,
			)
			.join("");

		const results = parseSearchResults(html, 5);
		expect(results).toHaveLength(5);
	});
});
