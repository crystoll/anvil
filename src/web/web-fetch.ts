import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { err, ok, type Result } from "neverthrow";

const DEFAULT_MAX_LENGTH = 8000;
const MAX_ALLOWED_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const normalizeHostname = (hostname: string): string => hostname.toLowerCase().replace(/\.$/, "");

/** Check whether a URL uses HTTP(S) and its exact hostname is allowed. */
export const isAllowedWebUrl = (value: string, allowedDomains: readonly string[]): boolean => {
	const url = new URL(value);
	return (
		(url.protocol === "http:" || url.protocol === "https:") &&
		allowedDomains.some((domain) => normalizeHostname(domain) === normalizeHostname(url.hostname))
	);
};

const fetchWithinAllowedDomains = async (
	url: URL,
	options: RequestInit,
	allowedDomains: readonly string[],
	redirectsRemaining: number,
): Promise<Result<Response, string>> => {
	const response = await fetch(url, options);
	if (!REDIRECT_STATUSES.has(response.status)) return ok(response);
	const location = response.headers.get("location");
	if (!location) return ok(response);

	const redirectUrl = new URL(location, url);
	if (!isAllowedWebUrl(redirectUrl.toString(), allowedDomains)) {
		await response.body?.cancel();
		return err(`Redirect blocked: ${redirectUrl.hostname} is not in web.allow_domains`);
	}
	if (redirectsRemaining === 0) {
		await response.body?.cancel();
		return err("Redirect blocked: maximum redirect count exceeded");
	}
	await response.body?.cancel();
	return fetchWithinAllowedDomains(redirectUrl, options, allowedDomains, redirectsRemaining - 1);
};

const fetchResponse = async (
	url: string,
	options: RequestInit,
	allowedDomains?: readonly string[],
): Promise<Result<Response, string>> => {
	if (!allowedDomains) return ok(await fetch(url, options));
	if (!isAllowedWebUrl(url, allowedDomains))
		return err(`Fetch blocked: ${new URL(url).hostname} is not in web.allow_domains`);
	return fetchWithinAllowedDomains(new URL(url), options, allowedDomains, MAX_ALLOWED_REDIRECTS);
};

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
	signal?: AbortSignal,
	allowedDomains?: readonly string[],
): Promise<Result<string, string>> => {
	try {
		const timeoutSignal = AbortSignal.timeout(10000);
		const options: RequestInit = {
			headers: { "User-Agent": "Mozilla/5.0 (compatible; Anvil/1.0)" },
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
			...(allowedDomains ? { redirect: "manual" as const } : {}),
		};
		const responseResult = await fetchResponse(url, options, allowedDomains);
		if (responseResult.isErr()) return err(responseResult.error);
		const response = responseResult.value;
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
