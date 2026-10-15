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

export type SessionStatus = "complete" | "interrupted" | "error";

export type SessionMetadata = {
	cwd?: string;
	provider?: string;
	model?: string;
	agent?: string;
	skill?: string;
	title?: string;
	status?: SessionStatus;
};

export type Session = {
	id: string;
	createdAt: number;
	updatedAt: number;
	messages: Message[];
	tokenUsage?: { promptTokens: number; totalTokens: number };
} & SessionMetadata;

export type SessionMeta = Pick<Session, "id" | "updatedAt"> & SessionMetadata;

const SESSION_INDEX_FILE = "sessions.index";
const INDEX_VERSION = 1;

type SessionIndexEntry = {
	size: string;
	mtimeNs: string;
	meta: SessionMeta;
};

type SessionIndex = {
	version: typeof INDEX_VERSION;
	sessions: Record<string, SessionIndexEntry>;
};

type ResolvedSessionMeta = {
	fileId: string;
	meta: SessionMeta;
	indexEntry: SessionIndexEntry;
};

const toError = (cause: unknown): Error =>
	cause instanceof Error ? cause : new Error(String(cause));

const definedMetadata = (metadata: SessionMetadata): SessionMetadata => ({
	...(metadata.cwd ? { cwd: metadata.cwd } : {}),
	...(metadata.provider ? { provider: metadata.provider } : {}),
	...(metadata.model ? { model: metadata.model } : {}),
	...(metadata.agent ? { agent: metadata.agent } : {}),
	...(metadata.skill ? { skill: metadata.skill } : {}),
	...(metadata.title ? { title: metadata.title } : {}),
	...(metadata.status ? { status: metadata.status } : {}),
});

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

let indexWriteWarningReported = false;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isSessionMeta = (value: unknown): value is SessionMeta => {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.updatedAt !== "number" ||
		!Number.isFinite(value.updatedAt)
	)
		return false;
	const metadataFields = ["cwd", "provider", "model", "agent", "skill", "title"];
	const hasValidMetadata = metadataFields.every(
		(field) => value[field] === undefined || typeof value[field] === "string",
	);
	const hasValidStatus =
		value.status === undefined ||
		value.status === "complete" ||
		value.status === "interrupted" ||
		value.status === "error";
	return hasValidMetadata && hasValidStatus;
};

const isSessionIndexEntry = (value: unknown): value is SessionIndexEntry =>
	isRecord(value) &&
	typeof value.size === "string" &&
	typeof value.mtimeNs === "string" &&
	isSessionMeta(value.meta);

const readSessionIndex = (dir: string): SessionIndex | undefined => {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, SESSION_INDEX_FILE), "utf-8"));
		if (!isRecord(parsed) || parsed.version !== INDEX_VERSION || !isRecord(parsed.sessions))
			return undefined;
		const sessions: Record<string, SessionIndexEntry> = {};
		for (const [id, entry] of Object.entries(parsed.sessions)) {
			if (!isSessionIndexEntry(entry)) return undefined;
			sessions[id] = entry;
		}
		return { version: INDEX_VERSION, sessions };
	} catch {
		return undefined;
	}
};

const writeSessionIndex = (dir: string, index: SessionIndex): void => {
	const result = replaceFile(join(dir, SESSION_INDEX_FILE), JSON.stringify(index));
	if (result.isErr() && !indexWriteWarningReported) {
		indexWriteWarningReported = true;
		console.warn(`Couldn't update session metadata index: ${result.error.message}`);
	}
};

/** Save messages to a session file. Returns the session id. */
export const saveSession = (
	dir: string,
	messages: Message[],
	id?: string,
	tokenUsage?: { promptTokens: number; totalTokens: number },
	metadata?: SessionMetadata,
): Result<string, string> => {
	const sessionId = id ?? randomUUID().slice(0, 8);
	const filePath = join(dir, `${sessionId}.json`);

	const existing = existsSync(filePath) ? readSessionFile(filePath) : undefined;
	const now = Date.now();
	const firstUserMessage = messages.find((message) => message.role === "user")?.content;
	const titleSource = existing?.title ?? metadata?.title ?? firstUserMessage;
	const title = titleSource?.replace(/\s+/g, " ").trim().slice(0, 60);
	const savedMetadata = metadata ?? existing;

	const session: Session = {
		id: sessionId,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		messages,
		...definedMetadata(savedMetadata ?? {}),
		...(title ? { title } : {}),
		status: metadata?.status ?? existing?.status ?? "complete",
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

	const index = readSessionIndex(dir);
	const entries = readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((fileName) => metaForFile(dir, fileName, index))
		.filter((entry): entry is ResolvedSessionMeta => entry !== undefined);
	const nextIndex: SessionIndex = {
		version: INDEX_VERSION,
		sessions: Object.fromEntries(entries.map(({ fileId, indexEntry }) => [fileId, indexEntry])),
	};
	if (!index || JSON.stringify(index) !== JSON.stringify(nextIndex))
		writeSessionIndex(dir, nextIndex);
	return entries.map(({ meta }) => meta).sort((a, b) => b.updatedAt - a.updatedAt);
};

const readSessionFile = (path: string): Session | undefined => {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Session;
	} catch {
		return undefined;
	}
};

const fileStat = (path: string) => {
	try {
		return statSync(path, { bigint: true });
	} catch {
		return undefined;
	}
};

const metaFromFile = (path: string, fileName: string, updatedAtFallback: number): SessionMeta => {
	const session = readSessionFile(path);
	if (session)
		return {
			id: session.id,
			updatedAt: session.updatedAt,
			...definedMetadata(session),
		};
	return { id: fileName.slice(0, -".json".length), updatedAt: updatedAtFallback };
};

const metaForFile = (
	dir: string,
	fileName: string,
	index: SessionIndex | undefined,
): ResolvedSessionMeta | undefined => {
	const path = join(dir, fileName);
	const stats = fileStat(path);
	if (!stats) return undefined;
	const fileId = fileName.slice(0, -".json".length);
	const cached = index?.sessions[fileId];
	const size = stats.size.toString();
	const mtimeNs = stats.mtimeNs.toString();
	const meta =
		cached?.size === size && cached.mtimeNs === mtimeNs
			? cached.meta
			: metaFromFile(path, fileName, Number(stats.mtimeMs));
	return { fileId, meta, indexEntry: { size, mtimeNs, meta } };
};
