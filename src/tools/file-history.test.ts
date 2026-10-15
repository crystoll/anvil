import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileHistory } from "./file-history.js";

const directories: string[] = [];

const createFixture = (limits?: { maxBytes?: number; maxVersionsPerFile?: number }) => {
	const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), "anvil-file-history-test-")));
	directories.push(projectRoot);
	const historyRoot = join(projectRoot, "global-history");
	return {
		history: createFileHistory(historyRoot, limits),
		historyRoot,
		projectRoot,
	};
};

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("file history", () => {
	it("stores snapshots under a project-hashed user history directory", async () => {
		const { history, historyRoot, projectRoot } = createFixture();
		const targetPath = join(projectRoot, "file.txt");
		writeFileSync(targetPath, "before");

		const change = await history.beginChange(projectRoot, targetPath, "session");

		expect(change.backupPath).toBeDefined();
		expect(relative(historyRoot, change.backupPath ?? "")).toMatch(/^[a-f0-9]{64}\//);
		expect(readFileSync(change.backupPath as string, "utf8")).toBe("before");
		expect(existsSync(join(projectRoot, ".anvil", "file-history"))).toBe(false);
	});

	it("rejects a backup that would exceed the default 50 MB project limit", async () => {
		const { history, projectRoot } = createFixture();
		const targetPath = join(projectRoot, "oversized.txt");
		writeFileSync(targetPath, Buffer.alloc(50 * 1024 * 1024 + 1));

		await expect(history.beginChange(projectRoot, targetPath, "session")).rejects.toThrow(
			/52428800-byte history limit/,
		);
	});

	it("prunes the oldest snapshots beyond the per-file version limit", async () => {
		const { history, projectRoot } = createFixture({ maxVersionsPerFile: 2 });
		const targetPath = join(projectRoot, "file.txt");
		const changes = [];
		writeFileSync(targetPath, "initial");

		for (const content of ["first", "second", "third"]) {
			const change = await history.beginChange(projectRoot, targetPath, "session");
			changes.push(change);
			writeFileSync(targetPath, content);
			await history.completeChange(change);
		}

		expect(changes[0]?.backupPath && existsSync(changes[0].backupPath)).toBe(false);
		expect(changes[1]?.backupPath && existsSync(changes[1].backupPath)).toBe(true);
		expect(changes[2]?.backupPath && existsSync(changes[2].backupPath)).toBe(true);
	});

	it("keeps at most 20 snapshots per file by default", async () => {
		const { history, projectRoot } = createFixture();
		const targetPath = join(projectRoot, "file.txt");
		writeFileSync(targetPath, "initial");
		const changes = [];

		for (let index = 0; index < 21; index++) {
			const change = await history.beginChange(projectRoot, targetPath, "session");
			changes.push(change);
			writeFileSync(targetPath, `version-${index}`);
			await history.completeChange(change);
		}

		expect(changes[0]?.backupPath && existsSync(changes[0].backupPath)).toBe(false);
		expect(changes[20]?.backupPath && existsSync(changes[20].backupPath)).toBe(true);
	});

	it("prunes oldest backups to keep the project history under its byte limit", async () => {
		const { history, projectRoot } = createFixture({ maxBytes: 8 });
		const firstPath = join(projectRoot, "first.txt");
		const secondPath = join(projectRoot, "second.txt");
		writeFileSync(firstPath, "123456");
		writeFileSync(secondPath, "abcdef");

		const first = await history.beginChange(projectRoot, firstPath, "session");
		await history.completeChange(first);
		const second = await history.beginChange(projectRoot, secondPath, "session");
		await history.completeChange(second);

		expect(first.backupPath && existsSync(first.backupPath)).toBe(false);
		expect(second.backupPath && existsSync(second.backupPath)).toBe(true);
	});

	it("requires a preview before undoing and restores only the current session's last write", async () => {
		const { history, projectRoot } = createFixture();
		const targetPath = join(projectRoot, "file.txt");
		writeFileSync(targetPath, "before");
		const change = await history.beginChange(projectRoot, targetPath, "session");
		writeFileSync(targetPath, "after");
		await history.completeChange(change);

		expect(await history.previewUndo(projectRoot, "other-session")).toBeUndefined();
		await expect(history.confirmUndo(projectRoot, "session")).rejects.toThrow(/preview/i);
		const preview = await history.previewUndo(projectRoot, "session");
		expect(preview).toMatchObject({ action: "restore", targetPath });
		expect(readFileSync(targetPath, "utf8")).toBe("after");

		await expect(history.confirmUndo(projectRoot, "session")).resolves.toMatchObject({
			action: "restored",
			targetPath,
		});
		expect(readFileSync(targetPath, "utf8")).toBe("before");
	});

	it("recovers an interrupted write from its durable pending record", async () => {
		const { history, historyRoot, projectRoot } = createFixture();
		const targetPath = join(projectRoot, "interrupted.txt");
		writeFileSync(targetPath, "before");
		await history.beginChange(projectRoot, targetPath, "session");
		writeFileSync(targetPath, "partially written");
		const recoveredHistory = createFileHistory(historyRoot);

		expect(await recoveredHistory.previewUndo(projectRoot, "session")).toMatchObject({
			action: "restore",
			targetPath,
		});
		await recoveredHistory.confirmUndo(projectRoot, "session");
		expect(readFileSync(targetPath, "utf8")).toBe("before");
	});

	it("undoes a new file by deleting it after confirmation", async () => {
		const { history, projectRoot } = createFixture();
		const targetPath = join(projectRoot, "created.txt");
		const change = await history.beginChange(projectRoot, targetPath, "session");
		expect(change.backupPath).toBeUndefined();
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(targetPath, "created");
		await history.completeChange(change);

		expect(await history.previewUndo(projectRoot, "session")).toMatchObject({
			action: "delete",
			targetPath,
		});
		await history.confirmUndo(projectRoot, "session");
		expect(existsSync(targetPath)).toBe(false);
	});

	it("refuses to overwrite a file changed after the undo preview", async () => {
		const { history, projectRoot } = createFixture();
		const targetPath = join(projectRoot, "changed-after-preview.txt");
		writeFileSync(targetPath, "before");
		const change = await history.beginChange(projectRoot, targetPath, "session");
		writeFileSync(targetPath, "after");
		await history.completeChange(change);
		await history.previewUndo(projectRoot, "session");
		writeFileSync(targetPath, "external change");

		await expect(history.confirmUndo(projectRoot, "session")).rejects.toThrow(
			/changed after the undo preview/i,
		);
		expect(readFileSync(targetPath, "utf8")).toBe("external change");
	});
});
