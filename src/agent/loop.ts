import { okAsync, ResultAsync } from "neverthrow";
import type { Engine, EngineEvent } from "../engine/engine.js";
import type { Message, Provider, ToolCall } from "../provider/types.js";
import type { Registry, Tool } from "../tools/registry.js";
import { parseToolArgs } from "../tools/registry.js";
import { compactHistory } from "./compact.js";
import { isOverflow } from "./overflow.js";

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
	| { kind: "pending"; call: PendingCall; index: number; total: number }
	| { kind: "tool_result"; name: string; result: string }
	| { kind: "usage"; promptTokens: number; totalTokens: number; finishReason?: string }
	| { kind: "done"; message: string }
	| { kind: "stuck"; message: string }
	| { kind: "error"; message: string; status?: "error" | "interrupted" }
	| { kind: "warning"; message: string }
	| { kind: "round"; current: number; max: number }
	| { kind: "trimmed"; count: number }
	| { kind: "overflow" }
	| { kind: "compacting" }
	| { kind: "compacted"; before: number; after: number };

export type AgentConfig = {
	maxRounds: number;
	projectRoot: string;
	systemPrompt: string;
	debug?: boolean;
	provider?: Provider;
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

type ActiveRun = {
	controller: AbortController;
	completed: Promise<void>;
	finish: () => void;
	started: boolean;
};

const CANCEL_WAIT_MS = 5000;
const CANCELLED_TOOL_RESULT = "[cancelled by user]";
const SKIPPED_TOOL_RESULT = "Skipped: agent ended before this call could run.";

/** Creates an agent loop that orchestrates engine + tools with approval gating. */
export const createAgentLoop = (engine: Engine, registry: Registry, config: AgentConfig) => {
	type QueuedToolCall = { call: ToolCall; index: number; total: number };
	type ToolCallOutcome =
		| { action: "done"; events: AgentEvent[] }
		| { action: "stuck"; events: AgentEvent[] }
		| { action: "pending"; events: AgentEvent[] }
		| { action: "executed"; events: AgentEvent[] }
		| { action: "cancelled"; events: AgentEvent[] }
		| { action: "error_fed_back" };
	type ProcessedToolCalls = Exclude<ToolCallOutcome, { action: "error_fed_back" }>;
	type ToolCallStep = ProcessedToolCalls | { action: "continue"; events: AgentEvent[] };

	let state: AgentState = "idle";
	let pendingCall: PendingCall | null = null;
	let queuedCalls: QueuedToolCall[] = [];
	let rounds = 0;
	let activeRun: ActiveRun | null = null;
	const recentCalls: string[] = [];
	let originalGoal = "";

	const setState = (s: AgentState): AgentEvent => {
		state = s;
		return { kind: "state", state: s };
	};

	type ToolRun = { result: string; warnings: AgentEvent[] };

	const transformResult = (
		toolName: string,
		args: Record<string, unknown>,
		result: string,
	): ResultAsync<string, string> =>
		config.transformToolResult
			? ResultAsync.fromThrowable(config.transformToolResult, errorText)(toolName, args, result)
			: okAsync(result);

	const activeRunError = (): AsyncGenerator<AgentEvent> =>
		(async function* () {
			yield { kind: "error", message: "An agent turn is already active" };
		})();

	const releasePendingRun = (run: ActiveRun): void => {
		if (activeRun === run) activeRun = null;
		run.finish();
	};

	const finishRun = (run: ActiveRun): void => {
		if (activeRun === run) {
			activeRun = null;
			if (run.controller.signal.aborted || state === "streaming" || state === "executing") {
				setState("idle");
			}
		}
		run.finish();
	};

	const runEvents = async function* (
		currentRun: ActiveRun,
		run: (signal: AbortSignal) => AsyncGenerator<AgentEvent>,
	): AsyncGenerator<AgentEvent> {
		currentRun.started = true;
		try {
			for await (const event of run(currentRun.controller.signal)) {
				if (event.kind === "pending") releasePendingRun(currentRun);
				yield event;
			}
		} finally {
			finishRun(currentRun);
		}
	};

	const startRun = (
		run: (signal: AbortSignal) => AsyncGenerator<AgentEvent>,
		resumesPending = false,
	): AsyncGenerator<AgentEvent> => {
		if (activeRun || (state === "pending" && !resumesPending)) return activeRunError();
		const controller = new AbortController();
		let finish: () => void = () => undefined;
		const completed = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const currentRun: ActiveRun = { controller, completed, finish, started: false };
		activeRun = currentRun;
		return runEvents(currentRun, run);
	};

	/** Post-processing only enriches a result, so its failure keeps the tool's own output. */
	const runTool = async (tool: Tool, args: Record<string, unknown>): Promise<ToolRun> => {
		const result = await executeTool(tool, args, config.projectRoot);
		const run = await transformResult(tool.name, args, result).match<ToolRun>(
			(transformed) => ({ result: transformed, warnings: [] }),
			(message) => ({
				result,
				warnings: [{ kind: "warning", message: `Post-processing ${tool.name} failed: ${message}` }],
			}),
		);
		config.onAfterToolUse?.(tool.name, args, run.result);
		return run;
	};

	/** Start a new agent turn with a user message. */
	const send = (userMessage: string): AsyncGenerator<AgentEvent> =>
		startRun(async function* (signal) {
			engine.setSystem(config.systemPrompt);
			engine.addUser(userMessage);
			originalGoal = userMessage;
			rounds = 0;
			recentCalls.length = 0;
			yield* runLoop(signal);
		});

	/** Approve the pending tool call and continue. */
	const approve = (): AsyncGenerator<AgentEvent> =>
		startRun(async function* (signal) {
			if (state !== "pending" || !pendingCall) {
				yield { kind: "error", message: "Nothing pending to approve" };
				return;
			}

			yield setState("executing");
			const { tool, args, callId } = pendingCall;
			pendingCall = null;
			const remainingCalls = queuedCalls;
			queuedCalls = [];

			const denial = await config.onBeforeToolUse?.(tool.name, args);
			if (signal.aborted) {
				engine.addToolResult(callId, CANCELLED_TOOL_RESULT);
				completeToolCalls(remainingCalls, CANCELLED_TOOL_RESULT);
				yield setState("idle");
				return;
			}
			if (denial) {
				engine.addToolResult(callId, denial);
			} else {
				const runResult = await runTool(tool, args);
				engine.addToolResult(callId, runResult.result);
				yield* runResult.warnings;
				yield { kind: "tool_result", name: tool.name, result: runResult.result };
			}

			const outcome = await processCalls(remainingCalls, signal);
			yield* outcome.events;
			if (outcome.action === "executed") yield* runLoop(signal);
			if (outcome.action === "cancelled") yield setState("idle");
		}, true);

	/** Reject the pending tool call with an optional reason. */
	const reject = (reason = "User rejected this tool call"): AsyncGenerator<AgentEvent> =>
		startRun(async function* (signal) {
			if (state !== "pending" || !pendingCall) {
				yield { kind: "error", message: "Nothing pending to reject" };
				return;
			}

			const { callId } = pendingCall;
			pendingCall = null;
			const remainingCalls = queuedCalls;
			queuedCalls = [];
			engine.addToolResult(callId, `REJECTED: ${reason}`);
			const outcome = await processCalls(remainingCalls, signal);
			yield* outcome.events;
			if (outcome.action === "executed") yield* runLoop(signal);
			if (outcome.action === "cancelled") yield setState("idle");
		}, true);

	const completeToolCalls = (calls: QueuedToolCall[], result: string): void => {
		for (const { call } of calls) engine.addToolResult(call.id, result);
	};

	const cancelFinalizedToolCalls = (): void => {
		const message = engine.messages().at(-1);
		if (message?.role !== "assistant") return;
		const toolCalls = message.toolCalls ?? [];
		if (!toolCalls.length) return;
		completeToolCalls(
			toolCalls.map((call, index) => ({
				call,
				index: index + 1,
				total: toolCalls.length,
			})),
			CANCELLED_TOOL_RESULT,
		);
	};

	/** Handle signal tools (done/stuck). */
	const handleSignal = (
		name: string,
		args: string,
		callId: string,
	): ToolCallOutcome | undefined => {
		if (name === "done") {
			engine.addToolResult(callId, `DONE: ${extractMessage(args)}`);
			return {
				action: "done",
				events: [setState("done"), { kind: "done", message: extractMessage(args) }],
			};
		}
		if (name === "stuck") {
			engine.addToolResult(callId, `STUCK: ${extractMessage(args)}`);
			return {
				action: "stuck",
				events: [setState("stuck"), { kind: "stuck", message: extractMessage(args) }],
			};
		}
		return undefined;
	};

	/** Execute a non-approval tool and return outcome. */
	const autoExecute = async (
		tool: Tool,
		args: Record<string, unknown>,
		callId: string,
		signal: AbortSignal,
	): Promise<ToolCallOutcome> => {
		const denial = await config.onBeforeToolUse?.(tool.name, args);
		if (signal.aborted) {
			engine.addToolResult(callId, CANCELLED_TOOL_RESULT);
			return { action: "cancelled", events: [] };
		}
		if (denial) {
			engine.addToolResult(callId, denial);
			return { action: "error_fed_back" };
		}
		const run = await runTool(tool, args);
		engine.addToolResult(callId, run.result);
		return {
			action: "executed",
			events: [
				setState("executing"),
				...run.warnings,
				{ kind: "tool_result", name: tool.name, result: run.result },
			],
		};
	};

	/** Process a single tool call from the assistant message. */
	const handleToolCall = async (
		call: ToolCall,
		index: number,
		total: number,
		signal: AbortSignal,
	): Promise<ToolCallOutcome> => {
		const signalOutcome = handleSignal(call.name, call.arguments, call.id);
		if (signalOutcome) return signalOutcome;

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
				events: [setState("pending"), { kind: "pending", call: pendingCall, index, total }],
			};
		}

		if (isStalled(tool.name, argsResult.value)) {
			engine.addToolResult(
				call.id,
				"This tool call returned the same result multiple times. Try a different approach or tool.",
			);
			return { action: "error_fed_back" };
		}

		return autoExecute(tool, argsResult.value, call.id, signal);
	};

	const processQueuedCall = async (
		queuedCall: QueuedToolCall,
		remainingCalls: QueuedToolCall[],
		signal: AbortSignal,
	): Promise<ToolCallStep> => {
		if (signal.aborted) {
			completeToolCalls([queuedCall, ...remainingCalls], CANCELLED_TOOL_RESULT);
			queuedCalls = [];
			return { action: "cancelled", events: [] };
		}

		const outcome = await handleToolCall(
			queuedCall.call,
			queuedCall.index,
			queuedCall.total,
			signal,
		);
		if (outcome.action === "error_fed_back") return { action: "continue", events: [] };
		if (outcome.action === "cancelled") {
			completeToolCalls(remainingCalls, CANCELLED_TOOL_RESULT);
			queuedCalls = [];
			return outcome;
		}
		if (outcome.action === "pending") {
			queuedCalls = remainingCalls;
			return outcome;
		}
		if (outcome.action === "done" || outcome.action === "stuck") {
			completeToolCalls(remainingCalls, SKIPPED_TOOL_RESULT);
			queuedCalls = [];
		}
		return outcome;
	};

	const processCalls = async (
		calls: QueuedToolCall[],
		signal: AbortSignal,
	): Promise<ProcessedToolCalls> => {
		const allEvents: AgentEvent[] = [];
		for (const [position, queuedCall] of calls.entries()) {
			const outcome = await processQueuedCall(queuedCall, calls.slice(position + 1), signal);
			allEvents.push(...outcome.events);
			if (outcome.action === "continue" || outcome.action === "executed") continue;
			return { ...outcome, events: allEvents };
		}
		queuedCalls = [];
		return { action: "executed", events: allEvents };
	};

	type RoundSignals = {
		finishReason?: string;
		promptTokens?: number;
		content: string;
		errorMessage?: string;
	};

	const checkRoundOverflow = (signals: RoundSignals): AgentEvent | undefined => {
		const contextSize = config.streamOpts?.contextSize ?? 0;
		if (contextSize <= 0) return undefined;
		return isOverflow({ ...signals, contextSize }) ? { kind: "overflow" } : undefined;
	};

	const accumulateSignal = (signals: RoundSignals, event: EngineEvent): void => {
		if (event.kind === "chunk") {
			if (event.chunk.finishReason) signals.finishReason = event.chunk.finishReason;
			if (event.chunk.content) signals.content += event.chunk.content;
			if (event.chunk.usage) signals.promptTokens = event.chunk.usage.promptTokens;
		}
		if (event.kind === "error") signals.errorMessage = event.error.message;
	};

	/** Stream one round and collect engine events into agent events. */
	async function* streamRound(
		signal: AbortSignal,
		requestMessages: readonly Message[],
	): AsyncGenerator<AgentEvent> {
		const trimEvent = maybeTrimContext(engine, config);
		if (trimEvent) yield trimEvent;
		const contextSize = config.streamOpts?.contextSize ?? 0;
		const schemas = contextSize ? registry.filteredSchemas(contextSize) : registry.schemas();
		const signals: RoundSignals = { content: "" };
		for await (const event of engine.stream(
			schemas,
			{ ...config.streamOpts, signal },
			requestMessages,
		)) {
			accumulateSignal(signals, event);
			const mapped = mapStreamEvent(event, signals.finishReason);
			if (mapped) yield mapped;
		}
		const overflowEvent = checkRoundOverflow(signals);
		if (overflowEvent) yield overflowEvent;
	}

	/** Track and detect repeated identical tool calls. */
	const isStalled = (toolName: string, args: Record<string, unknown>): boolean => {
		const hash = `${toolName}:${JSON.stringify(args)}`;
		recentCalls.push(hash);
		if (recentCalls.length > 6) recentCalls.shift();
		// Check after push so the current call is included in the count
		return recentCalls.filter((h) => h === hash).length >= 3;
	};

	/** Inject budget/goal context before streaming. */
	const injectRoundContext = (): Message[] => {
		const messages: Message[] = [];
		const threshold = Math.ceil(config.maxRounds * 0.8);
		if (rounds === threshold) {
			const remaining = config.maxRounds - rounds;
			messages.push({
				role: "user",
				content: `[Note: ${remaining} rounds remaining. Wrap up or present what you have.]`,
			});
		}
		if (rounds > 5 && rounds % 5 === 0) {
			messages.push({ role: "user", content: `[Reminder — your current task: ${originalGoal}]` });
		}
		return messages;
	};

	/** If model gave up without tools, inject nudge. Returns true if nudged. */
	const tryNudge = (lastMessage: { role: string; content?: string } | undefined): boolean => {
		if (lastMessage?.role !== "assistant") return false;
		const content = lastMessage.content ?? "";
		// Nudge if content is empty (reasoning-only) or matches give-up patterns
		if (content.trim() !== "" && !isGiveUp(content)) return false;
		const toolNames = registry
			.all()
			.map((t) => t.name)
			.join(", ");
		engine.addUser(
			content.trim() === ""
				? "Your response was empty. Please provide an answer or use a tool to proceed."
				: `You have tools available: ${toolNames}. Use them to accomplish the task. Try again.`,
			{ synthetic: true },
		);
		return true;
	};

	/** Attempt to recover a tool call from content (LiteLLM streaming quirk). */
	const tryRecoverToolCall = (): boolean => {
		const msgs = engine.messages();
		const last = msgs[msgs.length - 1];
		if (last?.role !== "assistant" || last.toolCalls?.length || !last.content) return false;
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
	const processOutcome = async (
		signal: AbortSignal,
	): Promise<{ loop: boolean; events: AgentEvent[] }> => {
		const toolCalls = engine.messages()[engine.messages().length - 1]?.toolCalls;
		if (!toolCalls?.length) return { loop: false, events: [setState("idle")] };

		const calls = toolCalls.map((call, index) => ({
			call,
			index: index + 1,
			total: toolCalls.length,
		}));
		const outcome = await processCalls(calls, signal);
		if (outcome.action === "cancelled") {
			return { loop: false, events: [...outcome.events, setState("idle")] };
		}
		return { loop: outcome.action === "executed", events: outcome.events };
	};

	/** Process one round's outcome after streaming. Returns whether to continue looping. */
	async function* processRoundEnd(
		nudged: boolean,
		signal: AbortSignal,
	): AsyncGenerator<AgentEvent, "continue" | "nudge" | "stop"> {
		const idle = checkIdle(nudged);
		if (idle === "nudge") return "nudge";
		if (idle === "idle") {
			yield setState("idle");
			return "stop";
		}

		const result = await processOutcome(signal);
		for (const e of result.events) yield e;
		return result.loop ? "continue" : "stop";
	}

	/** Attempt compaction and retry the round. Returns false if compaction failed. */
	async function* tryCompact(): AsyncGenerator<AgentEvent, boolean> {
		if (!config.provider) return false;
		yield { kind: "compacting" };
		const messages = [...engine.messages()];
		const beforeTokens = Math.round(messages.map((m) => m.content).join("").length / 4);
		const contextSize = config.streamOpts?.contextSize;
		const result = await compactHistory(config.provider, engine.model(), messages, {
			debug: config.debug ?? false,
			...(contextSize === undefined ? {} : { contextSize }),
		});
		if (result.isErr()) return false;
		const compacted = result.value;
		engine.loadMessages(compacted);
		const afterTokens = Math.round(compacted.map((m) => m.content).join("").length / 4);
		yield { kind: "compacted", before: beforeTokens, after: afterTokens };
		return true;
	}

	/** Stream a round; on overflow attempt compaction once. Returns "retry" if compacted. */
	async function* streamWithCompaction(
		compacted: { done: boolean },
		signal: AbortSignal,
		requestMessages: readonly Message[],
	): AsyncGenerator<AgentEvent, "continue" | "ok"> {
		let overflowed = false;
		for await (const event of streamRound(signal, requestMessages)) {
			if (event.kind === "overflow") overflowed = true;
			yield event;
		}
		if (overflowed && !compacted.done && !signal.aborted) {
			compacted.done = true;
			const success = yield* tryCompact();
			if (success) return "continue";
		}
		return "ok";
	}

	/** Core agent loop. */
	async function* runLoop(signal: AbortSignal): AsyncGenerator<AgentEvent> {
		let nudged = false;
		const compacted = { done: false };

		while (rounds < config.maxRounds) {
			if (signal.aborted) {
				yield setState("idle");
				return;
			}
			rounds++;
			yield { kind: "round", current: rounds, max: config.maxRounds };
			const requestMessages = injectRoundContext();
			yield setState("streaming");

			const streamResult = yield* streamWithCompaction(compacted, signal, requestMessages);
			if (signal.aborted) {
				cancelFinalizedToolCalls();
				yield setState("idle");
				return;
			}
			if (streamResult === "continue") continue;

			const action: "continue" | "nudge" | "stop" = yield* processRoundEnd(nudged, signal);
			nudged = action === "nudge";
			if (action === "stop") return;
		}

		yield { kind: "error", message: `Round cap reached (${config.maxRounds})` };
		yield setState("idle");
	}

	const waitForRun = async (run: ActiveRun): Promise<void> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			run.completed,
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					if (activeRun === run) {
						console.warn("anvil: cancellation did not finish within 5 seconds");
						setState("idle");
					}
					resolve();
				}, CANCEL_WAIT_MS);
			}),
		]);
		if (timer) clearTimeout(timer);
	};

	/** Cancel the current agent loop (aborts streaming and stops looping). */
	const cancel = async (): Promise<void> => {
		if (state === "pending" && pendingCall) {
			engine.addToolResult(pendingCall.callId, CANCELLED_TOOL_RESULT);
			completeToolCalls(queuedCalls, CANCELLED_TOOL_RESULT);
			pendingCall = null;
			queuedCalls = [];
			setState("idle");
			return;
		}
		const run = activeRun;
		if (!run) return;
		run.controller.abort();
		if (!run.started) {
			if (activeRun === run) activeRun = null;
			run.finish();
			return;
		}
		await waitForRun(run);
	};

	return {
		send,
		approve,
		reject,
		cancel,
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
			return { kind: "error", message: event.error.message, status: "error" };
		case "cancelled":
			return { kind: "error", message: "Streaming cancelled", status: "interrupted" };
		default:
			return undefined;
	}
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const executeTool = async (
	tool: Tool,
	args: Record<string, unknown>,
	projectRoot: string,
): Promise<string> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			tool.execute(args, projectRoot).finally(() => clearTimeout(timer)),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Tool "${tool.name}" timed out after ${tool.timeout}ms`)),
					tool.timeout,
				);
			}),
		]);
	} catch (e) {
		return `Error: ${errorText(e)}`;
	} finally {
		clearTimeout(timer);
	}
};

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
