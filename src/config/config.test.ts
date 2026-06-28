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
		expect(config.providers.ollama?.endpoint).toBe("http://localhost:11434/v1");
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
});

describe("validateProviderEntries", async () => {
	const { validateProviderEntries } = await import("./config.js");

	it("returns no warnings for valid providers", () => {
		const warnings = validateProviderEntries({
			ollama: { endpoint: "http://localhost:11434/v1" },
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
			local: { endpoint: "http://localhost:11434/v1" },
		});
		expect(warnings).toEqual([]);
	});
});
