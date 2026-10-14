/** Resolve to `fallback` when `work` rejects or doesn't settle within `timeoutMs`. */
export const settleWithin = <T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> =>
	new Promise((done) => {
		const timer = setTimeout(done, timeoutMs, fallback);
		const finish = (value: T) => {
			clearTimeout(timer);
			done(value);
		};
		work.then(finish, () => finish(fallback));
	});
