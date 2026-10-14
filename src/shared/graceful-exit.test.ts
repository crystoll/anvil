import { EventEmitter } from "node:events";
import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { createGracefulExit } from "./graceful-exit.js";

const setup = (overrides: Partial<Parameters<typeof createGracefulExit>[0]> = {}) => {
	const steps: string[] = [];
	const source = new EventEmitter();
	const deps = {
		cancel: vi.fn(() => steps.push("cancel")),
		closeUi: vi.fn(() => steps.push("close")),
		flush: vi.fn(() => {
			steps.push("flush");
			return ok("session-id");
		}),
		shutdown: vi.fn(async () => {
			steps.push("shutdown");
		}),
		print: vi.fn<(text: string) => void>(),
		exit: vi.fn((code: number) => steps.push(`exit:${code}`)),
	};
	const gracefulExit = createGracefulExit({ ...deps, ...overrides });

	return { deps, gracefulExit, source, steps };
};

describe("createGracefulExit", () => {
	it("cancels, closes the UI, saves, shuts down, then exits", async () => {
		const { gracefulExit, steps } = setup();

		await gracefulExit.run();

		expect(steps).toEqual(["cancel", "close", "flush", "shutdown", "exit:0"]);
	});

	it("runs cleanup once when multiple exit requests arrive", async () => {
		const { deps, gracefulExit } = setup();

		await Promise.all([gracefulExit.run(0), gracefulExit.run(1)]);

		expect(deps.cancel).toHaveBeenCalledTimes(1);
		expect(deps.closeUi).toHaveBeenCalledTimes(1);
		expect(deps.flush).toHaveBeenCalledTimes(1);
		expect(deps.shutdown).toHaveBeenCalledTimes(1);
		expect(deps.exit).toHaveBeenCalledWith(0);
		expect(deps.exit).toHaveBeenCalledTimes(1);
	});

	it("continues shutdown and exit when saving fails", async () => {
		const { deps, gracefulExit, steps } = setup({
			flush: vi.fn(() => {
				steps.push("flush");
				return err("disk full");
			}),
		});

		await gracefulExit.run();

		expect(deps.print).toHaveBeenCalledWith(expect.stringContaining("disk full"));
		expect(steps).toEqual(["cancel", "close", "flush", "shutdown", "exit:0"]);
	});

	it("continues cleanup when cancelling or closing the UI throws", async () => {
		const { deps, gracefulExit, steps } = setup({
			cancel: vi.fn(() => {
				steps.push("cancel");
				throw new Error("cancel failed");
			}),
			closeUi: vi.fn(() => {
				steps.push("close");
				throw new Error("close failed");
			}),
		});

		await gracefulExit.run();

		expect(deps.print).toHaveBeenCalledWith(expect.stringContaining("cancel failed"));
		expect(deps.print).toHaveBeenCalledWith(expect.stringContaining("close failed"));
		expect(steps).toEqual(["cancel", "close", "flush", "shutdown", "exit:0"]);
	});

	it("exits even when asynchronous service shutdown rejects", async () => {
		const { deps, gracefulExit, steps } = setup({
			shutdown: vi.fn(async () => {
				steps.push("shutdown");
				throw new Error("shutdown failed");
			}),
		});

		await gracefulExit.run();

		expect(deps.print).toHaveBeenCalledWith(expect.stringContaining("shutdown failed"));
		expect(steps).toEqual(["cancel", "close", "flush", "shutdown", "exit:0"]);
	});

	it.each([
		["SIGINT", 130],
		["SIGHUP", 129],
		["SIGTERM", 143],
	] as const)("gracefully exits on %s", async (signal, code) => {
		const { deps, gracefulExit, source } = setup();
		const uninstall = gracefulExit.install(source);

		source.emit(signal);
		await vi.waitFor(() => expect(deps.exit).toHaveBeenCalledWith(code));

		expect(deps.flush).toHaveBeenCalledTimes(1);
		uninstall();
	});

	it("removes signal listeners when uninstalled", () => {
		const { gracefulExit, source } = setup();
		const uninstall = gracefulExit.install(source);

		uninstall();

		expect(source.listenerCount("SIGINT")).toBe(0);
		expect(source.listenerCount("SIGHUP")).toBe(0);
		expect(source.listenerCount("SIGTERM")).toBe(0);
	});
});
