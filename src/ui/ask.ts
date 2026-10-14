import type { Interface } from "node:readline/promises";

const PROMPT_CLOSED = "PromptClosedError";

/** True when `ask` gave up because the user closed the prompt (Ctrl+C, Ctrl+D). */
export const isPromptClosed = (error: unknown): boolean =>
	error instanceof Error && error.name === PROMPT_CLOSED;

const promptClosed = (): Error => Object.assign(new Error("input closed"), { name: PROMPT_CLOSED });

const isUseAfterClose = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "ERR_USE_AFTER_CLOSE";

/**
 * `rl.question` that rejects once the interface closes. Node never settles a question that is
 * pending on close, so the caller would hang until the process dies with exit code 13.
 */
export const ask = async (rl: Interface, query: string): Promise<string> => {
	const closed = new AbortController();
	const abort = () => closed.abort();
	rl.once("close", abort);
	try {
		return await rl.question(query, { signal: closed.signal });
	} catch (error) {
		throw closed.signal.aborted || isUseAfterClose(error) ? promptClosed() : error;
	} finally {
		rl.off("close", abort);
	}
};
