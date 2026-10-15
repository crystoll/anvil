export type CommandResult =
	| {
			kind: "handled";
			message?: string;
			resetUsage?: boolean;
			usage?: { promptTokens: number; totalTokens: number };
	  }
	| { kind: "submit"; input: string }
	| { kind: "continue" }
	| { kind: "quit" };

export type CommandDefinition = {
	name: string;
	aliases?: string[];
	description: string;
	execute: (argument: string) => CommandResult | Promise<CommandResult>;
};

export type CommandSummary = { name: string; description: string };

export type CommandRegistry = {
	register: (definition: CommandDefinition) => void;
	dispatch: (input: string) => Promise<CommandResult | undefined>;
	list: () => CommandSummary[];
};

const normalizeName = (name: string): string => name.replace(/^\/+/, "").toLowerCase();

/** Create the shared command dispatcher used by both interactive interfaces. */
export const createCommandRegistry = (definitions: CommandDefinition[] = []): CommandRegistry => {
	const commands = new Map<string, CommandDefinition>();
	const names = new Set<string>();

	const register = (definition: CommandDefinition): void => {
		const name = normalizeName(definition.name);
		const aliases = definition.aliases?.map(normalizeName) ?? [];
		for (const key of [name, ...aliases]) {
			if (!key || names.has(key))
				throw new Error(`Command name or alias "${key}" is already registered`);
		}
		names.add(name);
		for (const alias of aliases) names.add(alias);
		commands.set(name, { ...definition, name });
		for (const alias of aliases) commands.set(alias, { ...definition, name });
	};

	const list = (): CommandSummary[] =>
		[...commands.values()]
			.filter(
				(definition, index, values) =>
					values.findIndex((value) => value.name === definition.name) === index,
			)
			.map(({ name, description }) => ({ name, description }));

	register({
		name: "help",
		description: "Show available commands",
		execute: () => ({
			kind: "handled",
			message: list()
				.map(({ name, description }) => `/${name} — ${description}`)
				.join("\n"),
		}),
	});
	register({
		name: "quit",
		aliases: ["exit"],
		description: "Exit Anvil",
		execute: () => ({ kind: "quit" }),
	});
	for (const definition of definitions) register(definition);

	return {
		register,
		dispatch: async (input) => {
			const trimmed = input.trim();
			if (!trimmed.startsWith("/")) return undefined;
			const [token, ...parts] = trimmed.split(/\s+/);
			const name = normalizeName(token?.slice(1) ?? "");
			const command = commands.get(name);
			return command ? command.execute(parts.join(" ")) : undefined;
		},
		list,
	};
};
