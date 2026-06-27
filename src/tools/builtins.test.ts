import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFileTool, writeFileTool } from "./builtins.js";

const ROOT = join(tmpdir(), "anvil-builtins-test");

beforeEach(() => mkdirSync(ROOT, { recursive: true }));
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("file history", () => {
	it("write_file backs up existing file", async () => {
		writeFileSync(join(ROOT, "hello.txt"), "original");
		await writeFileTool.execute({ path: "hello.txt", content: "new" }, ROOT);

		const histDir = join(ROOT, ".anvil/file-history/hello.txt");
		const backups = readdirSync(histDir);
		expect(backups.length).toBe(1);
		expect(readFileSync(join(histDir, backups[0] as string), "utf-8")).toBe("original");
	});

	it("write_file does not backup when file is new", async () => {
		await writeFileTool.execute({ path: "brand-new.txt", content: "content" }, ROOT);

		const histDir = join(ROOT, ".anvil/file-history/brand-new.txt");
		expect(() => readdirSync(histDir)).toThrow();
	});

	it("edit_file backs up before editing", async () => {
		writeFileSync(join(ROOT, "edit-me.txt"), "foo bar baz");
		await editFileTool.execute({ path: "edit-me.txt", search: "bar", replace: "qux" }, ROOT);

		const histDir = join(ROOT, ".anvil/file-history/edit-me.txt");
		const backups = readdirSync(histDir);
		expect(backups.length).toBe(1);
		expect(readFileSync(join(histDir, backups[0] as string), "utf-8")).toBe("foo bar baz");
		expect(readFileSync(join(ROOT, "edit-me.txt"), "utf-8")).toBe("foo qux baz");
	});
});
