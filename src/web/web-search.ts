import { parseHTML } from "linkedom";
import { err, ok, type Result } from "neverthrow";

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
	const links = Array.from(document.querySelectorAll(".result__a"));
	const snippets = Array.from(document.querySelectorAll(".result__snippet"));

	return links
		.slice(0, maxResults)
		.map((link, i) => ({
			title: link?.textContent?.trim() ?? "",
			url: link?.getAttribute("href") ?? "",
			snippet: snippets[i]?.textContent?.trim() ?? "",
		}))
		.filter((r) => r.url && r.title);
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
