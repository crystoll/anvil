import { describe, expect, it } from "vitest";
import { readWithTimeout } from "./stream-reader.js";

describe("stream reader cancellation", () => {
	it("cancels a pending read when the signal aborts", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => {}),
			cancel: () => {
				cancelled = true;
			},
		});
		const controller = new AbortController();
		const results = (async () => {
			const readResults = [];
			for await (const result of readWithTimeout(
				body.getReader(),
				10_000,
				10_000,
				controller.signal,
			)) {
				readResults.push(result);
			}
			return readResults;
		})();

		controller.abort();

		await expect(results).resolves.toEqual([{ kind: "cancelled" }]);
		expect(cancelled).toBe(true);
	});
});
