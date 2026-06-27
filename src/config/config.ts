import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { type Result, err, ok } from "neverthrow";

/** Provider entry in config. */
export type ProviderEntry = {
	endpoint: string;
	apiKey?: string;
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
		ollama: { endpoint: "http://localhost:11434/v1" },
	},
	streamTimeout: 120,
	connectTimeout: 120,
	maxRounds: 25,
	showTokens: true,
	contextSize: 131072,
};

const DEFAULT_YAML = `default_provider: ollama
default_model: gemma4:e4b
stream_timeout: 120
connect_timeout: 120
context_size: 131072
max_rounds: 25

providers:
  ollama:
    endpoint: http://localhost:11434/v1
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
		parsed = yaml.load(raw);
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
		connectTimeout: toNumber(raw.connect_timeout, 120),
		maxRounds: toNumber(raw.max_rounds, 25),
		contextSize: toNumber(raw.context_size, 131072),
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

		const provider: ProviderEntry = { endpoint };
		const apiKey = entry?.api_key;
		if (typeof apiKey === "string" && apiKey) provider.apiKey = apiKey;
		result[name] = provider;
	}
	return ok(result);
};

const toNumber = (value: unknown, fallback: number): number => {
	if (typeof value === "number") return value;
	return fallback;
};
