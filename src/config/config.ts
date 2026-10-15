import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { err, ok, type Result } from "neverthrow";
import {
	DEFAULT_CONNECT_TIMEOUT_SECONDS,
	DEFAULT_FIRST_TOKEN_TIMEOUT_SECONDS,
	DEFAULT_STREAM_TIMEOUT_SECONDS,
} from "../provider/timeouts.js";

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
	keepAlive: string | number;
	firstTokenTimeout: number;
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
	keepAlive: "30m",
	firstTokenTimeout: DEFAULT_FIRST_TOKEN_TIMEOUT_SECONDS,
	streamTimeout: DEFAULT_STREAM_TIMEOUT_SECONDS,
	connectTimeout: DEFAULT_CONNECT_TIMEOUT_SECONDS,
	maxRounds: 25,
	showTokens: true,
	contextSize: 32768,
};

const DEFAULT_YAML = `default_provider: ollama
default_model: gemma4:e4b
keep_alive: 30m
first_token_timeout: ${DEFAULT_FIRST_TOKEN_TIMEOUT_SECONDS}
stream_timeout: ${DEFAULT_STREAM_TIMEOUT_SECONDS}
connect_timeout: ${DEFAULT_CONNECT_TIMEOUT_SECONDS}
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
		keepAlive: toKeepAlive(raw.keep_alive),
		firstTokenTimeout: toNumber(raw.first_token_timeout, DEFAULT_FIRST_TOKEN_TIMEOUT_SECONDS),
		streamTimeout: toNumber(raw.stream_timeout, DEFAULT_STREAM_TIMEOUT_SECONDS),
		connectTimeout: toNumber(raw.connect_timeout, DEFAULT_CONNECT_TIMEOUT_SECONDS),
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

const toKeepAlive = (value: unknown): string | number => {
	if (typeof value === "string" && value.trim()) return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return "30m";
};
