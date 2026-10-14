import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ask, isPromptClosed } from "./ask.js";

const createPrompt = () => {
	const input = new PassThrough();
	const rl = createInterface({ input, output: new PassThrough(), terminal: false });
	return { input, rl };
};

describe("ask", () => {
	it("F20: rejects when the interface closes while a question is pending", async () => {
		const { rl } = createPrompt();
		const answer = ask(rl, "> ");
		rl.close();
		await expect(answer).rejects.toSatisfy(isPromptClosed);
	}, 1000);

	it("rejects when asked after the interface closed", async () => {
		const { rl } = createPrompt();
		rl.close();
		await expect(ask(rl, "> ")).rejects.toSatisfy(isPromptClosed);
	});

	it("resolves with the answer and stops watching for close", async () => {
		const { input, rl } = createPrompt();
		const listeners = rl.listenerCount("close");
		const answer = ask(rl, "> ");
		input.write("hello\n");
		expect(await answer).toBe("hello");
		expect(rl.listenerCount("close")).toBe(listeners);
		rl.close();
	});
});

describe("isPromptClosed", () => {
	it("is false for other errors", () => {
		expect(isPromptClosed(new Error("boom"))).toBe(false);
		expect(isPromptClosed("input closed")).toBe(false);
	});
});
