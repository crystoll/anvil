import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "./config.js";

const TEST_DIR = join(tmpdir(), "anvil-mcp-test");

beforeEach(() => mkdirSync(TEST_DIR, { recursive: true }));
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe("loadMcpConfig", () => {
	it("returns empty config when no files exist", () => {
		const result = loadMcpConfig([join(TEST_DIR, "missing.json")]);
		expect(result.isOk()).toBe(true);
		expect(result._unsafeUnwrap()).toEqual({});
	});

	it("parses mcpServers format", () => {
		const file = join(TEST_DIR, "mcp.json");
		writeFileSync(
			file,
			JSON.stringify({
				mcpServers: {
					obsidian: { command: "npx", args: ["@bitbonsai/mcpvault@latest", "/vault"] },
				},
			}),
		);
		const result = loadMcpConfig([file]);
		expect(result.isOk()).toBe(true);
		const config = result._unsafeUnwrap();
		const obsidian = config.obsidian;
		expect(obsidian && "command" in obsidian && obsidian.command).toBe("npx");
		expect(obsidian && "args" in obsidian && obsidian.args).toEqual([
			"@bitbonsai/mcpvault@latest",
			"/vault",
		]);
	});

	it("parses http entries alongside stdio", () => {
		const file = join(TEST_DIR, "mcp.json");
		writeFileSync(
			file,
			JSON.stringify({
				mcpServers: {
					docs: { type: "http", url: "https://example.com/mcp" },
					local: { command: "node", args: ["server.js"] },
				},
			}),
		);
		const result = loadMcpConfig([file]);
		const config = result._unsafeUnwrap();
		expect(Object.keys(config).sort()).toEqual(["docs", "local"]);
		const docs = config.docs;
		expect(docs && "url" in docs && docs.url).toBe("https://example.com/mcp");
	});

	it("merges multiple files (first wins)", () => {
		const file1 = join(TEST_DIR, "project.json");
		const file2 = join(TEST_DIR, "global.json");
		writeFileSync(file1, JSON.stringify({ mcpServers: { s1: { command: "a" } } }));
		writeFileSync(
			file2,
			JSON.stringify({ mcpServers: { s1: { command: "b" }, s2: { command: "c" } } }),
		);
		const config = loadMcpConfig([file1, file2])._unsafeUnwrap();
		const s1 = config.s1;
		expect(s1 && "command" in s1 && s1.command).toBe("a"); // project wins
		const s2 = config.s2;
		expect(s2 && "command" in s2 && s2.command).toBe("c"); // only in global
	});

	it("parses autoApprove list", () => {
		const file = join(TEST_DIR, "mcp.json");
		writeFileSync(
			file,
			JSON.stringify({
				mcpServers: {
					test: { command: "node", args: ["s.js"], autoApprove: ["tool-a", "tool-b"] },
				},
			}),
		);
		const config = loadMcpConfig([file])._unsafeUnwrap();
		expect(config.test?.autoApprove).toEqual(["tool-a", "tool-b"]);
	});

	it("returns error on invalid JSON", () => {
		const file = join(TEST_DIR, "bad.json");
		writeFileSync(file, "not json{");
		const result = loadMcpConfig([file]);
		expect(result.isErr()).toBe(true);
	});
});
