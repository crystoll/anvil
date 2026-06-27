import { describe, expect, it } from "vitest";
import type { HookDef } from "./agents.js";
import { runHooks } from "./hooks.js";

describe("runHooks", () => {
	it("returns undefined when no hooks", async () => {
		const result = await runHooks([], { hook_event_name: "stop", cwd: "/tmp" });
		expect(result).toBeUndefined();
	});

	it("returns undefined for successful hook (exit 0)", async () => {
		const hooks: HookDef[] = [{ command: "exit 0", timeout: 3 }];
		const result = await runHooks(hooks, { hook_event_name: "stop", cwd: "/tmp" });
		expect(result).toBeUndefined();
	});

	it("returns denial reason for failed hook (exit 1)", async () => {
		const hooks: HookDef[] = [{ command: "echo 'not allowed' && exit 1", timeout: 3 }];
		const result = await runHooks(hooks, { hook_event_name: "preToolUse", cwd: "/tmp" });
		expect(result).toContain("not allowed");
	});

	it("skips hooks that dont match tool_name when matcher set", async () => {
		const hooks: HookDef[] = [{ command: "exit 1", timeout: 3, matcher: "run_cmd" }];
		const ctx = { hook_event_name: "preToolUse", cwd: "/tmp", tool_name: "read_file" };
		const result = await runHooks(hooks, ctx);
		expect(result).toBeUndefined();
	});

	it("fires hook when matcher matches tool_name", async () => {
		const hooks: HookDef[] = [{ command: "echo denied && exit 1", timeout: 3, matcher: "run_cmd" }];
		const ctx = { hook_event_name: "preToolUse", cwd: "/tmp", tool_name: "run_cmd" };
		const result = await runHooks(hooks, ctx);
		expect(result).toContain("denied");
	});

	it("returns denial on timeout", async () => {
		const hooks: HookDef[] = [{ command: "sleep 10", timeout: 1 }];
		const result = await runHooks(hooks, { hook_event_name: "preToolUse", cwd: "/tmp" });
		expect(result).toContain("timed out");
	});

	it("fires async hooks without waiting", async () => {
		const hooks: HookDef[] = [{ command: "sleep 10", async: true }];
		const start = Date.now();
		const result = await runHooks(hooks, { hook_event_name: "stop", cwd: "/tmp" });
		expect(Date.now() - start).toBeLessThan(500);
		expect(result).toBeUndefined();
	});
});
