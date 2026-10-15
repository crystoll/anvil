import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFileTool, search, writeFileTool } from "./builtins.js";

const ROOT = join(tmpdir(), "anvil-builtins-test");
const context = { projectRoot: ROOT, signal: new AbortController().signal };

beforeEach(() => mkdirSync(ROOT, { recursive: true }));
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("file history", () => {
	it("write_file backs up existing file", async () => {
		writeFileSync(join(ROOT, "hello.txt"), "original");
		await writeFileTool.execute({ path: "hello.txt", content: "new" }, context);

		const histDir = join(ROOT, ".anvil/file-history/hello.txt");
		const backups = readdirSync(histDir);
		expect(backups.length).toBe(1);
		expect(readFileSync(join(histDir, backups[0] as string), "utf-8")).toBe("original");
	});

	it("write_file does not backup when file is new", async () => {
		await writeFileTool.execute({ path: "brand-new.txt", content: "content" }, context);

		const histDir = join(ROOT, ".anvil/file-history/brand-new.txt");
		expect(() => readdirSync(histDir)).toThrow();
	});

	it("edit_file backs up before editing", async () => {
		writeFileSync(join(ROOT, "edit-me.txt"), "foo bar baz");
		await editFileTool.execute({ path: "edit-me.txt", search: "bar", replace: "qux" }, context);

		const histDir = join(ROOT, ".anvil/file-history/edit-me.txt");
		const backups = readdirSync(histDir);
		expect(backups.length).toBe(1);
		expect(readFileSync(join(histDir, backups[0] as string), "utf-8")).toBe("foo bar baz");
		expect(readFileSync(join(ROOT, "edit-me.txt"), "utf-8")).toBe("foo qux baz");
	});
});

describe("edit_file", () => {
	it("F10: writes the replacement literally, without $ patterns", async () => {
		writeFileSync(join(ROOT, "price.txt"), "price: X");
		await editFileTool.execute({ path: "price.txt", search: "X", replace: "$&100 $$ $1" }, context);

		expect(readFileSync(join(ROOT, "price.txt"), "utf-8")).toBe("price: $&100 $$ $1");
	});

	it("normalizes CRLF and matches lines after trimming surrounding whitespace", async () => {
		writeFileSync(join(ROOT, "crlf.txt"), "first\r\n\tconst value = 1;  \r\nlast\r\n");

		await editFileTool.execute(
			{
				path: "crlf.txt",
				search: " const value = 1; ",
				replace: "\tconst value = 2;",
			},
			context,
		);

		expect(readFileSync(join(ROOT, "crlf.txt"), "utf-8")).toBe("first\n\tconst value = 2;\nlast\n");
	});

	it("matches when whitespace inside the search differs", async () => {
		writeFileSync(
			join(ROOT, "whitespace.txt"),
			"const result = calculate(\n\tfirst,  second\n);\n",
		);

		await editFileTool.execute(
			{
				path: "whitespace.txt",
				search: "const result = calculate( first, second );",
				replace: "const result = 1;",
			},
			context,
		);

		expect(readFileSync(join(ROOT, "whitespace.txt"), "utf-8")).toBe("const result = 1;\n");
	});

	it("reports duplicate matches with their line numbers instead of editing", async () => {
		writeFileSync(join(ROOT, "duplicates.txt"), "x = 1\nx = 1\n");

		await expect(
			editFileTool.execute({ path: "duplicates.txt", search: "x = 1", replace: "x = 2" }, context),
		).rejects.toThrow(/2 matches.*lines 1, 2/);
		expect(readFileSync(join(ROOT, "duplicates.txt"), "utf-8")).toBe("x = 1\nx = 1\n");
	});

	it("replaces all matches when replace_all is true", async () => {
		writeFileSync(join(ROOT, "replace-all.txt"), "x = 1\nx = 1\n");

		await editFileTool.execute(
			{
				path: "replace-all.txt",
				search: "x = 1",
				replace: "x = 2",
				replace_all: true,
			},
			context,
		);

		expect(readFileSync(join(ROOT, "replace-all.txt"), "utf-8")).toBe("x = 2\nx = 2\n");
	});

	it("shows the closest numbered lines when there is no match", async () => {
		writeFileSync(
			join(ROOT, "closest.txt"),
			'alpha\nfunction greetUser(name) {\n  return "hello";\n}\nomega\n',
		);

		await expect(
			editFileTool.execute(
				{
					path: "closest.txt",
					search: "function greetUser(userName) {\n  return 'hello';",
					replace: "unused",
				},
				context,
			),
		).rejects.toThrow(/Closest region[\s\S]*2: function greetUser\(name\)[\s\S]*3: {3}return/);
	});

	it("rejects an empty search and leaves the file untouched", async () => {
		writeFileSync(join(ROOT, "keep.txt"), "hello");
		const edit = editFileTool.execute({ path: "keep.txt", search: "", replace: "X" }, context);

		await expect(edit).rejects.toThrow(/must not be empty/);
		expect(readFileSync(join(ROOT, "keep.txt"), "utf-8")).toBe("hello");
	});
});

describe("search", () => {
	it("uses fixed-string matching by default and returns matching lines", async () => {
		writeFileSync(join(ROOT, "matches.ts"), "const value = x.y;\nconst other = xay;\n");

		const result = await search.execute({ query: "X.Y" }, context);

		expect(result).toContain("matches.ts:1: const value = x.y;");
		expect(result).not.toContain("matches.ts:2:");
	});

	it("uses regular expressions when regex is enabled", async () => {
		writeFileSync(join(ROOT, "regex.ts"), "const value = x.y;\nconst other = xay;\n");

		const result = await search.execute({ query: "x.y", regex: true }, context);

		expect(result).toContain("regex.ts:1: const value = x.y;");
		expect(result).toContain("regex.ts:2: const other = xay;");
	});

	it("excludes dependency, git, and build directories", async () => {
		for (const directory of ["node_modules", ".git", "dist"]) {
			const path = join(ROOT, directory);
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "ignored.txt"), "needle\n");
		}
		writeFileSync(join(ROOT, "source.txt"), "needle\n");

		const result = await search.execute({ query: "needle" }, context);

		expect(result).toContain("source.txt:1: needle");
		expect(result).not.toContain("ignored.txt");
	});

	it("caps results at 100 matching lines and reports truncation", async () => {
		writeFileSync(
			join(ROOT, "many.txt"),
			`${Array.from({ length: 105 }, (_, i) => `needle ${i}`).join("\n")}\n`,
		);

		const result = await search.execute({ query: "needle" }, context);
		const resultLines = result.split("\n").filter((line) => line.startsWith("many.txt:"));

		expect(resultLines).toHaveLength(100);
		expect(result).toContain("truncated");
		expect(result).not.toContain("many.txt:101:");
	});

	it("reports search command errors instead of treating them as no matches", async () => {
		await expect(
			search.execute({ query: "needle", path: "missing-directory" }, context),
		).rejects.toThrow(/Search failed/);
	});

	it("returns a no-match result only when the search completes successfully", async () => {
		writeFileSync(join(ROOT, "source.txt"), "present\n");

		await expect(search.execute({ query: "absent" }, context)).resolves.toBe("No matches found");
	});

	it("rejects an empty query", async () => {
		await expect(search.execute({ query: "" }, context)).rejects.toThrow(/must not be empty/);
	});
});
