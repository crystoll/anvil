import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "../provider/types.js";
import { listSessions, loadSession } from "./session.js";
import { createSessionWriter } from "./writer.js";

const TEST_DIR = join(tmpdir(), `anvil-writer-test-${process.pid}`);

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

const system: Message = { role: "system", content: "You are helpful." };
const question: Message = { role: "user", content: "Hello" };

const savedSession = (id: string | undefined) => loadSession(TEST_DIR, id ?? "")._unsafeUnwrap();

describe("session writer", () => {
	it("saves nothing until the user has said something", () => {
		const writer = createSessionWriter(TEST_DIR, () => [system]);

		expect(writer.save()._unsafeUnwrap()).toBeUndefined();
		expect(listSessions(TEST_DIR)).toEqual([]);
	});

	it("keeps saving the conversation into one file", () => {
		const messages: Message[] = [system, question];
		const writer = createSessionWriter(TEST_DIR, () => messages);

		const firstId = writer.save()._unsafeUnwrap();
		messages.push({ role: "assistant", content: "Hi!" });
		const secondId = writer.save()._unsafeUnwrap();

		expect(secondId).toBe(firstId);
		expect(writer.id()).toBe(firstId);
		expect(listSessions(TEST_DIR)).toHaveLength(1);
		expect(savedSession(firstId).messages).toEqual(messages);
	});

	it("keeps the latest token usage for the saves that follow", () => {
		const writer = createSessionWriter(TEST_DIR, () => [system, question]);

		writer.save({ promptTokens: 120, totalTokens: 150 });
		const id = writer.save()._unsafeUnwrap();

		expect(savedSession(id).tokenUsage).toEqual({ promptTokens: 120, totalTokens: 150 });
	});

	it("starts a new session without the old one's token usage", () => {
		const writer = createSessionWriter(TEST_DIR, () => [system, question]);
		const firstId = writer.save({ promptTokens: 120, totalTokens: 150 })._unsafeUnwrap();

		writer.startNew();
		const secondId = writer.save()._unsafeUnwrap();

		expect(secondId).not.toBe(firstId);
		expect(listSessions(TEST_DIR)).toHaveLength(2);
		expect(savedSession(secondId).tokenUsage).toBeUndefined();
	});

	it("saves into a resumed session", () => {
		const writer = createSessionWriter(TEST_DIR, () => [system, question]);

		writer.resume("abc12345");

		expect(writer.save()._unsafeUnwrap()).toBe("abc12345");
		expect(savedSession("abc12345").messages).toEqual([system, question]);
	});

	it("returns err and keeps no id when the session can't be written", () => {
		writeFileSync(TEST_DIR, "not a directory");
		const writer = createSessionWriter(TEST_DIR, () => [system, question]);

		expect(writer.save()._unsafeUnwrapErr()).toContain("Couldn't save session");
		expect(writer.id()).toBeUndefined();
	});
});
