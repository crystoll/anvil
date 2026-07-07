/** Signals that may indicate context overflow. */
export type OverflowSignals = {
	finishReason?: string;
	evalCount?: number;
	content?: string;
	promptTokens?: number;
	contextSize: number;
	errorMessage?: string;
};

const OVERFLOW_PATTERNS = [
	/prompt is too long/i,
	/exceeds.*context/i,
	/maximum context length/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/reduce the length of the messages/i,
	/exceeded max context length/i,
];

/** Detect context overflow from provider response signals. */
export const isOverflow = (signals: OverflowSignals): boolean => {
	if (signals.contextSize <= 0) return false;

	// Error message patterns — most reliable signal
	if (
		signals.errorMessage &&
		OVERFLOW_PATTERNS.some((p) => p.test(signals.errorMessage as string))
	) {
		return true;
	}

	// Usage exceeds context — silent overflow
	if (signals.promptTokens && signals.promptTokens > signals.contextSize) {
		return true;
	}

	// finish_reason: "length" needs additional context to distinguish from
	// intentional max_tokens limit vs context overflow
	if (signals.finishReason === "length") {
		// Ollama native: eval_count <= 1 means prompt filled the entire context
		if (signals.evalCount !== undefined && signals.evalCount <= 1) return true;
		// OpenAI-compat: empty or minimal content means no room for output
		if (signals.content !== undefined && signals.content.length < 10) return true;
	}

	return false;
};
