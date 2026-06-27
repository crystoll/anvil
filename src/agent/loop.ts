import type { Engine, EngineEvent } from "../engine/engine.js";
import type { Registry, Tool } from "../tools/registry.js";
import { parseToolArgs } from "../tools/registry.js";

/** Agent loop states. */
export type AgentState = "idle" | "streaming" | "pending" | "executing" | "done" | "stuck";

/** A pending tool call awaiting user approval. */
export type PendingCall = {
	tool: Tool;
	args: Record<string, unknown>;
	callId: string;
	raw: string;
};

/** Events emitted by the agent loop. */
export type AgentEvent =
	| { kind: "state"; state: AgentState }
	| { kind: "content"; text: string }
	| { kind: "reasoning"; text: string }
	| { kind: "pending"; call: PendingCall }
	| { kind: "tool_result"; name: string; result: string }
	| { kind: "usage"; promptTokens: number; totalTokens: number; finishReason?: string }
	| { kind: "done"; message: string }
	| { kind: "stuck"; message: string }
	| { kind: "error"; message: string }
	| { kind: "round"; current: number; max: number }
	| { kind: "trimmed"; count: number };

export type AgentConfig = {
	maxRounds: number;
	projectRoot: string;
	systemPrompt: string;
	onBeforeToolUse?: (
		toolName: string,
		args: Record<string, unknown>,
	) => Promise<string | undefined>;
	onAfterToolUse?: (toolName: string, args: Record<string, unknown>, result: string) => void;
	transformToolResult?: (
		toolName: string,
		args: Record<string, unknown>,
		result: string,
	) => Promise<string>;
	streamOpts?: { contextSize?: number };
};

/** Creates an agent loop that orchestrates engine + tools with approval gating. */
export const createAgentLoop = (engine: Engine, registry: Registry, config: AgentConfig) => {
	let state: AgentState = "idle";
	let pendingCall: PendingCall | null = null;
	let rounds = 0;

	const setState = (s: AgentState): AgentEvent => {
		state = s;
		return { kind: "state", state: s };
	};

	/** Start a new agent turn with a user message. */
	async function* send(userMessage: string): AsyncGenerator<AgentEvent> {
		engine.setSystem(config.systemPrompt);
		engine.addUser(userMessage);
		rounds = 0;
		yield* runLoop();
	}

	/** Approve the pending tool call and continue. */
	async function* approve(): AsyncGenerator<AgentEvent> {
		if (state !== "pending" || !pendingCall) {
			yield { kind: "error", message: "Nothing pending to approve" };
			return;
		}

		yield setState("executing");
		const { tool, args, callId } = pendingCall;
		pendingCall = null;

		const denial = await config.onBeforeToolUse?.(tool.name, args);
		if (denial) {
			engine.addToolResult(callId, denial);
			yield* runLoop();
			return;
		}

		const result = await executeTool(tool, args, config.projectRoot);
		const finalResult = config.transformToolResult
			? await config.transformToolResult(tool.name, args, result)
			: result;
		config.onAfterToolUse?.(tool.name, args, finalResult);
		yield { kind: "tool_result", name: tool.name, result: finalResult };

		engine.addToolResult(callId, finalResult);
		yield* runLoop();
	}

	/** Reject the pending tool call with an optional reason. */
	async function* reject(reason = "User rejected this tool call"): AsyncGenerator<AgentEvent> {
		if (state !== "pending" || !pendingCall) {
			yield { kind: "error", message: "Nothing pending to reject" };
			return;
		}

		const { callId } = pendingCall;
		pendingCall = null;
		engine.addToolResult(callId, `REJECTED: ${reason}`);
		yield* runLoop();
	}

	/** Outcome of processing a tool call from the model. */
	type ToolCallOutcome =
		| { action: "done"; events: AgentEvent[] }
		| { action: "stuck"; events: AgentEvent[] }
		| { action: "pending"; events: AgentEvent[] }
		| { action: "executed"; events: AgentEvent[] }
		| { action: "error_fed_back" };

	/** Process a single tool call from the assistant message. */
	const handleToolCall = async (call: {
		id: string;
		name: string;
		arguments: string;
	}): Promise<ToolCallOutcome> => {
		if (call.name === "done") {
			return {
				action: "done",
				events: [setState("done"), { kind: "done", message: extractMessage(call.arguments) }],
			};
		}
		if (call.name === "stuck") {
			return {
				action: "stuck",
				events: [setState("stuck"), { kind: "stuck", message: extractMessage(call.arguments) }],
			};
		}

		const tool = registry.get(call.name);
		if (!tool) {
			engine.addToolResult(call.id, `Error: unknown tool "${call.name}"`);
			return { action: "error_fed_back" };
		}

		const argsResult = parseToolArgs(call.arguments);
		if (argsResult.isErr()) {
			engine.addToolResult(call.id, `Error: ${argsResult.error.message}`);
			return { action: "error_fed_back" };
		}

		if (tool.needsApproval) {
			pendingCall = { tool, args: argsResult.value, callId: call.id, raw: call.arguments };
			return {
				action: "pending",
				events: [setState("pending"), { kind: "pending", call: pendingCall }],
			};
		}

		const denial = await config.onBeforeToolUse?.(tool.name, argsResult.value);
		if (denial) {
			engine.addToolResult(call.id, denial);
			return { action: "error_fed_back" };
		}

		const result = await executeTool(tool, argsResult.value, config.projectRoot);
		const finalResult = config.transformToolResult
			? await config.transformToolResult(tool.name, argsResult.value, result)
			: result;
		config.onAfterToolUse?.(tool.name, argsResult.value, finalResult);
		engine.addToolResult(call.id, finalResult);
		return {
			action: "executed",
			events: [setState("executing"), { kind: "tool_result", name: tool.name, result }],
		};
	};

	/** Stream one round and collect engine events into agent events. */
	async function* streamRound(): AsyncGenerator<AgentEvent> {
		const trimEvent = maybeTrimContext(engine, config);
		if (trimEvent) yield trimEvent;
		const contextSize = config.streamOpts?.contextSize ?? 0;
		const schemas = contextSize ? registry.filteredSchemas(contextSize) : registry.schemas();
		let lastFinishReason: string | undefined;
		for await (const event of engine.stream(schemas, config.streamOpts)) {
			if (event.kind === "chunk" && event.chunk.finishReason)
				lastFinishReason = event.chunk.finishReason;
			const mapped = mapStreamEvent(event, lastFinishReason);
			if (mapped) yield mapped;
		}
	}

	/** Core agent loop — stream, detect tool calls, yield control for approval. */
	async function* runLoop(): AsyncGenerator<AgentEvent> {
		while (rounds < config.maxRounds) {
			rounds++;
			yield { kind: "round", current: rounds, max: config.maxRounds };
			yield setState("streaming");
			yield* streamRound();

			const lastMessage = engine.messages()[engine.messages().length - 1];
			const call = lastMessage?.toolCalls?.[0];
			if (!call) {
				yield setState("idle");
				return;
			}

			const outcome = await handleToolCall(call);
			if (outcome.action === "error_fed_back") continue;

			for (const e of outcome.events) yield e;
			if (outcome.action !== "executed") return;
		}

		yield { kind: "error", message: `Round cap reached (${config.maxRounds})` };
		yield setState("idle");
	}

	return {
		send,
		approve,
		reject,
		state: () => state,
		rounds: () => rounds,
		pending: () => pendingCall,
	};
};

const mapStreamEvent = (event: EngineEvent, lastFinishReason?: string): AgentEvent | undefined => {
	if (event.kind === "chunk" && event.chunk.usage) {
		const ev: AgentEvent & { kind: "usage" } = {
			kind: "usage",
			promptTokens: event.chunk.usage.promptTokens,
			totalTokens: event.chunk.usage.totalTokens,
		};
		if (lastFinishReason) ev.finishReason = lastFinishReason;
		return ev;
	}
	return processEngineEvent(event);
};

const maybeTrimContext = (
	engine: Engine,
	config: AgentConfig,
): (AgentEvent & { kind: "trimmed" }) | undefined => {
	const contextSize = config.streamOpts?.contextSize ?? 0;
	if (contextSize <= 0) return undefined;
	const budget = Math.round(contextSize * 0.8);
	const trimmed = engine.trimToFit(budget);
	return trimmed > 0 ? { kind: "trimmed", count: trimmed } : undefined;
};

const processEngineEvent = (event: EngineEvent): AgentEvent | undefined => {
	switch (event.kind) {
		case "chunk":
			if (event.chunk.content) return { kind: "content", text: event.chunk.content };
			if (event.chunk.reasoning) return { kind: "reasoning", text: event.chunk.reasoning };
			return undefined;
		case "error":
			return { kind: "error", message: event.error.message };
		case "cancelled":
			return { kind: "error", message: "Streaming cancelled" };
		default:
			return undefined;
	}
};

const executeTool = async (
	tool: Tool,
	args: Record<string, unknown>,
	projectRoot: string,
): Promise<string> => {
	try {
		return await Promise.race([
			tool.execute(args, projectRoot),
			timeout(tool.timeout, `Tool "${tool.name}" timed out after ${tool.timeout}ms`),
		]);
	} catch (e) {
		return `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
};

const timeout = (ms: number, message: string): Promise<never> =>
	new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

const extractMessage = (argsJson: string): string => {
	try {
		const parsed = JSON.parse(argsJson || "{}");
		return String(parsed.message ?? "");
	} catch {
		return argsJson;
	}
};
