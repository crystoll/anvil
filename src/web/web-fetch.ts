import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { err, ok, type Result } from "neverthrow";

const DEFAULT_MAX_LENGTH = 8000;

/** Extract readable text content from HTML using Readability. */
export const extractReadable = (
	html: string,
	_url: string,
	maxLength = DEFAULT_MAX_LENGTH,
): Result<string, string> => {
	if (!html.trim()) return err("Empty HTML content");

	const { document } = parseHTML(html);
	const reader = new Readability(document, { charThreshold: 50 });
	const article = reader.parse();

	if (!article?.textContent) return err("Could not extract readable content");

	const title = article.title ? `# ${article.title}\n\n` : "";
	const text = `${title}${article.textContent.trim()}`;

	return ok(truncate(text, maxLength));
};

/** Fetch a URL and extract readable text. */
export const fetchAndExtract = async (
	url: string,
	maxLength = DEFAULT_MAX_LENGTH,
): Promise<Result<string, string>> => {
	try {
		const response = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0 (compatible; Anvil/1.0)" },
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) return err(`HTTP ${response.status}: ${response.statusText}`);
		const html = await response.text();
		return extractReadable(html, url, maxLength);
	} catch (e) {
		return err(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
	}
};

const truncate = (text: string, max: number): string => {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}...\n[truncated]`;
};
