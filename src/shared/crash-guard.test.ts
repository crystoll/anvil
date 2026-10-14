import { EventEmitter } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../index.js";
import {
	type CrashGuardDeps,
	formatCrashReport,
	installCrashGuard,
	writeCrashLog,
} from "./crash-guard.js";

const setup = (overrides: Partial<CrashGuardDeps> = {}) => {
	const steps: string[] = [];
	const track =
		<T>(step: string, value: T) =>
		() => {
			steps.push(step);
			return value;
		};
	const deps = {
		restoreTerminal: vi.fn(track("restore", undefined)),
		flush: vi.fn<() => Result<string | undefined, string>>(track("flush", ok("abc123"))),
		writeLog: vi.fn<(report: string) => string>(track("log", "/logs/crash-1.log")),
		print: vi.fn<(text: string) => void>(),
		exit: vi.fn<(code: number) => void>(track("exit", undefined)),
	};
	const source = new EventEmitter();
	const uninstall = installCrashGuard(source, { ...deps, ...overrides });
	const printed = () => deps.print.mock.calls.map(([text]) => text).join("");
	const report = () => deps.writeLog.mock.calls[0]?.[0] ?? "";
	return { source, deps, steps, uninstall, printed, report };
};

const failing = (message: string) => () => {
	throw new Error(message);
};

describe("installCrashGuard", () => {
	it.each(["uncaughtException", "unhandledRejection"] as const)(
		"F5: on %s, restores the terminal, saves the session, writes a log and exits 1",
		(event) => {
			const { source, deps, steps, report } = setup();

			source.emit(event, new Error("boom"));

			expect(steps).toEqual(["restore", "flush", "log", "exit"]);
			expect(deps.exit).toHaveBeenCalledWith(1);
			expect(report()).toContain("Error: boom");
		},
	);

	it("tells the user what happened, how to resume and where the log is", () => {
		const { source, printed } = setup();

		source.emit("uncaughtException", new Error("boom"));

		expect(printed()).toContain("anvil crashed: boom");
		expect(printed()).toContain("anvil --resume");
		expect(printed()).toContain("/logs/crash-1.log");
	});

	it("doesn't offer to resume when there was nothing to save", () => {
		const { source, printed } = setup({ flush: () => ok(undefined) });

		source.emit("uncaughtException", new Error("boom"));

		expect(printed()).not.toContain("--resume");
	});

	it("reports a session that couldn't be saved", () => {
		const { source, printed, report } = setup({ flush: () => err("disk full") });

		source.emit("unhandledRejection", new Error("boom"));

		expect(printed()).toContain("disk full");
		expect(report()).toContain("disk full");
	});

	it("prints the whole report when the log can't be written", () => {
		const { source, printed } = setup({ writeLog: failing("read-only") });

		source.emit("uncaughtException", new Error("boom"));

		expect(printed()).toContain("read-only");
		expect(printed()).toMatch(/Error: boom\n\s+at /);
	});

	it.each([
		["restoreTerminal", { restoreTerminal: failing("no tty") }],
		["flush", { flush: failing("disk full") }],
		["writeLog", { writeLog: failing("read-only") }],
		["print", { print: failing("EPIPE") }],
	] as const)("still exits 1 when %s throws", (_step, overrides) => {
		const { source, deps } = setup(overrides);

		source.emit("uncaughtException", new Error("boom"));

		expect(deps.exit).toHaveBeenCalledWith(1);
	});

	it("handles only the first crash", () => {
		const { source, deps } = setup();

		source.emit("uncaughtException", new Error("first"));
		source.emit("unhandledRejection", new Error("second"));

		expect(deps.flush).toHaveBeenCalledTimes(1);
		expect(deps.exit).toHaveBeenCalledTimes(1);
	});

	it("stops listening once uninstalled", () => {
		const { source, uninstall } = setup();

		uninstall();

		expect(source.listenerCount("uncaughtException")).toBe(0);
		expect(source.listenerCount("unhandledRejection")).toBe(0);
	});
});

describe("formatCrashReport", () => {
	const at = new Date("2026-05-07T10:00:00.000Z");

	it("records the version, the event, the time, the session and the stack", () => {
		const report = formatCrashReport({
			event: "unhandledRejection",
			error: new Error("boom"),
			session: ok("abc123"),
			at,
		});

		expect(report).toContain(`anvil ${VERSION}`);
		expect(report).toContain("unhandledRejection");
		expect(report).toContain("2026-05-07T10:00:00.000Z");
		expect(report).toContain("abc123");
		expect(report).toMatch(/Error: boom\n\s+at /);
	});

	it("describes a rejection that isn't an error", () => {
		const report = formatCrashReport({
			event: "unhandledRejection",
			error: { code: 42 },
			session: ok(undefined),
			at,
		});

		expect(report).toContain("code: 42");
	});
});

describe("writeCrashLog", () => {
	const logsRoot = join(tmpdir(), `anvil-crash-test-${process.pid}`);
	afterEach(() => rmSync(logsRoot, { recursive: true, force: true }));

	it("writes the report to a new timestamped file, creating the folder", () => {
		const path = writeCrashLog(join(logsRoot, "logs"))("the report");

		expect(basename(path)).toMatch(/^crash-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.log$/);
		expect(readFileSync(path, "utf-8")).toBe("the report");
	});
});
