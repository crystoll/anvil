import { parseHTML } from "linkedom";
import { type Result, err, ok } from "neverthrow";

const DDG_URL = "https://html.duckduckgo.com/html/";
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)";

export type SearchResult = {
	title: string;
	url: string;
	snippet: string;
};

/** Parse search results from DuckDuckGo HTML response. */
export const parseSearchResults = (html: string, maxResults = 10): SearchResult[] => {
	const { document } = parseHTML(html);
	const links = document.querySelectorAll(".result__a");
	const snippets = document.querySelectorAll(".result__snippet");
	const results: SearchResult[] = [];

	for (let i = 0; i < links.length && results.length < maxResults; i++) {
		const link = links[i];
		const snippet = snippets[i];
		const url = link?.getAttribute("href") ?? "";
		const title = link?.textContent?.trim() ?? "";
		if (!url || !title) continue;
		results.push({ title, url, snippet: snippet?.textContent?.trim() ?? "" });
	}
	return results;
};

/** Search DuckDuckGo and return structured results. */
export const searchWeb = async (
	query: string,
	maxResults = 10,
): Promise<Result<SearchResult[], string>> => {
	try {
		const body = new URLSearchParams({ q: query });
		const response = await fetch(DDG_URL, {
			method: "POST",
			headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) return err(`Search failed: HTTP ${response.status}`);
		const html = await response.text();
		if (html.includes("anomaly-modal")) return err("Search blocked by CAPTCHA");
		return ok(parseSearchResults(html, maxResults));
	} catch (e) {
		return err(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
	}
};
