import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../provider/types.js";
import { listSessions, loadSession, saveSession } from "./session.js";

const TEST_DIR = join(import.meta.dirname, "../../.test-sessions");

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

const sampleMessages: Message[] = [
	{ role: "system", content: "You are helpful." },
	{ role: "user", content: "Hello" },
	{ role: "assistant", content: "Hi there!" },
];

describe("session persistence", () => {
	it("saves and loads a session", () => {
		const id = saveSession(TEST_DIR, sampleMessages);

		expect(id).toBeTruthy();
		expect(existsSync(join(TEST_DIR, `${id}.json`))).toBe(true);

		const loaded = loadSession(TEST_DIR, id);
		expect(loaded.isOk()).toBe(true);
		expect(loaded._unsafeUnwrap().messages).toEqual(sampleMessages);
	});

	it("overwrites when saving with existing id", () => {
		const id = saveSession(TEST_DIR, sampleMessages);
		const updated: Message[] = [...sampleMessages, { role: "user", content: "More" }];
		saveSession(TEST_DIR, updated, id);

		const loaded = loadSession(TEST_DIR, id);
		expect(loaded._unsafeUnwrap().messages).toHaveLength(4);
	});

	it("returns err when loading nonexistent session", () => {
		const result = loadSession(TEST_DIR, "nonexistent");
		expect(result.isErr()).toBe(true);
	});

	it("lists sessions sorted by most recent", () => {
		saveSession(TEST_DIR, sampleMessages);
		saveSession(TEST_DIR, [{ role: "user", content: "Second" }]);

		const sessions = listSessions(TEST_DIR);
		expect(sessions).toHaveLength(2);
		expect((sessions[0]?.updatedAt ?? 0) >= (sessions[1]?.updatedAt ?? 0)).toBe(true);
	});

	it("returns latest session id from list", async () => {
		saveSession(TEST_DIR, sampleMessages);
		await new Promise((r) => setTimeout(r, 10));
		const secondId = saveSession(TEST_DIR, [{ role: "user", content: "Latest" }]);

		const sessions = listSessions(TEST_DIR);
		expect(sessions[0]?.id).toBe(secondId);
	});
});
