import { Result, ResultAsync, type Result as ResultType } from "neverthrow";

const SIGNALS = ["SIGINT", "SIGHUP", "SIGTERM"] as const;
type ExitSignal = (typeof SIGNALS)[number];

type SignalSource = {
	on: (signal: ExitSignal, listener: () => void) => unknown;
	off: (signal: ExitSignal, listener: () => void) => unknown;
};

type GracefulExitDeps = {
	cancel: () => void;
	closeUi: () => void;
	flush: () => ResultType<string | undefined, string>;
	shutdown: () => Promise<void>;
	print: (message: string) => void;
	exit: (code: number) => void;
};

const toError = (cause: unknown): Error =>
	cause instanceof Error ? cause : new Error(String(cause));

const signalExitCode = (signal: ExitSignal): number => {
	if (signal === "SIGINT") return 130;
	if (signal === "SIGHUP") return 129;
	return 143;
};

/** Runs UI cleanup once, then saves the session and stops services before exiting. */
export const createGracefulExit = (deps: GracefulExitDeps) => {
	let exitPromise: Promise<void> | undefined;

	const report = (step: string, error: Error): void => {
		Result.fromThrowable(
			() => deps.print(`\n⚠ ${step} failed during shutdown: ${error.message}\n`),
			toError,
		)();
	};

	const runStep = (step: string, action: () => void): void => {
		Result.fromThrowable(action, toError)().mapErr((error) => report(step, error));
	};

	const run = (code = 0): Promise<void> => {
		exitPromise ??= Promise.resolve().then(async () => {
			runStep("Cancellation", deps.cancel);
			runStep("UI cleanup", deps.closeUi);
			const saveResult = Result.fromThrowable(deps.flush, toError)().andThen((result) =>
				result.mapErr((message) => new Error(message)),
			);
			saveResult.mapErr((error) => report("Session save", error));
			await ResultAsync.fromPromise(Promise.resolve().then(deps.shutdown), toError).match(
				() => undefined,
				(error) => report("Service shutdown", error),
			);
			deps.exit(code);
		});
		return exitPromise;
	};

	const install = (source: SignalSource): (() => void) => {
		const listeners = SIGNALS.map((signal) => {
			const listener = () => {
				void run(signalExitCode(signal));
			};
			source.on(signal, listener);
			return { signal, listener };
		});
		return () => {
			for (const { signal, listener } of listeners) source.off(signal, listener);
		};
	};

	return { run, install };
};
