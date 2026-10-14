import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createReadlineInput } from "./readline-input.js";

const createHarness = () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const lines = createReadlineInput(input, output);
	return { input, lines, output };
};

describe("readline input queue", () => {
	it("returns lines queued while no prompt was active", async () => {
		const { input, lines } = createHarness();
		input.write("queued prompt\n");

		await expect(lines.prompt("> ")).resolves.toBe("queued prompt");
		expect(lines.queuedCount()).toBe(0);
		lines.close();
	});

	it("keeps generation-time lines out of approval prompts", async () => {
		const { input, lines } = createHarness();
		input.write("next user prompt\n");
		await expect(lines.prompt("> ")).resolves.toBe("next user prompt");
		input.write("queued during generation\n");

		let approvalSettled = false;
		const approval = lines.prompt("approve? ", { onlyNew: true }).then((answer) => {
			approvalSettled = true;
			return answer;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(approvalSettled).toBe(false);
		input.write("y\n");
		await expect(approval).resolves.toBe("y");
		await expect(lines.prompt("> ")).resolves.toBe("queued during generation");
		lines.close();
	});

	it("drains buffered piped lines before reporting EOF", async () => {
		const { input, lines } = createHarness();
		input.end("first\nsecond\n");

		await expect(lines.prompt("> ")).resolves.toBe("first");
		await expect(lines.prompt("> ")).resolves.toBe("second");
		await expect(lines.prompt("> ")).resolves.toBeUndefined();
	});

	it("clears the queued input when requested", async () => {
		const { input, lines } = createHarness();
		input.write("first\nsecond\n");
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(lines.clearQueue()).toBe(2);
		expect(lines.queuedCount()).toBe(0);
		lines.close();
	});
});
