import { describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "./client.js";
import { createDiagnosticInjector } from "./inject.js";
import type { LspManager } from "./manager.js";

const fakeManager = (fileChanged: LspManager["fileChanged"]): LspManager => ({
	supports: () => true,
	fileChanged,
	diagnosticsFor: async () => [],
	definition: async () => [],
	references: async () => [],
	hover: async () => undefined,
	documentSymbols: async () => [],
	rename: async () => [],
	shutdown: async () => {},
});

const typeError: Diagnostic = {
	line: 3,
	character: 1,
	severity: "error",
	message: "Type mismatch",
};

describe("createDiagnosticInjector", () => {
	it("appends diagnostics to a successful write", async () => {
		const inject = createDiagnosticInjector(
			fakeManager(async () => [typeError]),
			"/project",
		);

		const result = await inject("write_file", { path: "a.ts" }, "Wrote a.ts");

		expect(result).toContain("Type mismatch");
	});

	it("skips diagnostics when the write failed", async () => {
		const fileChanged = vi.fn(async () => [typeError]);
		const inject = createDiagnosticInjector(fakeManager(fileChanged), "/project");

		const result = await inject("edit_file", { path: "a.ts" }, "Error: Search string not found");

		expect(result).toBe("Error: Search string not found");
		expect(fileChanged).not.toHaveBeenCalled();
	});

	it("returns the original result when the server fails", async () => {
		const failing = fakeManager(async () => {
			throw new Error("ENOENT: no such file or directory");
		});
		const inject = createDiagnosticInjector(failing, "/project");

		expect(await inject("write_file", { path: "a.ts" }, "Wrote a.ts")).toBe("Wrote a.ts");
	});

	it("returns the original result when diagnostics don't arrive within 3 s", async () => {
		vi.useFakeTimers();
		try {
			const silent = fakeManager(() => new Promise(() => {}));
			const pending = createDiagnosticInjector(silent, "/project")(
				"write_file",
				{ path: "a.ts" },
				"Wrote a.ts",
			);

			await vi.advanceTimersByTimeAsync(3000);

			expect(await pending).toBe("Wrote a.ts");
		} finally {
			vi.useRealTimers();
		}
	});
});
