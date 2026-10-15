import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isGlobOutsideProject,
	isPathOutsideProject,
	resolveGlobPattern,
	resolveRealPath,
} from "./path-policy.js";

const temporaryRoots: string[] = [];

const createRoot = (): string => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "anvil-path-policy-")));
	temporaryRoots.push(root);
	return root;
};

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project path policy", () => {
	it("resolves relative and absolute paths against the canonical project root", async () => {
		const root = createRoot();

		await expect(resolveRealPath("src/index.ts", root)).resolves.toBe(join(root, "src/index.ts"));
		await expect(resolveRealPath(join(root, "src/index.ts"), root)).resolves.toBe(
			join(root, "src/index.ts"),
		);
	});

	it("resolves symlink targets before checking project boundaries", async () => {
		const root = createRoot();
		const outside = createRoot();
		symlinkSync(outside, join(root, "escape"));

		await expect(isPathOutsideProject("escape/file.txt", root)).resolves.toBe(true);
		await expect(resolveRealPath("escape/file.txt", root)).resolves.toBe(join(outside, "file.txt"));
	});

	it("resolves dangling symlinks before allowing new-file targets", async () => {
		const root = createRoot();
		const outside = createRoot();
		symlinkSync(join(outside, "new-file.txt"), join(root, "dangling"));

		await expect(isPathOutsideProject("dangling", root)).resolves.toBe(true);
		await expect(resolveRealPath("dangling", root)).resolves.toBe(join(outside, "new-file.txt"));
	});

	it("expands home-directory paths for boundary checks", async () => {
		const root = createRoot();

		await expect(isPathOutsideProject("~/.ssh/id_rsa", root, true)).resolves.toBe(true);
		await expect(resolveRealPath("~/.ssh/id_rsa", root, true)).resolves.toBe(
			join(homedir(), ".ssh/id_rsa"),
		);
	});

	it("canonicalizes the static prefix of a glob pattern", async () => {
		const root = createRoot();
		const outside = createRoot();
		symlinkSync(outside, join(root, "escape"));

		await expect(isGlobOutsideProject("escape/**/*.ts", root)).resolves.toBe(true);
		await expect(resolveGlobPattern("escape/**/*.ts", root)).resolves.toEqual({
			pattern: `${relative(root, outside)}/**/*.ts`,
			cwd: root,
		});
	});

	it("requires approval for parent traversal after a glob wildcard", async () => {
		const root = createRoot();

		await expect(isGlobOutsideProject("**/../outside/**/*.ts", root)).resolves.toBe(true);
	});
});
