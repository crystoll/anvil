import { Box, type Key, Static, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { AgentEvent } from "../agent/loop.js";
import type {
	ControllerEvent,
	PendingApproval,
	SessionController,
} from "../controller/controller.js";

type Message = { id: number; text: string; dim?: boolean };

const STREAM_FLUSH_INTERVAL_MS = 50;
const STREAM_TAIL_LINES = 10;

export type TuiAppProps = {
	controller: SessionController;
	providerName: () => string;
	activeSkillName: () => string | undefined;
	contextSize: number;
	initialNotices: string[];
	commandNames: string[];
	skillNames: string[];
	listModels: () => Promise<string[]>;
	onTurnComplete: () => Promise<void>;
	onPromptUsage: (tokens: number) => void;
	onExit: () => void;
};

const truncate = (text: string, max = 80): string => {
	const oneLine = text.replace(/\n/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
};

const tailLines = (text: string): string => text.split("\n").slice(-STREAM_TAIL_LINES).join("\n");

const summarizeArgs = (args: Record<string, unknown>): string => {
	const primary = [args.command, args.path, args.query, args.url].find(
		(value): value is string => typeof value === "string",
	);
	if (primary) return truncate(primary, 120);
	const first = Object.entries(args)[0];
	return first ? truncate(`${first[0]}=${JSON.stringify(first[1])}`, 120) : "";
};

const useControllerState = (controller: SessionController) => {
	const snapshot = useRef(controller.getState());
	const pendingState = useRef(snapshot.current);
	const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			const unsubscribe = controller.subscribe((event) => {
				if (event.type !== "state") return;

				pendingState.current = event.state;
				if (snapshot.current.phase === "streaming" && event.state.phase === "streaming") {
					if (flushTimer.current === undefined) {
						flushTimer.current = setTimeout(() => {
							snapshot.current = pendingState.current;
							flushTimer.current = undefined;
							onStoreChange();
						}, STREAM_FLUSH_INTERVAL_MS);
					}
					return;
				}

				if (flushTimer.current !== undefined) {
					clearTimeout(flushTimer.current);
					flushTimer.current = undefined;
				}
				snapshot.current = event.state;
				onStoreChange();
			});

			return () => {
				unsubscribe();
				if (flushTimer.current !== undefined) {
					clearTimeout(flushTimer.current);
					flushTimer.current = undefined;
				}
			};
		},
		[controller],
	);
	const getSnapshot = useCallback(() => snapshot.current, []);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

const contextColor = (percentage: number): string => {
	if (percentage >= 90) return "red";
	if (percentage >= 60) return "yellow";
	return "gray";
};

const contextLabel = (percentage: number): string => {
	if (percentage <= 0) return "";
	return `[${percentage}%${percentage >= 90 ? "⚡" : ""}]`;
};

function StatusBar({
	provider,
	model,
	tokens,
	lastPrompt,
	contextSize,
	activeSkill,
	busy,
	phase,
	elapsed,
	tokensPerSecond,
}: {
	provider: string;
	model: string;
	tokens: number;
	lastPrompt: number;
	contextSize: number;
	activeSkill: string | undefined;
	busy: boolean;
	phase: string;
	elapsed: number;
	tokensPerSecond: number | undefined;
}) {
	const pct = lastPrompt > 0 ? Math.round((lastPrompt / contextSize) * 100) : 0;
	const label = contextLabel(pct);
	return (
		<Box borderStyle="single" borderColor="gray" paddingX={1}>
			<Text color="cyan">
				{provider}/{model}
			</Text>
			<Text> │ </Text>
			<Text color={contextColor(pct)}>{label}</Text>
			{label && <Text> │ </Text>}
			<Text dimColor>
				{busy ? "~" : ""}
				{tokens} tok
			</Text>
			{busy && <Text> │ </Text>}
			{busy && (
				<Text color="yellow">
					{phase} {elapsed}s
				</Text>
			)}
			{tokensPerSecond !== undefined && <Text> │ {tokensPerSecond.toFixed(1)} tok/s</Text>}
			{busy && <Text> │ </Text>}
			{busy && (
				<Text color="yellow">
					<Spinner type="dots" />
				</Text>
			)}
			{activeSkill && <Text> │ </Text>}
			{activeSkill && <Text color="magenta">{activeSkill}</Text>}
		</Box>
	);
}

function ApprovalPrompt({ pending }: { pending: PendingApproval }) {
	const { call } = pending;
	const { tool, args } = call;
	const path = typeof args.path === "string" ? args.path : "";

	return (
		<Box flexDirection="column">
			<Text color="yellow">
				⚡ [{pending.index}/{pending.total}] {tool.name}
				{path ? `(${path})` : `: ${summarizeArgs(args)}`}
			</Text>
			{tool.name === "edit_file" &&
				typeof args.search === "string" &&
				typeof args.replace === "string" && (
					<Box flexDirection="column" paddingLeft={2}>
						{args.replace_all === true && (
							<Text color="yellow">replace_all: true — replaces every match</Text>
						)}
						<Text color="red">
							{args.search
								.split("\n")
								.map((line) => `- ${line}`)
								.join("\n")}
						</Text>
						<Text color="green">
							{args.replace
								.split("\n")
								.map((line) => `+ ${line}`)
								.join("\n")}
						</Text>
					</Box>
				)}
			{tool.name === "write_file" && typeof args.content === "string" && (
				<Text color="green">{truncate(args.content, 300)}</Text>
			)}
			<Text dimColor>Allow? [y]es [n]o [a]lways · Esc cancels</Text>
		</Box>
	);
}

const showAgentInfo = (
	event: AgentEvent,
	addMessage: (text: string, dim?: boolean) => void,
): void => {
	if (event.kind === "trimmed") addMessage(`  [trimmed ${event.count} old messages]`, true);
	if (event.kind === "overflow")
		addMessage("⚠ context overflow detected — consider /compact or /new", true);
	if (event.kind === "compacting") addMessage("  [compacting context...]", true);
	if (event.kind === "compacted")
		addMessage(
			`  ⚡ compacted: ~${event.before.toLocaleString()} → ~${event.after.toLocaleString()} tokens`,
			true,
		);
	if (event.kind === "done" && event.message) addMessage(`✓ ${event.message}`);
	if (event.kind === "stuck" && event.message) addMessage(`✗ ${event.message}`, true);
	if (event.kind === "warning") addMessage(`  ⚠ ${event.message}`, true);
};

type AgentEventContext = {
	controller: SessionController;
	addMessage: (text: string, dim?: boolean) => void;
	setLastPrompt: Dispatch<SetStateAction<number>>;
	setIsThinking: Dispatch<SetStateAction<boolean>>;
	setElapsed: Dispatch<SetStateAction<number>>;
	setHasReceivedFirstToken: Dispatch<SetStateAction<boolean>>;
	setReasoningText: Dispatch<SetStateAction<string>>;
	setTokensPerSecond: Dispatch<SetStateAction<number | undefined>>;
	onPromptUsage: (tokens: number) => void;
	thinkingStartedAt: MutableRefObject<number | undefined>;
	pendingReasoningText: MutableRefObject<string>;
	reasoningFlushTimer: MutableRefObject<ReturnType<typeof setTimeout> | undefined>;
	partialDisplayed: MutableRefObject<boolean>;
	finishReason: MutableRefObject<string | undefined>;
};

const flushReasoningText = (
	context: Pick<
		AgentEventContext,
		"reasoningFlushTimer" | "pendingReasoningText" | "setReasoningText"
	>,
): void => {
	if (context.reasoningFlushTimer.current !== undefined) {
		clearTimeout(context.reasoningFlushTimer.current);
		context.reasoningFlushTimer.current = undefined;
	}
	context.setReasoningText(context.pendingReasoningText.current);
};

const handleAgentEvent = (event: AgentEvent, context: AgentEventContext): void => {
	if (event.kind === "content") {
		context.setHasReceivedFirstToken(true);
		flushReasoningText(context);
		context.thinkingStartedAt.current = undefined;
		context.setIsThinking(false);
		context.partialDisplayed.current = false;
		return;
	}
	if (event.kind === "reasoning") {
		context.setHasReceivedFirstToken(true);
		context.pendingReasoningText.current += event.text;
		if (context.reasoningFlushTimer.current === undefined) {
			context.reasoningFlushTimer.current = setTimeout(() => {
				flushReasoningText(context);
			}, STREAM_FLUSH_INTERVAL_MS);
		}
		context.thinkingStartedAt.current ??= Date.now();
		context.setIsThinking(true);
		context.setElapsed(Math.floor((Date.now() - context.thinkingStartedAt.current) / 1000));
		return;
	}
	if (event.kind === "usage") {
		context.finishReason.current = event.finishReason;
		context.setLastPrompt(event.promptTokens);
		context.setTokensPerSecond(event.tokensPerSecond);
		context.onPromptUsage(event.promptTokens);
		return;
	}
	if (event.kind === "tool_result") {
		context.addMessage(`  ↳ ${event.name}: ${truncate(event.result)}`, true);
		return;
	}
	if (event.kind === "error") {
		const partial = context.controller.getState().streamingText;
		if (partial) context.addMessage(`anvil: ${partial}`);
		context.partialDisplayed.current = true;
		if (event.status === "interrupted") context.addMessage("  [response interrupted]", true);
		else if (event.status) context.addMessage("  [response ended with an error]", true);
		context.addMessage(`  ⚠ ${event.message}`, true);
		context.setIsThinking(false);
		return;
	}
	showAgentInfo(event, context.addMessage);
};

type ControllerEventContext = AgentEventContext & {
	onExit: () => void;
};

const handleControllerEvent = (event: ControllerEvent, context: ControllerEventContext): void => {
	if (event.type === "notice") {
		context.addMessage(event.message, true);
		return;
	}
	if (event.type === "quit") {
		context.onExit();
		return;
	}
	if (event.type === "agent") handleAgentEvent(event.event, context);
};

type ApprovalDecision = "once" | "always" | "reject" | "cancel";

type PreparedSubmission = {
	trimmed: string;
	command: string;
	submission: string;
	isTurn: boolean;
};

const prepareSubmission = (
	value: string,
	commandNames: string[],
	skillNames: string[],
): PreparedSubmission | undefined => {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const command = trimmed.split(/\s+/, 1)[0]?.slice(1).toLowerCase() ?? "";
	const skillName = trimmed.startsWith("/") ? trimmed.slice(1).trim() : "";
	const skillShorthand = skillNames.includes(skillName);
	return {
		trimmed,
		command,
		submission: skillShorthand ? `/skill ${skillName}` : trimmed,
		isTurn:
			(!commandNames.includes(command) && !skillShorthand) ||
			["plan", "retry", "continue"].includes(command),
	};
};

const showSubmission = (
	value: string,
	submission: PreparedSubmission,
	addMessage: (text: string, dim?: boolean) => void,
): void => {
	if (!submission.isTurn) return;
	const references = submission.trimmed.match(/(^|[\s])@([\w./-]+)/g);
	if (references)
		addMessage(
			`  [attached: ${references.map((reference) => reference.trim().slice(1)).join(", ")}]`,
			true,
		);
	if (submission.command === "plan")
		addMessage(`[plan: ${submission.trimmed.slice(5).trim()}]`, true);
	else if (!submission.trimmed.startsWith("/")) addMessage(`you: ${value}`);
};

type ControllerActionContext = {
	setSubmitting: Dispatch<SetStateAction<boolean>>;
	addMessage: (text: string, dim?: boolean) => void;
	finishStreamSegment: () => void;
	finishTurn: () => Promise<void>;
};

const runControllerAction = async (
	action: () => Promise<void>,
	context: ControllerActionContext,
): Promise<void> => {
	context.setSubmitting(true);
	try {
		await action();
		context.finishStreamSegment();
		await context.finishTurn();
	} catch (error) {
		context.addMessage(`  ⚠ ${error instanceof Error ? error.message : String(error)}`, true);
		await context.finishTurn();
	} finally {
		context.setSubmitting(false);
	}
};

type KeyboardContext = {
	state: ReturnType<SessionController["getState"]>;
	picker: string[] | null;
	pickerIndex: number;
	history: MutableRefObject<string[]>;
	historyIndex: MutableRefObject<number>;
	setPicker: Dispatch<SetStateAction<string[] | null>>;
	setPickerIndex: Dispatch<SetStateAction<number>>;
	setInput: Dispatch<SetStateAction<string>>;
	onCtrlC: () => void;
	onApproval: (decision: ApprovalDecision) => void;
	onModelSelect: (model: string) => void;
};

const handlePickerInput = (key: Key, context: KeyboardContext): void => {
	if (key.escape) context.setPicker(null);
	else if (key.upArrow) context.setPickerIndex((index) => Math.max(0, index - 1));
	else if (key.downArrow)
		context.setPickerIndex((index) => Math.min((context.picker?.length ?? 1) - 1, index + 1));
	else if (key.return) {
		const model = context.picker?.[context.pickerIndex];
		if (model) context.onModelSelect(model);
	}
};

const handleApprovalInput = (value: string, key: Key, context: KeyboardContext): void => {
	if (key.escape) context.onApproval("cancel");
	else if (value.toLowerCase() === "y") context.onApproval("once");
	else if (value.toLowerCase() === "a") context.onApproval("always");
	else if (value.toLowerCase() === "n") context.onApproval("reject");
};

const handleHistoryInput = (key: Key, context: KeyboardContext): void => {
	if (key.upArrow && context.history.current.length > 0) {
		context.historyIndex.current = Math.min(
			context.historyIndex.current + 1,
			context.history.current.length - 1,
		);
		context.setInput(context.history.current[context.historyIndex.current] ?? "");
	}
	if (key.downArrow) {
		context.historyIndex.current = Math.max(context.historyIndex.current - 1, -1);
		context.setInput(
			context.historyIndex.current < 0
				? ""
				: (context.history.current[context.historyIndex.current] ?? ""),
		);
	}
};

const handleTuiInput = (value: string, key: Key, context: KeyboardContext): void => {
	if (key.ctrl && value === "c") {
		context.onCtrlC();
		return;
	}
	if (context.picker) {
		handlePickerInput(key, context);
		return;
	}
	if (context.state.pending && context.state.phase === "awaiting_approval") {
		handleApprovalInput(value, key, context);
		return;
	}
	if (key.escape && context.state.phase !== "idle") {
		context.onApproval("cancel");
		return;
	}
	handleHistoryInput(key, context);
};

const streamingText = (
	state: ReturnType<SessionController["getState"]>,
	hasReceivedFirstToken: boolean,
	isThinking: boolean,
	elapsed: number,
): string => {
	if (state.phase !== "streaming") return "";
	if (state.streamingText) return `anvil: ${tailLines(state.streamingText)}`;
	if (!hasReceivedFirstToken) return `anvil: waiting for model (loading?) ${elapsed}s`;
	return isThinking ? "" : "anvil: [generating…]";
};

const reasoningTextForDisplay = (
	isThinking: boolean,
	showThinking: boolean,
	text: string,
	elapsed: number,
): string => {
	if (!isThinking) return "";
	if (showThinking) return `anvil: ${text}`;
	return `anvil: thinking… ~${Math.ceil(text.length / 4)} tokens · ${elapsed}s`;
};

const phaseLabel = (
	state: ReturnType<SessionController["getState"]>,
	hasReceivedFirstToken: boolean,
	isThinking: boolean,
): string => {
	if (state.phase !== "streaming") return state.phase.replaceAll("_", " ");
	if (!hasReceivedFirstToken) return "waiting";
	return isThinking ? "thinking" : "generating";
};

type InputAreaProps = {
	state: ReturnType<SessionController["getState"]>;
	picker: string[] | null;
	pickerIndex: number;
	pickerLoading: boolean;
	activeModel: string;
	input: string;
	setInput: Dispatch<SetStateAction<string>>;
	onSubmit: (value: string) => void;
};

const handleInputChange = (
	value: string,
	setInput: Dispatch<SetStateAction<string>>,
	onSubmit: (value: string) => void,
): void => {
	const submittedValue = value.replace(/[\r\n]+$/, "");
	if (submittedValue !== value) {
		setInput("");
		onSubmit(submittedValue.trim());
		return;
	}
	setInput(value);
};

function InputArea({
	state,
	picker,
	pickerIndex,
	pickerLoading,
	activeModel,
	input,
	setInput,
	onSubmit,
}: InputAreaProps) {
	return (
		<Box paddingX={1}>
			{picker ? (
				<Box flexDirection="column">
					<Text dimColor>↑↓ select, Enter confirm, Esc cancel</Text>
					{picker.map((model, index) => (
						<Text key={model} {...(index === pickerIndex ? { color: "cyan" } : {})}>
							{index === pickerIndex ? "❯ " : "  "}
							{model}
							{model === activeModel ? " ●" : ""}
						</Text>
					))}
				</Box>
			) : state.pending && state.phase === "awaiting_approval" ? (
				<ApprovalPrompt pending={state.pending} />
			) : (
				<>
					<Text color="green">{"❯ "}</Text>
					{pickerLoading ? (
						<Text dimColor>Loading models…</Text>
					) : (
						<TextInput
							value={input}
							onChange={(value) => handleInputChange(value, setInput, onSubmit)}
							onSubmit={onSubmit}
						/>
					)}
				</>
			)}
		</Box>
	);
}

export function App({
	controller,
	providerName,
	activeSkillName,
	contextSize,
	initialNotices,
	commandNames,
	skillNames,
	listModels,
	onTurnComplete,
	onPromptUsage,
	onExit,
}: TuiAppProps) {
	const state = useControllerState(controller);
	const [messages, setMessages] = useState<Message[]>(() =>
		initialNotices.map((text, id) => ({ id, text: `⚠ ${text}`, dim: true })),
	);
	const [input, setInput] = useState("");
	const [lastPrompt, setLastPrompt] = useState(0);
	const [isThinking, setIsThinking] = useState(false);
	const [elapsed, setElapsed] = useState(0);
	const [requestElapsed, setRequestElapsed] = useState(0);
	const [hasReceivedFirstToken, setHasReceivedFirstToken] = useState(false);
	const [reasoningText, setReasoningText] = useState("");
	const [showThinking, setShowThinking] = useState(false);
	const [tokensPerSecond, setTokensPerSecond] = useState<number | undefined>(undefined);
	const [picker, setPicker] = useState<string[] | null>(null);
	const [pickerIndex, setPickerIndex] = useState(0);
	const [pickerLoading, setPickerLoading] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const nextMessageId = useRef(messages.length);
	const history = useRef<string[]>([]);
	const historyIndex = useRef(-1);
	const lastCtrlC = useRef(0);
	const thinkingStartedAt = useRef<number | undefined>(undefined);
	const requestStartedAt = useRef<number | undefined>(undefined);
	const pendingReasoningText = useRef("");
	const reasoningFlushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const activeTurn = useRef(false);
	const partialDisplayed = useRef(false);
	const finishReason = useRef<string | undefined>(undefined);

	const addMessage = useCallback((text: string, dim = false): void => {
		const id = nextMessageId.current++;
		setMessages((previous) => [...previous, { id, text, dim }]);
	}, []);

	const finishStreamSegment = useCallback((): void => {
		const current = controller.getState();
		if (current.streamingText && !partialDisplayed.current)
			addMessage(`anvil: ${current.streamingText}`);
		else if (!current.streamingText && finishReason.current)
			addMessage(`  [no content — finish_reason: ${finishReason.current}]`, true);
		partialDisplayed.current = false;
		finishReason.current = undefined;
		setIsThinking(false);
		thinkingStartedAt.current = undefined;
		requestStartedAt.current = undefined;
		flushReasoningText({ reasoningFlushTimer, pendingReasoningText, setReasoningText });
	}, [addMessage, controller]);

	const finishTurn = useCallback(async (): Promise<void> => {
		if (!activeTurn.current || controller.getState().phase !== "idle") return;
		activeTurn.current = false;
		try {
			await onTurnComplete();
		} catch (error) {
			addMessage(
				`  ⚠ stop hook failed: ${error instanceof Error ? error.message : String(error)}`,
				true,
			);
		}
	}, [addMessage, controller, onTurnComplete]);

	const beginStreamSegment = (): void => {
		partialDisplayed.current = false;
		finishReason.current = undefined;
		thinkingStartedAt.current = undefined;
		setIsThinking(false);
		setElapsed(0);
		if (reasoningFlushTimer.current !== undefined) clearTimeout(reasoningFlushTimer.current);
		reasoningFlushTimer.current = undefined;
		pendingReasoningText.current = "";
		setReasoningText("");
		setHasReceivedFirstToken(false);
		setTokensPerSecond(undefined);
		setRequestElapsed(0);
		requestStartedAt.current = Date.now();
	};

	useEffect(() => {
		const context: ControllerEventContext = {
			controller,
			addMessage,
			setLastPrompt,
			setIsThinking,
			setElapsed,
			setHasReceivedFirstToken,
			setReasoningText,
			setTokensPerSecond,
			onPromptUsage,
			thinkingStartedAt,
			pendingReasoningText,
			reasoningFlushTimer,
			partialDisplayed,
			finishReason,
			onExit,
		};
		return controller.subscribe((event) => handleControllerEvent(event, context));
	}, [addMessage, controller, onExit, onPromptUsage]);

	useEffect(() => {
		if (state.phase === "streaming" && requestStartedAt.current === undefined)
			requestStartedAt.current = Date.now();
		if (state.phase === "idle") requestStartedAt.current = undefined;
	}, [state.phase]);

	useEffect(() => {
		const interval = setInterval(() => {
			if (thinkingStartedAt.current !== undefined)
				setElapsed(Math.floor((Date.now() - thinkingStartedAt.current) / 1000));
			if (requestStartedAt.current !== undefined)
				setRequestElapsed(Math.floor((Date.now() - requestStartedAt.current) / 1000));
		}, 1000);
		return () => clearInterval(interval);
	}, []);

	useEffect(
		() => () => {
			if (reasoningFlushTimer.current !== undefined) clearTimeout(reasoningFlushTimer.current);
		},
		[],
	);

	const isBusy = submitting || state.phase !== "idle";

	const submit = async (value: string): Promise<void> => {
		const submission = prepareSubmission(value, commandNames, skillNames);
		if (!submission || isBusy) return;
		setInput("");
		history.current = [value, ...history.current.slice(0, 99)];
		historyIndex.current = -1;
		activeTurn.current = submission.isTurn;
		if (submission.command === "new") setMessages([]);
		showSubmission(value, submission, addMessage);
		beginStreamSegment();
		await runControllerAction(() => controller.submit(submission.submission), {
			setSubmitting,
			addMessage,
			finishStreamSegment,
			finishTurn,
		});
	};

	const approve = async (decision: ApprovalDecision): Promise<void> => {
		setInput("");
		lastCtrlC.current = 0;
		if (decision === "always" && state.pending)
			addMessage(`  [auto-approving ${state.pending.call.tool.name} for this session]`, true);
		beginStreamSegment();
		await runControllerAction(
			async () => {
				if (decision === "once") await controller.approve("once");
				else if (decision === "always") await controller.approve("always");
				else if (decision === "reject") await controller.reject("User declined");
				else await controller.cancel();
			},
			{ setSubmitting, addMessage, finishStreamSegment, finishTurn },
		);
	};

	const openModelPicker = async (): Promise<void> => {
		setPickerLoading(true);
		try {
			const models = await listModels();
			if (models.length === 0) addMessage("[no models available]", true);
			else {
				setPickerIndex(0);
				setPicker(models);
			}
		} catch (error) {
			addMessage(
				`[failed to list models: ${error instanceof Error ? error.message : String(error)}]`,
				true,
			);
		} finally {
			setPickerLoading(false);
		}
	};

	const selectModel = async (model: string): Promise<void> => {
		setPicker(null);
		await runControllerAction(() => controller.submit(`/model ${model}`), {
			setSubmitting,
			addMessage,
			finishStreamSegment,
			finishTurn,
		});
	};

	const handleSubmit = (value: string): void => {
		if (value.trim().toLowerCase() === "/think") {
			setInput("");
			setShowThinking((showing) => !showing);
			addMessage(`[reasoning: ${showThinking ? "collapsed" : "full"}]`, true);
			return;
		}
		if (value.trim() === "/model") {
			setInput("");
			void openModelPicker();
			return;
		}
		void submit(value);
	};

	const handleCtrlC = (): void => {
		if (picker) {
			setPicker(null);
			return;
		}
		if (state.phase !== "idle" || submitting) {
			lastCtrlC.current = Date.now();
			void approve("cancel");
			return;
		}
		const now = Date.now();
		if (now - lastCtrlC.current < 1500) {
			onExit();
			return;
		}
		lastCtrlC.current = now;
		addMessage("  [press Ctrl+C again to exit]", true);
	};

	useInput((value, key) =>
		handleTuiInput(value, key, {
			state,
			picker,
			pickerIndex,
			history,
			historyIndex,
			setPicker,
			setPickerIndex,
			setInput,
			onCtrlC: handleCtrlC,
			onApproval: (decision) => void approve(decision),
			onModelSelect: (model) => void selectModel(model),
		}),
	);

	const streaming = streamingText(state, hasReceivedFirstToken, isThinking, requestElapsed);
	const reasoning = streaming
		? ""
		: reasoningTextForDisplay(isThinking, showThinking, reasoningText, elapsed);
	const phase = phaseLabel(state, hasReceivedFirstToken, isThinking);

	return (
		<Box flexDirection="column" height="100%">
			<Static items={messages}>
				{(message) => (
					<Box key={message.id} paddingX={1}>
						<Text dimColor={message.dim ?? false}>{message.text}</Text>
					</Box>
				)}
			</Static>
			<Box paddingX={1} flexDirection="column">
				{streaming && <Text color="gray">{streaming}</Text>}
				{reasoning && <Text color="gray">{reasoning}</Text>}
			</Box>
			<StatusBar
				provider={providerName()}
				model={state.model}
				tokens={state.tokens.totalTokens}
				lastPrompt={lastPrompt}
				contextSize={contextSize}
				activeSkill={activeSkillName()}
				busy={isBusy}
				phase={phase}
				elapsed={requestElapsed}
				tokensPerSecond={tokensPerSecond}
			/>
			<InputArea
				state={state}
				picker={picker}
				pickerIndex={pickerIndex}
				pickerLoading={pickerLoading}
				activeModel={`${providerName()}/${state.model}`}
				input={input}
				setInput={setInput}
				onSubmit={handleSubmit}
			/>
		</Box>
	);
}
