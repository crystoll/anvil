import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Result, err, ok } from "neverthrow";
import type { Message } from "../provider/types.js";

export type Session = {
	id: string;
	createdAt: number;
	updatedAt: number;
	messages: Message[];
	tokenUsage?: { promptTokens: number; totalTokens: number };
};

export type SessionMeta = {
	id: string;
	updatedAt: number;
};

/** Save messages to a session file. Returns the session id. */
export const saveSession = (
	dir: string,
	messages: Message[],
	id?: string,
	tokenUsage?: { promptTokens: number; totalTokens: number },
): string => {
	mkdirSync(dir, { recursive: true });
	const sessionId = id ?? randomUUID().slice(0, 8);
	const filePath = join(dir, `${sessionId}.json`);

	const existing = existsSync(filePath) ? readSessionFile(filePath) : undefined;
	const now = Date.now();

	const session: Session = {
		id: sessionId,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		messages,
	};
	if (tokenUsage) session.tokenUsage = tokenUsage;

	writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
	return sessionId;
};

/** Load a session by id. */
export const loadSession = (dir: string, id: string): Result<Session, string> => {
	const filePath = join(dir, `${id}.json`);
	if (!existsSync(filePath)) return err(`Session "${id}" not found`);
	const session = readSessionFile(filePath);
	return session ? ok(session) : err(`Failed to parse session "${id}"`);
};

/** List sessions sorted by most recently updated. */
export const listSessions = (dir: string): SessionMeta[] => {
	if (!existsSync(dir)) return [];

	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => metaFromFile(join(dir, f)))
		.filter((m): m is SessionMeta => m !== undefined)
		.sort((a, b) => b.updatedAt - a.updatedAt);
};

const readSessionFile = (path: string): Session | undefined => {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Session;
	} catch {
		return undefined;
	}
};

const metaFromFile = (path: string): SessionMeta | undefined => {
	const session = readSessionFile(path);
	if (session) return { id: session.id, updatedAt: session.updatedAt };
	// Fallback to file mtime if JSON is unreadable
	try {
		const stat = statSync(path);
		const id = path.split("/").pop()?.replace(".json", "") ?? "";
		return { id, updatedAt: stat.mtimeMs };
	} catch {
		return undefined;
	}
};
