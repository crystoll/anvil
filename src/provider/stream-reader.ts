export type StreamReadResult =
	| { kind: "chunk"; value: Uint8Array }
	| { kind: "end" }
	| { kind: "timeout" }
	| { kind: "cancelled" }
	| { kind: "error"; cause: unknown };

/** Read one network chunk at a time, distinguishing stalls, aborts, drops and normal EOF. */
export async function* readWithTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeout: number,
	signal?: AbortSignal,
): AsyncGenerator<StreamReadResult> {
	let completed = false;
	try {
		while (true) {
			const result = await readNext(reader, timeout, signal);
			if (result.kind !== "chunk") {
				completed = true;
				yield result;
				return;
			}
			yield result;
		}
	} finally {
		if (!completed) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

const readNext = async (
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeout: number,
	signal?: AbortSignal,
): Promise<StreamReadResult> => {
	if (signal?.aborted) {
		await reader.cancel().catch(() => undefined);
		return { kind: "cancelled" };
	}

	const timeoutToken = Symbol("stream timeout");
	const abortToken = Symbol("stream cancellation");
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	let result: ReadableStreamReadResult<Uint8Array> | typeof timeoutToken | typeof abortToken;
	try {
		const abortPromise = signal
			? new Promise<typeof abortToken>((resolve) => {
					onAbort = () => resolve(abortToken);
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				})
			: new Promise<typeof abortToken>(() => {});
		result = await Promise.race([
			reader.read(),
			new Promise<typeof timeoutToken>((resolve) => {
				timer = setTimeout(() => resolve(timeoutToken), timeout);
			}),
			abortPromise,
		]);
	} catch (cause) {
		return signal?.aborted ? { kind: "cancelled" } : { kind: "error", cause };
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}

	if (result === timeoutToken) {
		await reader.cancel().catch(() => undefined);
		return { kind: "timeout" };
	}
	if (result === abortToken) {
		await reader.cancel().catch(() => undefined);
		return { kind: "cancelled" };
	}
	if (signal?.aborted) {
		await reader.cancel().catch(() => undefined);
		return { kind: "cancelled" };
	}
	return result.done ? { kind: "end" } : { kind: "chunk", value: result.value };
};
