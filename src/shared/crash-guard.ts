import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { Result } from "neverthrow";
import { VERSION } from "../index.js";

export type CrashEvent = "uncaughtException" | "unhandledRejection";

/** The part of crash handling that only the running UI knows how to do. */
export type CrashCleanup = {
	/** Saves the conversation and returns its session id, or undefined when there's nothing to save. */
	flush: () => string | undefined;
	restoreTerminal?: () => void;
};

export type CrashGuardDeps = Required<CrashCleanup> & {
	/** Stores the report and returns where it went. */
	writeLog: (report: string) => string;
	print: (text: string) => void;
	exit: (code: number) => void;
};

export type Crash = {
	event: CrashEvent;
	error: unknown;
	session: Result<string | undefined, Error>;
	at: Date;
};

type CrashListener = (error: unknown) => void;

type CrashSource = {
	on: (event: CrashEvent, listener: CrashListener) => unknown;
	off: (event: CrashEvent, listener: CrashListener) => unknown;
};

const CRASH_EVENTS: readonly CrashEvent[] = ["uncaughtException", "unhandledRejection"];
const SHOW_CURSOR = "\x1b[?25h";

const toError = (cause: unknown): Error =>
	cause instanceof Error ? cause : new Error(String(cause));

/** A failed cleanup step must not stop the ones after it. */
const attempt = <T>(step: () => T): Result<T, Error> => Result.fromThrowable(step, toError)();

const summarize = (error: unknown): string =>
	error instanceof Error ? error.message : inspect(error);

const describeSession = (session: Crash["session"]): string =>
	session.match(
		(id) => (id ? `${id} (saved)` : "nothing to save"),
		(error) => `not saved: ${error.message}`,
	);

/** Everything needed to debug a crash after the terminal is gone. */
export const formatCrashReport = ({ event, error, session, at }: Crash): string =>
	[
		`anvil ${VERSION} crashed at ${at.toISOString()}`,
		`event: ${event}`,
		`node: ${process.version} ${process.platform}/${process.arch}`,
		`session: ${describeSession(session)}`,
		"",
		inspect(error, { depth: 5 }),
		"",
	].join("\n");

const crashNotice = (crash: Crash, log: Result<string, Error>, report: string): string =>
	[
		`\n✗ anvil crashed: ${summarize(crash.error)}`,
		...crash.session.match(
			(id) => (id ? ["  The session was saved. Continue it with: anvil --resume"] : []),
			(error) => [`  The session couldn't be saved: ${error.message}`],
		),
		log.match(
			(path) => `  Details: ${path}`,
			(error) => `  The crash log couldn't be written (${error.message}):\n\n${report}`,
		),
		"",
	].join("\n");

const handleCrash = (event: CrashEvent, error: unknown, deps: CrashGuardDeps): void => {
	attempt(deps.restoreTerminal);
	const crash: Crash = { event, error, session: attempt(deps.flush), at: new Date() };
	const report = formatCrashReport(crash);
	const log = attempt(() => deps.writeLog(report));
	attempt(() => deps.print(crashNotice(crash, log, report)));
	deps.exit(1);
};

/**
 * Turns an uncaught error into a saved session, a crash log and exit code 1 instead of a dead
 * terminal. Only the first crash is handled, so a failing cleanup can't start another round.
 */
export const installCrashGuard = (source: CrashSource, deps: CrashGuardDeps): (() => void) => {
	let crashed = false;
	const listeners = CRASH_EVENTS.map((event) => {
		const listener: CrashListener = (error) => {
			if (crashed) return;
			crashed = true;
			handleCrash(event, error, deps);
		};
		source.on(event, listener);
		return { event, listener };
	});
	return () => {
		for (const { event, listener } of listeners) source.off(event, listener);
	};
};

/** Writes the report to `crash-<timestamp>.log` in `dir` and returns its path. */
export const writeCrashLog =
	(dir: string) =>
	(report: string): string => {
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `crash-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
		writeFileSync(path, report, "utf-8");
		return path;
	};

/** Hands the shell a usable terminal even when the UI couldn't tidy up after itself. */
const resetTerminal = (): void => {
	if (process.stdin.isTTY) process.stdin.setRawMode(false);
	if (process.stdout.isTTY) process.stdout.write(SHOW_CURSOR);
};

/** Pipe writes are async on macOS, so exit only once the notice is out. */
const exitAfterStderr = (code: number): void => {
	process.exitCode = code;
	process.stderr.write("", () => process.exit(code));
};

/** Guards this process, with crash logs in `~/.anvil/logs`. */
export const guardProcess = ({ flush, restoreTerminal }: CrashCleanup): (() => void) =>
	installCrashGuard(process, {
		flush,
		restoreTerminal: () => {
			if (restoreTerminal) attempt(restoreTerminal);
			resetTerminal();
		},
		writeLog: writeCrashLog(join(homedir(), ".anvil", "logs")),
		print: (text) => process.stderr.write(text),
		exit: exitAfterStderr,
	});
