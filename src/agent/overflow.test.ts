import { describe, expect, it } from "vitest";
import { isOverflow } from "./overflow.js";

describe("isOverflow", () => {
	const contextSize = 32768;

	describe("Ollama native: done_reason length + low eval_count", () => {
		it("detects overflow when finish_reason is length and eval_count <= 1", () => {
			expect(isOverflow({ finishReason: "length", evalCount: 0, contextSize })).toBe(true);
			expect(isOverflow({ finishReason: "length", evalCount: 1, contextSize })).toBe(true);
		});

		it("does not flag when eval_count is substantial", () => {
			expect(isOverflow({ finishReason: "length", evalCount: 50, contextSize })).toBe(false);
		});
	});

	describe("OpenAI-compat: finish_reason length + empty/minimal content", () => {
		it("detects overflow when finish_reason is length and content is empty", () => {
			expect(isOverflow({ finishReason: "length", content: "", contextSize })).toBe(true);
		});

		it("detects overflow when finish_reason is length and content is very short", () => {
			expect(isOverflow({ finishReason: "length", content: "I", contextSize })).toBe(true);
		});

		it("does not flag when content is substantial even with length finish", () => {
			expect(
				isOverflow({
					finishReason: "length",
					content: "Here is a detailed answer about the topic.",
					contextSize,
				}),
			).toBe(false);
		});
	});

	describe("usage exceeds contextSize", () => {
		it("detects overflow when promptTokens exceeds contextSize", () => {
			expect(isOverflow({ promptTokens: 33000, contextSize })).toBe(true);
		});

		it("does not flag when usage is within bounds", () => {
			expect(isOverflow({ promptTokens: 20000, contextSize })).toBe(false);
		});
	});

	describe("error message patterns", () => {
		it("detects Ollama context error", () => {
			expect(
				isOverflow({ errorMessage: "prompt too long; exceeded max context length", contextSize }),
			).toBe(true);
		});

		it("detects OpenAI-style context error", () => {
			expect(
				isOverflow({
					errorMessage: "This model's maximum context length is 8192 tokens",
					contextSize,
				}),
			).toBe(true);
		});

		it("detects LiteLLM/OpenRouter error", () => {
			expect(
				isOverflow({
					errorMessage: "Request exceeds maximum context length of 131072",
					contextSize,
				}),
			).toBe(true);
		});

		it("detects llama.cpp error", () => {
			expect(
				isOverflow({ errorMessage: "the prompt exceeds the available context size", contextSize }),
			).toBe(true);
		});

		it("detects LM Studio error", () => {
			expect(
				isOverflow({ errorMessage: "input is greater than the context length", contextSize }),
			).toBe(true);
		});

		it("detects Groq error", () => {
			expect(
				isOverflow({ errorMessage: "Please reduce the length of the messages", contextSize }),
			).toBe(true);
		});

		it("detects Anthropic error", () => {
			expect(
				isOverflow({
					errorMessage: "prompt is too long: 150000 tokens > 100000 maximum",
					contextSize,
				}),
			).toBe(true);
		});

		it("does not flag unrelated errors", () => {
			expect(isOverflow({ errorMessage: "connection refused", contextSize })).toBe(false);
			expect(isOverflow({ errorMessage: "model not found", contextSize })).toBe(false);
		});
	});

	describe("negative cases", () => {
		it("returns false for normal stop finish", () => {
			expect(isOverflow({ finishReason: "stop", contextSize })).toBe(false);
		});

		it("returns false when no signals provided", () => {
			expect(isOverflow({ contextSize })).toBe(false);
		});

		it("returns false for undefined contextSize", () => {
			expect(isOverflow({ finishReason: "length", content: "", contextSize: 0 })).toBe(false);
		});
	});
});
