import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineEvent } from "../engine/engine.js";
import type { ProviderError } from "../provider/types.js";
import { retryBeforeFirstToken } from "./retry.js";

const collect = async <T>(events: AsyncGenerator<T>): Promise<T[]> => {
	const result: T[] = [];
	for await (const event of events) result.push(event);
	return result;
};

const providerFailure = (error: ProviderError): EngineEvent => ({ kind: "error", error });

afterEach(() => {
	vi.useRealTimers();
});

describe("retryBeforeFirstToken", () => {
	it("retries connection, 503, and timeout errors with increasing delays", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		const stream = () => {
			attempts++;
			async function* events() {
				if (attempts === 1)
					yield providerFailure({ kind: "connection", message: "connection refused" });
				else if (attempts === 2)
					yield providerFailure({ kind: "api", status: 503, message: "loading" });
				else if (attempts === 3)
					yield providerFailure({ kind: "timeout", message: "model loading" });
				else
					yield {
						kind: "chunk",
						chunk: { content: "ready", done: false },
					} satisfies EngineEvent;
			}
			return events();
		};

		const events = collect(retryBeforeFirstToken(stream, new AbortController().signal));
		await vi.runAllTimersAsync();
		const output = await events;

		expect(attempts).toBe(4);
		expect(output.filter((event) => event.kind === "retry")).toMatchObject([
			{ retry: 1, total: 3, delayMs: 2000 },
			{ retry: 2, total: 3, delayMs: 5000 },
			{ retry: 3, total: 3, delayMs: 15000 },
		]);
		expect(output.at(-1)).toMatchObject({
			kind: "event",
			event: { kind: "chunk", chunk: { content: "ready" } },
		});
	});

	it("does not retry non-service API errors", async () => {
		let attempts = 0;
		const output = await collect(
			retryBeforeFirstToken(() => {
				attempts++;
				return (async function* () {
					yield providerFailure({ kind: "api", status: 500, message: "internal error" });
				})();
			}, new AbortController().signal),
		);

		expect(attempts).toBe(1);
		expect(output).toEqual([
			{
				kind: "event",
				event: providerFailure({ kind: "api", status: 500, message: "internal error" }),
			},
		]);
	});

	it("returns the final error after exhausting the retry budget", async () => {
		vi.useFakeTimers();
		let attempts = 0;
		const outputPromise = collect(
			retryBeforeFirstToken(() => {
				attempts++;
				return (async function* () {
					yield providerFailure({ kind: "connection", message: "connection refused" });
				})();
			}, new AbortController().signal),
		);
		await vi.runAllTimersAsync();
		const output = await outputPromise;

		expect(attempts).toBe(4);
		expect(output.filter((event) => event.kind === "retry")).toHaveLength(3);
		expect(output.at(-1)).toMatchObject({
			kind: "event",
			event: { kind: "error", error: { kind: "connection" } },
		});
	});

	it("does not retry after response content has started", async () => {
		let attempts = 0;
		const output = await collect(
			retryBeforeFirstToken(() => {
				attempts++;
				return (async function* () {
					yield {
						kind: "chunk",
						chunk: { content: "partial", done: false },
					} satisfies EngineEvent;
					yield providerFailure({ kind: "connection", message: "socket closed" });
				})();
			}, new AbortController().signal),
		);

		expect(attempts).toBe(1);
		expect(output.map((event) => event.kind)).toEqual(["event", "event"]);
	});

	it("cancels the backoff without starting another attempt", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		let attempts = 0;
		const stream = () => {
			attempts++;
			return (async function* () {
				yield providerFailure({ kind: "connection", message: "connection refused" });
			})();
		};
		const iterator = retryBeforeFirstToken(stream, controller.signal);

		await expect(iterator.next()).resolves.toMatchObject({
			value: { kind: "retry", retry: 1, delayMs: 2000 },
		});
		const waiting = iterator.next();
		controller.abort();

		await expect(waiting).resolves.toMatchObject({ done: true });
		expect(attempts).toBe(1);
	});
});
