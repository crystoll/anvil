import { spawn } from "node:child_process";
import type { HookDef } from "./agents.js";

export type HookContext = Record<string, unknown>;

/** Run hooks sequentially. Returns denial reason (string) if any blocking hook fails, undefined otherwise. */
export const runHooks = async (
	hooks: HookDef[],
	context: HookContext,
): Promise<string | undefined> => {
	for (const hook of hooks) {
		if (hook.matcher && context.tool_name !== hook.matcher) continue;

		if (hook.async) {
			fireAndForget(hook.command, context);
			continue;
		}

		const result = await executeHook(hook.command, context, hook.timeout ?? 5);
		if (result.exitCode !== 0) {
			return result.stdout.trim() || `Hook timed out or failed (exit ${result.exitCode})`;
		}
	}
	return undefined;
};

const fireAndForget = (command: string, context: HookContext): void => {
	const child = spawn("sh", ["-c", command], {
		stdio: ["pipe", "ignore", "ignore"],
		detached: true,
	});
	child.stdin.write(JSON.stringify(context));
	child.stdin.end();
	child.unref();
};

type HookResult = { exitCode: number; stdout: string };

const executeHook = (
	command: string,
	context: HookContext,
	timeoutSec: number,
): Promise<HookResult> =>
	new Promise((resolve) => {
		const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let done = false;

		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				child.kill("SIGTERM");
				resolve({ exitCode: 1, stdout: "Hook timed out" });
			}
		}, timeoutSec * 1000);

		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stdin.write(JSON.stringify(context));
		child.stdin.end();

		child.on("close", (code) => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve({ exitCode: code ?? 1, stdout });
			}
		});

		child.on("error", () => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve({ exitCode: 1, stdout: "Hook failed to spawn" });
			}
		});
	});
