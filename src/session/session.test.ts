import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		const id = saveSession(TEST_DIR, sampleMessages)._unsafeUnwrap();

		expect(id).toBeTruthy();
		expect(existsSync(join(TEST_DIR, `${id}.json`))).toBe(true);

		const loaded = loadSession(TEST_DIR, id);
		expect(loaded.isOk()).toBe(true);
		expect(loaded._unsafeUnwrap().messages).toEqual(sampleMessages);
	});

	it("persists assistant response status", () => {
		const messages: Message[] = [
			{ role: "assistant", content: "partial", status: "interrupted" },
			{ role: "assistant", content: "failed", status: "error" },
		];
		const id = saveSession(TEST_DIR, messages)._unsafeUnwrap();

		expect(loadSession(TEST_DIR, id)._unsafeUnwrap().messages).toEqual(messages);
	});

	it("persists session metadata and derives a bounded title from the first user message", () => {
		const id = saveSession(
			TEST_DIR,
			[
				{ role: "user", content: "A".repeat(70) },
				{ role: "assistant", content: "Answer" },
				{ role: "user", content: "A later request" },
			],
			undefined,
			undefined,
			{
				cwd: "/work/project",
				provider: "ollama",
				model: "qwen",
				agent: "default",
				skill: "review",
				status: "interrupted",
			},
		)._unsafeUnwrap();
		const loaded = loadSession(TEST_DIR, id)._unsafeUnwrap();

		expect(loaded).toMatchObject({
			cwd: "/work/project",
			provider: "ollama",
			model: "qwen",
			agent: "default",
			skill: "review",
			title: "A".repeat(60),
			status: "interrupted",
		});
		expect(listSessions(TEST_DIR)[0]).toMatchObject({
			cwd: "/work/project",
			title: "A".repeat(60),
			status: "interrupted",
		});
	});

	it("loads legacy sessions without metadata", () => {
		const legacySession = {
			id: "legacy01",
			createdAt: 1,
			updatedAt: 2,
			messages: sampleMessages,
		};
		writeFileSync(join(TEST_DIR, "legacy01.json"), JSON.stringify(legacySession));

		expect(loadSession(TEST_DIR, "legacy01")._unsafeUnwrap()).toEqual(legacySession);
		expect(listSessions(TEST_DIR)).toContainEqual({ id: "legacy01", updatedAt: 2 });
	});

	it("updates metadata while keeping the original title and clearing stale fields", () => {
		const id = saveSession(TEST_DIR, sampleMessages, undefined, undefined, {
			cwd: "/work/old",
			provider: "old-provider",
			model: "old-model",
			skill: "review",
		})._unsafeUnwrap();
		saveSession(TEST_DIR, sampleMessages, id, undefined, {
			cwd: "/work/new",
			provider: "new-provider",
			model: "new-model",
			status: "complete",
		});

		const loaded = loadSession(TEST_DIR, id)._unsafeUnwrap();
		expect(loaded).toMatchObject({
			cwd: "/work/new",
			provider: "new-provider",
			model: "new-model",
			title: "Hello",
			status: "complete",
		});
		expect(loaded.skill).toBeUndefined();
	});

	it("overwrites when saving with existing id", () => {
		const id = saveSession(TEST_DIR, sampleMessages)._unsafeUnwrap();
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

	it("rebuilds a corrupt metadata index without losing sessions", () => {
		const id = saveSession(TEST_DIR, sampleMessages)._unsafeUnwrap();
		const original = listSessions(TEST_DIR);
		const indexPath = join(TEST_DIR, "sessions.index");
		writeFileSync(indexPath, "{");

		expect(listSessions(TEST_DIR)).toEqual(original);
		expect(JSON.parse(readFileSync(indexPath, "utf-8"))).toMatchObject({
			version: 1,
			sessions: { [id]: { meta: { id } } },
		});
	});

	it("keeps unreadable session files visible with their modification time", () => {
		writeFileSync(join(TEST_DIR, "broken-session.json"), "{");

		expect(listSessions(TEST_DIR)).toEqual([
			{ id: "broken-session", updatedAt: expect.any(Number) },
		]);
		expect(loadSession(TEST_DIR, "broken-session").isErr()).toBe(true);
	});

	it("refreshes indexed metadata and removes deleted sessions", () => {
		const firstId = saveSession(TEST_DIR, sampleMessages, "first-session", undefined, {
			status: "interrupted",
		})._unsafeUnwrap();
		listSessions(TEST_DIR);
		saveSession(TEST_DIR, sampleMessages, firstId, undefined, { status: "complete" });
		const secondId = saveSession(TEST_DIR, sampleMessages, "second-session")._unsafeUnwrap();

		expect(listSessions(TEST_DIR)).toContainEqual(
			expect.objectContaining({ id: firstId, status: "complete" }),
		);
		rmSync(join(TEST_DIR, `${firstId}.json`));

		expect(listSessions(TEST_DIR).map((session) => session.id)).toEqual([secondId]);
	});

	it("returns latest session id from list", async () => {
		saveSession(TEST_DIR, sampleMessages);
		await new Promise((r) => setTimeout(r, 10));
		const secondId = saveSession(TEST_DIR, [{ role: "user", content: "Latest" }])._unsafeUnwrap();

		const sessions = listSessions(TEST_DIR);
		expect(sessions[0]?.id).toBe(secondId);
	});
});

describe("atomic saves", () => {
	it("F9: a failed save returns err and keeps the previous file", () => {
		const id = saveSession(TEST_DIR, sampleMessages)._unsafeUnwrap();
		mkdirSync(join(TEST_DIR, `${id}.json.tmp-${process.pid}`));
		const lostUpdate: Message[] = [...sampleMessages, { role: "user", content: "Lost" }];

		const result = saveSession(TEST_DIR, lostUpdate, id);

		expect(result._unsafeUnwrapErr()).toContain(id);
		expect(loadSession(TEST_DIR, id)._unsafeUnwrap().messages).toEqual(sampleMessages);
	});

	it("F9: returns err when the history directory can't be created", () => {
		const notADirectory = join(TEST_DIR, "not-a-directory");
		writeFileSync(notADirectory, "");

		expect(saveSession(join(notADirectory, "history"), sampleMessages).isErr()).toBe(true);
	});

	it("F9: leaves only the session file behind", () => {
		const id = saveSession(TEST_DIR, sampleMessages)._unsafeUnwrap();
		saveSession(TEST_DIR, [...sampleMessages, { role: "user", content: "More" }], id);

		expect(readdirSync(TEST_DIR)).toEqual([`${id}.json`]);
	});

	it("skips temp files that a crashed save left behind", () => {
		const id = saveSession(TEST_DIR, sampleMessages)._unsafeUnwrap();
		writeFileSync(join(TEST_DIR, `${id}.json.tmp-999999`), '{"id": "half');

		expect(listSessions(TEST_DIR).map((session) => session.id)).toEqual([id]);
	});

	it("removes the temp file when the swap fails", () => {
		mkdirSync(join(TEST_DIR, "blocked.json", "inside"), { recursive: true });

		expect(saveSession(TEST_DIR, sampleMessages, "blocked").isErr()).toBe(true);
		expect(readdirSync(TEST_DIR)).toEqual(["blocked.json"]);
	});
});
