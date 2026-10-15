import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCmd } from "./builtins.js";

const ROOT = join(tmpdir(), `anvil-run-cmd-test-${process.pid}`);
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const nodeCommand = (script: string): string =>
	`${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
const pause = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

const readPidWhenReady = async (path: string): Promise<number> => {
	const contents = await readFileWhenReady(path);
	return Number(contents);
};

const readFileWhenReady = async (path: string): Promise<string> => {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (existsSync(path)) return readFileSync(path, "utf-8");
		await pause(10);
	}
	throw new Error(`command did not write ${path}`);
};

const isProcessRunning = (pid: number): boolean => {
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
			const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ", 1)[0];
			return state !== undefined && state !== "Z";
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
	}

	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
};

const waitForProcessExit = async (pid: number, timeoutMs = 1000): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessRunning(pid)) return true;
		await pause(10);
	}
	return false;
};

beforeEach(() => mkdirSync(ROOT, { recursive: true }));
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("run_cmd", () => {
	it("terminates a running command when its signal is aborted", async () => {
		const controller = new AbortController();
		const markerFile = join(ROOT, "started.txt");
		const execution = runCmd.execute(
			{
				command: nodeCommand(
					`require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "ready"); setInterval(() => {}, 1000)`,
				),
			},
			{ signal: controller.signal, projectRoot: ROOT },
		);

		await readFileWhenReady(markerFile);
		const startedAt = Date.now();
		controller.abort();
		const result = await execution;

		expect(result).toContain("Cancelled");
		expect(Date.now() - startedAt).toBeLessThan(1000);
	});

	it("kills grandchildren in the command's process group", async () => {
		const pidFile = join(ROOT, "child.pid");
		const controller = new AbortController();
		const command = `sleep 100 & echo $! > ${shellQuote(pidFile)}; wait`;
		const execution = runCmd.execute({ command }, { signal: controller.signal, projectRoot: ROOT });
		const childPid = await readPidWhenReady(pidFile);

		controller.abort();
		const result = await execution;

		expect(result).toContain("Cancelled by user");
		expect(await waitForProcessExit(childPid)).toBe(true);
	});

	it("escalates to SIGKILL when a descendant survives SIGTERM", async () => {
		const pidFile = join(ROOT, "child.pid");
		const controller = new AbortController();
		const execution = runCmd.execute(
			{ command: `trap '' TERM; sleep 100 & echo $! > ${shellQuote(pidFile)}; wait` },
			{ signal: controller.signal, projectRoot: ROOT },
		);
		const childPid = await readPidWhenReady(pidFile);

		const cancelledAt = Date.now();
		controller.abort();
		await execution;

		expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(1500);
		expect(await waitForProcessExit(childPid, 4000)).toBe(true);
	});

	it("closes stdin so commands that read it can finish", async () => {
		const command = nodeCommand(
			'process.stdin.on("end", () => console.log("stdin ended")); process.stdin.resume()',
		);
		const result = await runCmd.execute(
			{ command },
			{ signal: new AbortController().signal, projectRoot: ROOT },
		);

		expect(result).toContain("Exit code: 0");
		expect(result).toContain("stdin ended");
	});

	it("sets non-interactive environment variables for commands", async () => {
		const command = nodeCommand(
			"console.log(JSON.stringify({ CI: process.env.CI, PAGER: process.env.PAGER, GIT_PAGER: process.env.GIT_PAGER, GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT }))",
		);
		const result = await runCmd.execute(
			{ command },
			{ signal: new AbortController().signal, projectRoot: ROOT },
		);

		expect(result).toContain(
			'{"CI":"1","PAGER":"cat","GIT_PAGER":"cat","GIT_TERMINAL_PROMPT":"0"}',
		);
	});

	it("reports non-zero exit codes and keeps stderr output", async () => {
		const result = await runCmd.execute(
			{ command: `${nodeCommand('console.error("failure")')}; exit 7` },
			{ signal: new AbortController().signal, projectRoot: ROOT },
		);

		expect(result).toContain("Exit code: 7");
		expect(result).toContain("failure");
	});

	it("drains output while retaining the head and tail around an omission marker", async () => {
		const command = nodeCommand(
			'process.stdout.write("H".repeat(3000) + "M".repeat(2 * 1024 * 1024) + "T".repeat(3000))',
		);
		const result = await runCmd.execute(
			{ command },
			{ signal: new AbortController().signal, projectRoot: ROOT },
		);

		expect(result).toContain("Exit code: 0");
		expect(result).toContain("H".repeat(2000));
		expect(result).toContain("T".repeat(3000));
		expect(result).toContain("… 2095152 chars omitted …");
		expect(result.length).toBeLessThan(9000);
	});

	it("terminates a running command when it times out", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const execution = runCmd.execute(
				{ command: nodeCommand("setInterval(() => {}, 1000)") },
				{ signal: new AbortController().signal, projectRoot: ROOT },
			);

			await vi.advanceTimersByTimeAsync(300_000);
			const result = await execution;

			expect(result).toContain("Timed out after 300 s");
			expect(result).toMatch(/SIGTERM|SIGKILL/);
		} finally {
			vi.useRealTimers();
		}
	});
});
