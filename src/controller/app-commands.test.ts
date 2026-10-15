import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errAsync, okAsync } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine/engine.js";
import type { Provider } from "../provider/types.js";
import { createSessionWriter } from "../session/writer.js";
import { createRegistry } from "../tools/registry.js";
import {
	type AppCommandContext,
	type ContextUsage,
	createAppCommandRegistry,
	registerUiCommands,
} from "./app-commands.js";

const directories: string[] = [];

const createHarness = () => {
	const historyDir = mkdtempSync(join(tmpdir(), "anvil-app-commands-test-"));
	directories.push(historyDir);
	const provider: Provider = {
		name: "test",
		streamChat: () => errAsync({ kind: "unknown", message: "unused" }),
		completeChat: () => errAsync({ kind: "unknown", message: "unused" }),
		supportsTools: () => true,
		listModels: () => okAsync([]),
	};
	const engine = createEngine(provider, "test-model");
	engine.setSystem("system prompt");
	const session = createSessionWriter(historyDir, engine.messages);
	const activeSkill = { current: undefined as AppCommandContext["activeSkill"] };
	const activeAgent = { current: undefined as AppCommandContext["activeAgent"] };
	const context: AppCommandContext = {
		config: {
			providers: { test: { endpoint: "http://127.0.0.1:1" } },
			contextSize: 4096,
			firstTokenTimeout: 300,
			connectTimeout: 1,
			streamTimeout: 1,
			keepAlive: "30m",
		},
		engine,
		registry: createRegistry(),
		activeProviderName: "test",
		healthyProviders: new Map(),
		availableSkills: [{ name: "review", description: "Review code", body: "review prompt" }],
		activeSkill: activeSkill.current,
		availableAgents: [{ name: "reviewer", tools: [], prompt: "agent prompt" }],
		activeAgent: activeAgent.current,
		historyDir,
		session,
		setActiveSkill: (skill) => {
			activeSkill.current = skill;
		},
		setActiveAgent: (agent) => {
			activeAgent.current = agent;
		},
	};
	return { context, engine, session };
};

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("app command registry", () => {
	it("registers the shared interactive command set", () => {
		const { context } = createHarness();
		const commands = createAppCommandRegistry(context);

		expect(commands.list().map(({ name }) => name)).toEqual([
			"help",
			"quit",
			"model",
			"agent",
			"skill",
			"plan",
			"compact",
			"rewind",
			"history",
			"resume",
			"retry",
			"continue",
			"new",
		]);
	});

	it("registers shared utility commands with consistent session metrics", async () => {
		const { context } = createHarness();
		const commands = createAppCommandRegistry(context);
		const formatContext = vi.fn((usage: ContextUsage) => `Context ${usage.percentage}%`);
		registerUiCommands(commands, context, {
			getTokenUsage: () => ({ promptTokens: 12, totalTokens: 20 }),
			getLastPromptTokens: () => 3_000,
			formatContext,
		});

		expect(
			commands
				.list()
				.slice(-3)
				.map(({ name }) => name),
		).toEqual(["usage", "context", "transcript"]);
		await expect(commands.dispatch("/usage")).resolves.toMatchObject({
			kind: "handled",
			message: "Session: 20 tokens (12 prompt, 8 completion) · 1 msgs",
		});
		await expect(commands.dispatch("/context")).resolves.toMatchObject({
			kind: "handled",
			message: "Context 73%",
		});
		expect(formatContext).toHaveBeenCalledWith({
			used: 3_000,
			limit: 4_096,
			percentage: 73,
			toolCount: 0,
			toolTokens: 1,
			trimAt: 3_277,
		});
	});

	it("switches the model for subsequent turns after provider health succeeds", async () => {
		const { context, engine } = createHarness();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
		const commands = createAppCommandRegistry(context);

		await expect(commands.dispatch("/model smaller-model")).resolves.toMatchObject({
			kind: "handled",
			message: "Switched to: test/smaller-model",
		});
		expect(engine.model()).toBe("smaller-model");
	});

	it("retries the last request without retaining its failed partial answer", async () => {
		const { context, engine } = createHarness();
		engine.loadMessages([
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "first request" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "retry me" },
			{ role: "assistant", content: "partial answer", status: "interrupted" },
		]);
		const commands = createAppCommandRegistry(context);

		await expect(commands.dispatch("/retry")).resolves.toEqual({
			kind: "submit",
			input: "retry me",
		});
		expect(engine.messages().map(({ role, content }) => [role, content])).toEqual([
			["system", "system prompt"],
			["user", "first request"],
			["assistant", "first answer"],
		]);
	});

	it("rewinds by user turn and changes active skill and agent", async () => {
		const { context, engine } = createHarness();
		engine.loadMessages([
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "first" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: "second" },
			{ role: "assistant", content: "answer two" },
		]);
		const commands = createAppCommandRegistry(context);
		const setActiveSkill = vi.spyOn(context, "setActiveSkill");
		const setActiveAgent = vi.spyOn(context, "setActiveAgent");

		await commands.dispatch("/rewind 1");
		await commands.dispatch("/skill review");
		await commands.dispatch("/agent reviewer");

		expect(engine.messages().map(({ role, content }) => [role, content])).toEqual([
			["system", "system prompt"],
			["user", "first"],
			["assistant", "answer"],
		]);
		expect(setActiveSkill).toHaveBeenCalledWith(context.availableSkills[0]);
		expect(setActiveAgent).toHaveBeenCalledWith(context.availableAgents[0]);
		expect(context.activeSkill?.name).toBe("review");
		expect(context.activeAgent?.name).toBe("reviewer");
	});
});
