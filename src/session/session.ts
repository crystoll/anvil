import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { err, ok, Result } from "neverthrow";
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

const toError = (cause: unknown): Error =>
	cause instanceof Error ? cause : new Error(String(cause));

const makeDirectory = Result.fromThrowable(
	(dir: string) => mkdirSync(dir, { recursive: true }),
	toError,
);

const writeFile = Result.fromThrowable(
	(path: string, content: string) => writeFileSync(path, content, "utf-8"),
	toError,
);

const renameFile = Result.fromThrowable(
	(from: string, to: string) => renameSync(from, to),
	toError,
);

const removeQuietly = (path: string): void => {
	Result.fromThrowable(() => rmSync(path, { force: true }))();
};

/** Swaps the new content in with one rename, so a crash mid-write leaves the previous file intact. */
const replaceFile = (filePath: string, content: string): Result<void, Error> => {
	const tempPath = `${filePath}.tmp-${process.pid}`;
	return writeFile(tempPath, content)
		.andThen(() => renameFile(tempPath, filePath))
		.orElse((error) => {
			removeQuietly(tempPath);
			return err(error);
		});
};

/** Save messages to a session file. Returns the session id. */
export const saveSession = (
	dir: string,
	messages: Message[],
	id?: string,
	tokenUsage?: { promptTokens: number; totalTokens: number },
): Result<string, string> => {
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

	return makeDirectory(dir)
		.andThen(() => replaceFile(filePath, JSON.stringify(session, null, 2)))
		.map(() => sessionId)
		.mapErr((error) => `Couldn't save session "${sessionId}": ${error.message}`);
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
