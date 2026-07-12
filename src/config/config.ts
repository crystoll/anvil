import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { err, ok, type Result } from "neverthrow";

/** Provider entry in config. */
export type ProviderEntry = {
	endpoint: string;
	apiKey?: string;
	contextSize?: number;
};

/** Full Anvil config. */
export type AnvilConfig = {
	defaultProvider: string;
	defaultModel: string;
	providers: Record<string, ProviderEntry>;
	streamTimeout: number;
	connectTimeout: number;
	maxRounds: number;
	showTokens: boolean;
	contextSize: number;
};

export type ConfigError = { kind: "parse" | "validation"; message: string };

const DEFAULT_CONFIG: AnvilConfig = {
	defaultProvider: "ollama",
	defaultModel: "gemma4:e4b",
	providers: {
		ollama: { endpoint: "http://localhost:11434" },
	},
	streamTimeout: 120,
	connectTimeout: 300,
	maxRounds: 25,
	showTokens: true,
	contextSize: 32768,
};

const DEFAULT_YAML = `default_provider: ollama
default_model: gemma4:e4b
stream_timeout: 120
connect_timeout: 300
context_size: 32768
max_rounds: 25

providers:
  ollama:
    endpoint: http://localhost:11434
`;

/** Load config from path, creating defaults if missing. */
export const loadConfig = (path: string): Result<AnvilConfig, ConfigError> => {
	if (!existsSync(path)) {
		return createDefault(path);
	}
	return parseConfigFile(path);
};

const createDefault = (path: string): Result<AnvilConfig, ConfigError> => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, DEFAULT_YAML, "utf-8");
	return ok(DEFAULT_CONFIG);
};

const parseConfigFile = (path: string): Result<AnvilConfig, ConfigError> => {
	const raw = readFileSync(path, "utf-8");

	let parsed: unknown;
	try {
		parsed = yamlLoad(raw);
	} catch (e) {
		return err({
			kind: "parse",
			message: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}`,
		});
	}

	if (typeof parsed !== "object" || parsed === null) {
		return err({ kind: "parse", message: "Config must be a YAML object" });
	}

	return validateConfig(parsed as Record<string, unknown>);
};

const validateConfig = (raw: Record<string, unknown>): Result<AnvilConfig, ConfigError> => {
	const defaultProvider = raw.default_provider;
	if (typeof defaultProvider !== "string" || !defaultProvider) {
		return err({ kind: "validation", message: "default_provider is required" });
	}

	const defaultModel = raw.default_model;
	if (typeof defaultModel !== "string" || !defaultModel) {
		return err({ kind: "validation", message: "default_model is required" });
	}

	const providers = parseProviders(raw.providers);
	if (providers.isErr()) return err(providers.error);

	return ok({
		defaultProvider,
		defaultModel,
		providers: providers.value,
		streamTimeout: toNumber(raw.stream_timeout, 120),
		connectTimeout: toNumber(raw.connect_timeout, 300),
		maxRounds: toNumber(raw.max_rounds, 25),
		contextSize: toNumber(process.env.ANVIL_CONTEXT_SIZE ?? raw.context_size, 32768),
		showTokens: raw.show_tokens !== false,
	});
};

const parseProviders = (raw: unknown): Result<Record<string, ProviderEntry>, ConfigError> => {
	if (typeof raw !== "object" || raw === null) {
		return ok({});
	}

	const result: Record<string, ProviderEntry> = {};
	for (const [name, value] of Object.entries(raw)) {
		const entry = value as Record<string, unknown>;
		const endpoint = entry?.endpoint;
		if (typeof endpoint !== "string") continue;

		const provider: ProviderEntry = { endpoint: resolveEnvVar(endpoint) };
		const apiKey = entry?.api_key;
		if (typeof apiKey === "string" && apiKey) {
			const resolved = resolveEnvVar(apiKey);
			if (resolved) provider.apiKey = resolved;
		}
		const ctxSize = entry?.context_size;
		if (typeof ctxSize === "number" && ctxSize > 0) provider.contextSize = ctxSize;
		result[name] = provider;
	}
	return ok(result);
};

/** Resolve ${ENV_VAR} patterns from process.env. */
const resolveEnvVar = (value: string): string =>
	value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");

/** Validate provider entries, return warnings for issues. */
export const validateProviderEntries = (providers: Record<string, ProviderEntry>): string[] => {
	const warnings: string[] = [];
	for (const [name, entry] of Object.entries(providers)) {
		if (!entry.endpoint) {
			warnings.push(`${name}: endpoint is empty (env var not set?)`);
		} else if (!entry.endpoint.startsWith("http://") && !entry.endpoint.startsWith("https://")) {
			warnings.push(`${name}: endpoint "${entry.endpoint}" is not a valid URL`);
		} else if (entry.endpoint.includes(":11434") && entry.endpoint.includes("/v1")) {
			warnings.push(
				`${name}: endpoint has /v1 suffix — context_size won't work. Remove /v1 for native Ollama API`,
			);
		}
	}
	return warnings;
};

const toNumber = (value: unknown, fallback: number): number => {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const n = Number(value);
		if (!Number.isNaN(n)) return n;
	}
	return fallback;
};
