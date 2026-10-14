import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "./commands.js";

describe("command registry", () => {
	it("dispatches slash commands by name or alias and exposes help", async () => {
		const modelCommand = vi.fn((argument: string) => ({
			kind: "handled" as const,
			message: `model ${argument}`,
		}));
		const commands = createCommandRegistry([
			{
				name: "model",
				aliases: ["m"],
				description: "Switch models",
				execute: modelCommand,
			},
		]);

		await expect(commands.dispatch("/model ollama/qwen")).resolves.toEqual({
			kind: "handled",
			message: "model ollama/qwen",
		});
		await expect(commands.dispatch("/m local")).resolves.toEqual({
			kind: "handled",
			message: "model local",
		});
		await expect(commands.dispatch("/help")).resolves.toMatchObject({
			kind: "handled",
			message: expect.stringContaining("/model"),
		});
		expect(commands.list().map((command) => command.name)).toEqual(["help", "quit", "model"]);
	});

	it("leaves ordinary text and unknown slash commands undispatched", async () => {
		const commands = createCommandRegistry();
		await expect(commands.dispatch("hello")).resolves.toBeUndefined();
		await expect(commands.dispatch("/unknown command")).resolves.toBeUndefined();
	});

	it("rejects duplicate command names and aliases", () => {
		expect(() =>
			createCommandRegistry([
				{ name: "model", aliases: ["m"], description: "one", execute: () => ({ kind: "handled" }) },
				{ name: "m", description: "two", execute: () => ({ kind: "handled" }) },
			]),
		).toThrow('Command name or alias "m" is already registered');
	});
});
