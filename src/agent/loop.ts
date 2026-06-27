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
	const recentCalls: string[] = [];
	let originalGoal = "";

	const setState = (s: AgentState): AgentEvent => {
		state = s;
		return { kind: "state", state: s };
	};

	/** Start a new agent turn with a user message. */
	async function* send(userMessage: string): AsyncGenerator<AgentEvent> {
		engine.setSystem(config.systemPrompt);
		engine.addUser(userMessage);
		originalGoal = userMessage;
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

	/** Handle signal tools (done/stuck). */
	const handleSignal = (name: string, args: string): ToolCallOutcome | undefined => {
		if (name === "done")
			return {
				action: "done",
				events: [setState("done"), { kind: "done", message: extractMessage(args) }],
			};
		if (name === "stuck")
			return {
				action: "stuck",
				events: [setState("stuck"), { kind: "stuck", message: extractMessage(args) }],
			};
		return undefined;
	};

	/** Execute a non-approval tool and return outcome. */
	const autoExecute = async (
		tool: Tool,
		args: Record<string, unknown>,
		callId: string,
	): Promise<ToolCallOutcome> => {
		const denial = await config.onBeforeToolUse?.(tool.name, args);
		if (denial) {
			engine.addToolResult(callId, denial);
			return { action: "error_fed_back" };
		}
		const result = await executeTool(tool, args, config.projectRoot);
		const finalResult = config.transformToolResult
			? await config.transformToolResult(tool.name, args, result)
			: result;
		config.onAfterToolUse?.(tool.name, args, finalResult);
		engine.addToolResult(callId, finalResult);
		return {
			action: "executed",
			events: [setState("executing"), { kind: "tool_result", name: tool.name, result }],
		};
	};

	/** Process a single tool call from the assistant message. */
	const handleToolCall = async (call: {
		id: string;
		name: string;
		arguments: string;
	}): Promise<ToolCallOutcome> => {
		const signal = handleSignal(call.name, call.arguments);
		if (signal) return signal;

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

		if (isStalled(tool.name, argsResult.value)) {
			engine.addToolResult(
				call.id,
				"This tool call returned the same result multiple times. Try a different approach or tool.",
			);
			return { action: "error_fed_back" };
		}

		return autoExecute(tool, argsResult.value, call.id);
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

	/** Track and detect repeated identical tool calls. */
	const isStalled = (toolName: string, args: Record<string, unknown>): boolean => {
		const hash = `${toolName}:${JSON.stringify(args)}`;
		recentCalls.push(hash);
		if (recentCalls.length > 6) recentCalls.shift();
		return recentCalls.filter((h) => h === hash).length >= 3;
	};

	/** Inject budget/goal context before streaming. */
	const injectRoundContext = () => {
		const threshold = Math.ceil(config.maxRounds * 0.8);
		if (rounds === threshold) {
			const remaining = config.maxRounds - rounds;
			engine.addUser(`[Note: ${remaining} rounds remaining. Wrap up or present what you have.]`);
		}
		if (rounds > 5 && rounds % 5 === 0) {
			engine.addUser(`[Reminder — your current task: ${originalGoal}]`);
		}
	};

	/** If model gave up without tools, inject nudge. Returns true if nudged. */
	const tryNudge = (lastMessage: { role: string; content?: string } | undefined): boolean => {
		if (lastMessage?.role !== "assistant") return false;
		if (!isGiveUp(lastMessage.content ?? "")) return false;
		const toolNames = registry
			.all()
			.map((t) => t.name)
			.join(", ");
		engine.addUser(
			`You have tools available: ${toolNames}. Use them to accomplish the task. Try again.`,
		);
		return true;
	};

	/** Check if round ended without tool call. */
	/** Attempt to recover a tool call from content (LiteLLM streaming quirk). */
	const tryRecoverToolCall = (): boolean => {
		const msgs = engine.messages();
		const last = msgs[msgs.length - 1];
		if (!last || last.toolCalls?.length || !last.content) return false;
		try {
			const parsed = JSON.parse(last.content.trim());
			if (typeof parsed.name !== "string") return false;
			const args = parsed.arguments ?? parsed.parameters ?? {};
			return engine.rewriteLastAsToolCall({
				id: `recovered-${Date.now()}`,
				name: parsed.name,
				arguments: JSON.stringify(args),
			});
		} catch {
			return false;
		}
	};

	const checkIdle = (nudged: boolean): "nudge" | "idle" | undefined => {
		const lastMessage = engine.messages()[engine.messages().length - 1];
		if (lastMessage?.toolCalls?.[0]) return undefined;
		if (tryRecoverToolCall()) return undefined;
		if (!nudged && tryNudge(lastMessage)) return "nudge";
		return "idle";
	};

	/** Process tool call outcome. Returns events + whether to continue looping. */
	const processOutcome = async (): Promise<{ loop: boolean; events: AgentEvent[] }> => {
		const call = engine.messages()[engine.messages().length - 1]?.toolCalls?.[0];
		if (!call) return { loop: false, events: [setState("idle")] };
		const outcome = await handleToolCall(call);
		if (outcome.action === "error_fed_back") return { loop: true, events: [] };
		return { loop: outcome.action === "executed", events: outcome.events };
	};

	/** Core agent loop. */
	async function* runLoop(): AsyncGenerator<AgentEvent> {
		let nudged = false;

		while (rounds < config.maxRounds) {
			rounds++;
			yield { kind: "round", current: rounds, max: config.maxRounds };
			injectRoundContext();
			yield setState("streaming");
			yield* streamRound();

			const idle = checkIdle(nudged);
			if (idle === "nudge") {
				nudged = true;
				continue;
			}
			if (idle === "idle") {
				yield setState("idle");
				return;
			}
			nudged = false;

			const result = await processOutcome();
			for (const e of result.events) yield e;
			if (result.loop) continue;
			return;
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

const GIVE_UP_PATTERNS = [
	"I cannot",
	"I'm unable",
	"I can't",
	"Unfortunately I",
	"I don't have access",
	"I'm not able",
	"As an AI",
];

const isGiveUp = (text: string): boolean => {
	const lower = text.toLowerCase();
	return GIVE_UP_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
};
