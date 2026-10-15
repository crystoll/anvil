import type { EngineEvent } from "../engine/engine.js";
import type { ProviderError, StreamChunk } from "../provider/types.js";

const RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

export type RetryStreamEvent =
	| { kind: "event"; event: EngineEvent }
	| {
			kind: "retry";
			retry: number;
			total: number;
			delayMs: number;
			error: ProviderError;
	  };

const emitEvents = function* (events: readonly EngineEvent[]): Generator<RetryStreamEvent> {
	for (const event of events) yield { kind: "event", event };
};

const shouldRetry = (
	event: EngineEvent,
	outputStarted: boolean,
	retries: number,
): event is Extract<EngineEvent, { kind: "error" }> =>
	event.kind === "error" &&
	!outputStarted &&
	retries < RETRY_DELAYS_MS.length &&
	isRetryable(event.error);

const streamAttempt = async function* (
	createStream: () => AsyncIterable<EngineEvent>,
	retries: number,
): AsyncGenerator<RetryStreamEvent, ProviderError | undefined> {
	let outputStarted = false;
	const pendingEvents: EngineEvent[] = [];

	for await (const event of createStream()) {
		if (event.kind === "chunk" && hasResponseToken(event.chunk)) {
			outputStarted = true;
			yield* emitEvents(pendingEvents);
			pendingEvents.length = 0;
			yield { kind: "event", event };
			continue;
		}
		if (shouldRetry(event, outputStarted, retries)) return event.error;
		if (outputStarted) yield { kind: "event", event };
		else pendingEvents.push(event);
	}

	yield* emitEvents(pendingEvents);
	return undefined;
};

/** Retry transient stream failures only while the model has not produced a response token. */
export async function* retryBeforeFirstToken(
	createStream: () => AsyncIterable<EngineEvent>,
	signal: AbortSignal,
): AsyncGenerator<RetryStreamEvent> {
	let retries = 0;
	while (!signal.aborted) {
		const error = yield* streamAttempt(createStream, retries);
		if (!error || signal.aborted) return;
		const delayMs = RETRY_DELAYS_MS[retries];
		if (delayMs === undefined) return;
		retries++;
		yield { kind: "retry", retry: retries, total: RETRY_DELAYS_MS.length, delayMs, error };
		if (!(await waitForDelay(delayMs, signal))) return;
	}
}

const hasResponseToken = (chunk: StreamChunk): boolean =>
	Boolean(chunk.content || chunk.reasoning || chunk.toolCall);

const isRetryable = (error: ProviderError): boolean =>
	error.kind === "connection" ||
	error.kind === "timeout" ||
	(error.kind === "api" && error.status === 503);

const waitForDelay = (delayMs: number, signal: AbortSignal): Promise<boolean> =>
	new Promise((resolve) => {
		if (signal.aborted) {
			resolve(false);
			return;
		}

		let timer: ReturnType<typeof setTimeout>;
		const finish = (shouldRetry: boolean): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(shouldRetry);
		};
		const onAbort = (): void => finish(false);
		timer = setTimeout(() => finish(true), delayMs);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
