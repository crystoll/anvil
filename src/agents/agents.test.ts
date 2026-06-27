import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "../tools/registry.js";
import { createRegistry } from "../tools/registry.js";
import {
	applyAgentToRegistry,
	checkCommand,
	checkPath,
	discoverAgents,
	loadAgentConfig,
} from "./agents.js";
import type { AgentDef } from "./agents.js";

describe("agent config", () => {
	const tmpDir = join(import.meta.dirname, "../../.test-agents");

	beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
	afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

	describe("loadAgentConfig", () => {
		it("parses valid YAML with all fields", () => {
			const yaml = `
name: explorer
description: Read-only explorer
model: gemma4:e4b
tools:
  - list_dir
  - glob
  - search
  - read_file
allowedTools:
  - list_dir
  - glob
  - search
  - read_file
toolSettings:
  read_file:
    deniedPaths:
      - "~/.ssh/**"
      - "**/.env*"
`;
			writeFileSync(join(tmpDir, "explorer.yaml"), yaml);
			const result = loadAgentConfig(join(tmpDir, "explorer.yaml"));
			expect(result.isOk()).toBe(true);
			const agent = result._unsafeUnwrap();
			expect(agent.name).toBe("explorer");
			expect(agent.model).toBe("gemma4:e4b");
			expect(agent.tools).toEqual(["list_dir", "glob", "search", "read_file"]);
			expect(agent.allowedTools).toEqual(["list_dir", "glob", "search", "read_file"]);
			expect(agent.toolSettings?.read_file?.deniedPaths).toEqual(["~/.ssh/**", "**/.env*"]);
		});

		it("accepts wildcard tools", () => {
			const yaml = `name: full\ntools:\n  - "*"`;
			writeFileSync(join(tmpDir, "full.yaml"), yaml);
			const result = loadAgentConfig(join(tmpDir, "full.yaml"));
			expect(result.isOk()).toBe(true);
			expect(result._unsafeUnwrap().tools).toEqual(["*"]);
		});

		it("fails when name is missing", () => {
			writeFileSync(join(tmpDir, "bad.yaml"), "tools:\n  - glob");
			const result = loadAgentConfig(join(tmpDir, "bad.yaml"));
			expect(result.isErr()).toBe(true);
		});

		it("fails when tools is missing", () => {
			writeFileSync(join(tmpDir, "bad2.yaml"), "name: oops");
			const result = loadAgentConfig(join(tmpDir, "bad2.yaml"));
			expect(result.isErr()).toBe(true);
		});

		it("fails for non-existent file", () => {
			const result = loadAgentConfig(join(tmpDir, "nope.yaml"));
			expect(result.isErr()).toBe(true);
		});
	});

	describe("discoverAgents", () => {
		it("finds all .yaml agent files in a directory", () => {
			writeFileSync(join(tmpDir, "a.yaml"), 'name: a\ntools:\n  - "*"');
			writeFileSync(join(tmpDir, "b.yaml"), 'name: b\ntools:\n  - "*"');
			writeFileSync(join(tmpDir, "readme.md"), "not an agent");
			const agents = discoverAgents([tmpDir]);
			expect(agents).toHaveLength(2);
			expect(agents.map((a) => a.name).sort()).toEqual(["a", "b"]);
		});

		it("deduplicates by name (first found wins)", () => {
			const dir2 = join(tmpDir, "second");
			mkdirSync(dir2);
			writeFileSync(join(tmpDir, "x.yaml"), 'name: x\ntools:\n  - "*"\ndescription: first');
			writeFileSync(join(dir2, "x.yaml"), 'name: x\ntools:\n  - "*"\ndescription: second');
			const agents = discoverAgents([tmpDir, dir2]);
			expect(agents).toHaveLength(1);
			expect(agents[0]?.description).toBe("first");
		});

		it("skips invalid files without crashing", () => {
			writeFileSync(join(tmpDir, "good.yaml"), 'name: good\ntools:\n  - "*"');
			writeFileSync(join(tmpDir, "bad.yaml"), "not: valid: yaml: [[[");
			const agents = discoverAgents([tmpDir]);
			expect(agents).toHaveLength(1);
		});
	});
});

const fakeTool = (name: string, needsApproval: boolean): Tool => ({
	name,
	description: name,
	schema: { type: "object", properties: {}, required: [] },
	needsApproval,
	timeout: 5000,
	execute: async () => "ok",
});

describe("applyAgentToRegistry", () => {
	it("filters tools to only those in agent.tools list", () => {
		const reg = createRegistry();
		reg.register(fakeTool("glob", false));
		reg.register(fakeTool("read_file", true));
		reg.register(fakeTool("run_cmd", true));

		const agent: AgentDef = { name: "test", tools: ["glob", "read_file"] };
		const filtered = applyAgentToRegistry(reg, agent);
		expect(
			filtered
				.all()
				.map((t) => t.name)
				.sort(),
		).toEqual(["glob", "read_file"]);
	});

	it("wildcard tools keeps all", () => {
		const reg = createRegistry();
		reg.register(fakeTool("glob", false));
		reg.register(fakeTool("run_cmd", true));

		const agent: AgentDef = { name: "test", tools: ["*"] };
		const filtered = applyAgentToRegistry(reg, agent);
		expect(filtered.all()).toHaveLength(2);
	});

	it("allowedTools overrides needsApproval to false", () => {
		const reg = createRegistry();
		reg.register(fakeTool("run_cmd", true));
		reg.register(fakeTool("write_file", true));

		const agent: AgentDef = { name: "test", tools: ["*"], allowedTools: ["run_cmd"] };
		const filtered = applyAgentToRegistry(reg, agent);
		expect(filtered.get("run_cmd")?.needsApproval).toBe(false);
		expect(filtered.get("write_file")?.needsApproval).toBe(true);
	});
});

describe("command guards", () => {
	it("denies command matching deniedCommands pattern", () => {
		const settings = { deniedCommands: ["rm -rf.*", "sudo.*"] };
		expect(checkCommand("rm -rf /", settings)).toBe(
			"DENIED: command matches deny pattern: rm -rf.*",
		);
		expect(checkCommand("sudo apt install", settings)).toBe(
			"DENIED: command matches deny pattern: sudo.*",
		);
	});

	it("allows command not matching any deny pattern", () => {
		const settings = { deniedCommands: ["rm -rf.*"] };
		expect(checkCommand("git status", settings)).toBeUndefined();
	});

	it("allows command matching allowedCommands", () => {
		const settings = {
			allowedCommands: ["git (diff|log|status).*", "pnpm .*"],
			deniedCommands: ["git push.*"],
		};
		expect(checkCommand("git status", settings)).toBeUndefined();
		expect(checkCommand("pnpm test", settings)).toBeUndefined();
	});

	it("deny takes priority over allow", () => {
		const settings = {
			allowedCommands: ["git .*"],
			deniedCommands: ["git push.*"],
		};
		expect(checkCommand("git push origin main", settings)).toBe(
			"DENIED: command matches deny pattern: git push.*",
		);
	});

	it("returns undefined when no settings", () => {
		expect(checkCommand("anything", {})).toBeUndefined();
	});
});

describe("path guards", () => {
	it("denies path matching deniedPaths pattern", () => {
		const settings = { deniedPaths: ["**/secret/**", "**/.env*"] };
		expect(checkPath("/home/user/secret/key", settings)).toContain("DENIED");
		expect(checkPath("/project/.env.local", settings)).toContain("DENIED");
	});

	it("allows path not matching deny", () => {
		const settings = { deniedPaths: ["~/.ssh/**"] };
		expect(checkPath("/project/src/main.ts", settings)).toBeUndefined();
	});

	it("denies path not in allowedPaths when allowedPaths set", () => {
		const settings = { allowedPaths: ["/project/**"] };
		expect(checkPath("/etc/passwd", settings)).toContain("DENIED");
	});

	it("allows path in allowedPaths", () => {
		const settings = { allowedPaths: ["/project/**"] };
		expect(checkPath("/project/src/index.ts", settings)).toBeUndefined();
	});

	it("returns undefined when no settings", () => {
		expect(checkPath("/anything", {})).toBeUndefined();
	});
});

describe("applyAgentToRegistry with toolSettings guards", () => {
	it("wraps run_cmd execute with command deny guard", async () => {
		const reg = createRegistry();
		const cmdTool: Tool = {
			...fakeTool("run_cmd", true),
			execute: async (args) => `ran: ${args.command}`,
		};
		reg.register(cmdTool);

		const agent: AgentDef = {
			name: "guarded",
			tools: ["*"],
			toolSettings: { run_cmd: { deniedCommands: ["rm -rf.*", "sudo.*"] } },
		};
		const filtered = applyAgentToRegistry(reg, agent);
		const tool = filtered.get("run_cmd") as Tool;
		expect(await tool.execute({ command: "rm -rf /" }, "/tmp")).toContain("DENIED");
		expect(await tool.execute({ command: "git status" }, "/tmp")).toBe("ran: git status");
	});

	it("wraps read_file execute with path deny guard", async () => {
		const reg = createRegistry();
		const readTool: Tool = {
			...fakeTool("read_file", false),
			execute: async (args) => `content of ${args.path}`,
		};
		reg.register(readTool);

		const agent: AgentDef = {
			name: "guarded",
			tools: ["*"],
			toolSettings: { read_file: { deniedPaths: ["**/.env*", "**/secret/**"] } },
		};
		const filtered = applyAgentToRegistry(reg, agent);
		const tool = filtered.get("read_file") as Tool;
		expect(await tool.execute({ path: "/project/.env.local" }, "/tmp")).toContain("DENIED");
		expect(await tool.execute({ path: "/project/src/main.ts" }, "/tmp")).toBe(
			"content of /project/src/main.ts",
		);
	});

	it("wraps write_file with allowedPaths guard", async () => {
		const reg = createRegistry();
		const writeTool: Tool = {
			...fakeTool("write_file", true),
			execute: async (args) => `wrote ${args.path}`,
		};
		reg.register(writeTool);

		const agent: AgentDef = {
			name: "guarded",
			tools: ["*"],
			toolSettings: { write_file: { allowedPaths: ["/project/**"] } },
		};
		const filtered = applyAgentToRegistry(reg, agent);
		const tool = filtered.get("write_file") as Tool;
		expect(await tool.execute({ path: "/etc/passwd" }, "/tmp")).toContain("DENIED");
		expect(await tool.execute({ path: "/project/new.ts" }, "/tmp")).toBe("wrote /project/new.ts");
	});
});
