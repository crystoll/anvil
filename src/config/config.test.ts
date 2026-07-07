import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const TEST_DIR = join(import.meta.dirname, "../../.test-config");
const CONFIG_PATH = join(TEST_DIR, "config.yaml");

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("config loader", () => {
	it("creates default config when file does not exist", () => {
		const result = loadConfig(CONFIG_PATH);

		expect(result.isOk()).toBe(true);
		const config = result._unsafeUnwrap();
		expect(config.defaultProvider).toBe("ollama");
		expect(config.defaultModel).toBe("gemma4:e4b");
		expect(config.providers.ollama).toBeDefined();
		expect(config.providers.ollama?.endpoint).toBe("http://localhost:11434");
		expect(existsSync(CONFIG_PATH)).toBe(true);
	});

	it("loads existing valid config", () => {
		writeFileSync(
			CONFIG_PATH,
			`default_provider: lmstudio
default_model: some-model
providers:
  lmstudio:
    endpoint: http://localhost:1234/v1
`,
		);

		const result = loadConfig(CONFIG_PATH);

		expect(result.isOk()).toBe(true);
		const config = result._unsafeUnwrap();
		expect(config.defaultProvider).toBe("lmstudio");
		expect(config.defaultModel).toBe("some-model");
		expect(config.providers.lmstudio?.endpoint).toBe("http://localhost:1234/v1");
	});

	it("applies defaults for missing optional fields", () => {
		writeFileSync(
			CONFIG_PATH,
			`default_provider: ollama
default_model: qwen3:8b
providers:
  ollama:
    endpoint: http://localhost:11434/v1
`,
		);

		const result = loadConfig(CONFIG_PATH);

		expect(result.isOk()).toBe(true);
		const config = result._unsafeUnwrap();
		expect(config.streamTimeout).toBe(120);
		expect(config.connectTimeout).toBe(120);
		expect(config.maxRounds).toBe(25);
	});

	it("returns err for invalid YAML", () => {
		writeFileSync(CONFIG_PATH, "{{{{invalid yaml");

		const result = loadConfig(CONFIG_PATH);
		expect(result.isErr()).toBe(true);
	});

	it("returns err when default_provider is missing", () => {
		writeFileSync(
			CONFIG_PATH,
			`default_model: something
providers:
  ollama:
    endpoint: http://localhost:11434/v1
`,
		);

		const result = loadConfig(CONFIG_PATH);
		expect(result.isErr()).toBe(true);
	});

	it("preserves api_key from config", () => {
		writeFileSync(
			CONFIG_PATH,
			`default_provider: litellm
default_model: claude-3
providers:
  litellm:
    endpoint: https://my-proxy.com/v1
    api_key: sk-secret-123
`,
		);

		const result = loadConfig(CONFIG_PATH);

		expect(result.isOk()).toBe(true);
		const config = result._unsafeUnwrap();
		expect(config.providers.litellm?.apiKey).toBe("sk-secret-123");
	});

	it("resolves env var placeholders in api_key", () => {
		process.env.TEST_ANVIL_KEY = "resolved-key-456";
		writeFileSync(
			CONFIG_PATH,
			`default_provider: litellm
default_model: claude-3
providers:
  litellm:
    endpoint: https://my-proxy.com/v1
    api_key: \${TEST_ANVIL_KEY}
`,
		);

		const result = loadConfig(CONFIG_PATH);

		expect(result.isOk()).toBe(true);
		const config = result._unsafeUnwrap();
		expect(config.providers.litellm?.apiKey).toBe("resolved-key-456");
		delete process.env.TEST_ANVIL_KEY;
	});
	it("parses ANVIL_CONTEXT_SIZE from env var string", () => {
		process.env.ANVIL_CONTEXT_SIZE = "131072";
		writeFileSync(
			CONFIG_PATH,
			`default_provider: ollama\ndefault_model: test\nproviders:\n  ollama:\n    endpoint: http://localhost:11434\n`,
		);
		const result = loadConfig(CONFIG_PATH);
		expect(result.isOk()).toBe(true);
		expect(result._unsafeUnwrap().contextSize).toBe(131072);
		delete process.env.ANVIL_CONTEXT_SIZE;
	});
});

describe("validateProviderEntries", async () => {
	const { validateProviderEntries } = await import("./config.js");

	it("returns no warnings for valid providers", () => {
		const warnings = validateProviderEntries({
			ollama: { endpoint: "http://localhost:11434" },
			remote: { endpoint: "https://api.example.com/v1", apiKey: "sk-123" },
		});
		expect(warnings).toEqual([]);
	});

	it("warns on empty endpoint", () => {
		const warnings = validateProviderEntries({
			broken: { endpoint: "" },
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("broken");
		expect(warnings[0]).toContain("empty");
	});

	it("warns on non-URL endpoint", () => {
		const warnings = validateProviderEntries({
			bad: { endpoint: "not-a-url" },
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("bad");
		expect(warnings[0]).toContain("not a valid URL");
	});

	it("does not warn on missing apiKey (no auth is valid)", () => {
		const warnings = validateProviderEntries({
			local: { endpoint: "http://localhost:11434" },
		});
		expect(warnings).toEqual([]);
	});

	it("warns when Ollama endpoint has /v1 suffix", () => {
		const warnings = validateProviderEntries({
			ollama: { endpoint: "http://localhost:11434/v1" },
		});
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Remove /v1");
	});

	it("does not warn about /v1 on non-Ollama endpoints", () => {
		const warnings = validateProviderEntries({
			lmstudio: { endpoint: "http://localhost:1234/v1" },
		});
		expect(warnings).toEqual([]);
	});
});

describe("isOllamaEndpoint", async () => {
	const { isOllamaEndpoint } = await import("../shared/bootstrap.js");

	it("returns true for bare Ollama endpoint", () => {
		expect(isOllamaEndpoint("http://localhost:11434")).toBe(true);
	});

	it("returns true for Ollama on custom port", () => {
		expect(isOllamaEndpoint("http://localhost:8080")).toBe(true);
	});

	it("returns true for Ollama with trailing slash", () => {
		expect(isOllamaEndpoint("http://localhost:11434/")).toBe(true);
	});

	it("returns false for endpoint with /v1 path", () => {
		expect(isOllamaEndpoint("http://localhost:11434/v1")).toBe(false);
	});

	it("returns false for LM Studio /v1 endpoint", () => {
		expect(isOllamaEndpoint("http://localhost:1234/v1")).toBe(false);
	});

	it("returns false for remote /v1 endpoint", () => {
		expect(isOllamaEndpoint("https://api.example.com/v1")).toBe(false);
	});

	it("returns false for invalid URL", () => {
		expect(isOllamaEndpoint("not-a-url")).toBe(false);
	});
});
