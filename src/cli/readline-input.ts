import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

type QueuedLine = { sequence: number; text: string };
type Waiter = {
	afterSequence: number;
	resolve: (line: string | undefined) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
};

export type ReadlineInput = {
	prompt: (
		query: string,
		options?: { onlyNew?: boolean; signal?: AbortSignal },
	) => Promise<string | undefined>;
	clearQueue: () => number;
	queuedCount: () => number;
	onInterrupt: (listener: () => void) => () => void;
	close: () => void;
};

/** Buffer lines independently of prompts so input typed during model work isn't discarded. */
export const createReadlineInput = (input: Readable, output: Writable): ReadlineInput => {
	const readline = createInterface({ input, output });
	const queuedLines: QueuedLine[] = [];
	const waiters: Waiter[] = [];
	const interruptListeners = new Set<() => void>();
	let sequence = 0;
	let closed = false;

	const settleWaiter = (waiter: Waiter, line: string | undefined): void => {
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.resolve(line);
	};

	const onLine = (text: string): void => {
		sequence++;
		const waiterIndex = waiters.findIndex((waiter) => sequence > waiter.afterSequence);
		const waiter = waiterIndex >= 0 ? waiters.splice(waiterIndex, 1)[0] : undefined;
		if (waiter) settleWaiter(waiter, text);
		else queuedLines.push({ sequence, text });
	};

	readline.on("line", onLine);
	readline.on("close", () => {
		closed = true;
		for (const waiter of waiters.splice(0)) settleWaiter(waiter, undefined);
	});
	readline.on("SIGINT", () => {
		for (const listener of interruptListeners) listener();
	});

	const prompt: ReadlineInput["prompt"] = (query, options = {}) => {
		const afterSequence = options.onlyNew ? sequence : -1;
		output.write(query);
		const queuedIndex = queuedLines.findIndex((line) => line.sequence > afterSequence);
		const queued = queuedIndex >= 0 ? queuedLines.splice(queuedIndex, 1)[0] : undefined;
		if (queued) return Promise.resolve(queued.text);
		if (closed || options.signal?.aborted) return Promise.resolve(undefined);

		return new Promise((resolve) => {
			const waiter: Waiter = { afterSequence, resolve };
			if (options.signal) {
				const onAbort = () => {
					const waiterIndex = waiters.indexOf(waiter);
					if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
					settleWaiter(waiter, undefined);
				};
				waiter.signal = options.signal;
				waiter.onAbort = onAbort;
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
			waiters.push(waiter);
			if (options.signal?.aborted) waiter.onAbort?.();
		});
	};

	return {
		prompt,
		clearQueue: () => queuedLines.splice(0).length,
		queuedCount: () => queuedLines.length,
		onInterrupt: (listener) => {
			interruptListeners.add(listener);
			return () => interruptListeners.delete(listener);
		},
		close: () => readline.close(),
	};
};
