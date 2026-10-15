import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

const DEFAULT_MAX_VERSIONS_PER_FILE = 20;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

type FileHistoryLimits = {
	maxBytes?: number;
	maxVersionsPerFile?: number;
};

type FileHistoryRecord = {
	id: string;
	projectRoot: string;
	targetPath: string;
	sessionId?: string;
	hadOriginal: boolean;
	originalHash?: string;
	resultHash?: string;
	createdAt: number;
	status: "pending" | "complete";
};

type StoredRecord = {
	record: FileHistoryRecord;
	recordPath: string;
	directory: string;
	backupPath: string;
	backupBytes: number;
	backupExists: boolean;
};

export type FileChangeHandle = {
	id: string;
	recordPath: string;
	backupPath?: string;
};

export type UndoPreview = {
	action: "delete" | "restore";
	targetPath: string;
};

export type UndoOutcome = {
	action: "deleted" | "restored";
	targetPath: string;
};

export type FileHistory = {
	beginChange: (
		projectRoot: string,
		targetPath: string,
		sessionId?: string,
	) => Promise<FileChangeHandle>;
	completeChange: (change: FileChangeHandle) => Promise<void>;
	abortChange: (change: FileChangeHandle) => Promise<void>;
	previewUndo: (projectRoot: string, sessionId: string) => Promise<UndoPreview | undefined>;
	confirmUndo: (projectRoot: string, sessionId: string) => Promise<UndoOutcome>;
	cancelUndo: (projectRoot: string, sessionId: string) => Promise<void>;
};

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const isNotFound = (error: unknown): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const realPathIfPresent = async (path: string): Promise<string | undefined> => {
	try {
		return await realpath(path);
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
};

const canonicalizeMissingPath = async (absolutePath: string): Promise<string> => {
	const missingParts = [parse(absolutePath).base];
	let parentPath = dirname(absolutePath);
	while (true) {
		const existingParent = await realPathIfPresent(parentPath);
		if (existingParent) return join(existingParent, ...missingParts);
		const parent = parse(parentPath);
		if (parent.dir === parentPath) throw new Error(`No existing parent for ${absolutePath}`);
		missingParts.unshift(parent.base);
		parentPath = parent.dir;
	}
};

const canonicalizePath = async (path: string): Promise<string> => {
	const absolutePath = resolve(path);
	return (await realPathIfPresent(absolutePath)) ?? canonicalizeMissingPath(absolutePath);
};

const hashFile = (path: string): Promise<string> =>
	new Promise((resolveHash, reject) => {
		const digest = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => digest.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolveHash(digest.digest("hex")));
	});

const hashFileIfPresent = async (path: string): Promise<string | undefined> => {
	try {
		return await hashFile(path);
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
};

const readRecord = async (
	recordPath: string,
	directory: string,
): Promise<StoredRecord | undefined> => {
	try {
		const source = JSON.parse(await readFile(recordPath, "utf8")) as Partial<FileHistoryRecord>;
		if (
			typeof source.id !== "string" ||
			!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(source.id) ||
			typeof source.projectRoot !== "string" ||
			!isAbsolute(source.projectRoot) ||
			typeof source.targetPath !== "string" ||
			!isAbsolute(source.targetPath) ||
			(source.sessionId !== undefined && typeof source.sessionId !== "string") ||
			typeof source.hadOriginal !== "boolean" ||
			(source.hadOriginal &&
				(typeof source.originalHash !== "string" || !/^[\da-f]{64}$/i.test(source.originalHash))) ||
			typeof source.createdAt !== "number" ||
			(source.status !== "pending" && source.status !== "complete") ||
			(source.status === "complete" &&
				(typeof source.resultHash !== "string" || !/^[\da-f]{64}$/i.test(source.resultHash))) ||
			basename(recordPath) !== `${source.id}.json`
		)
			throw new Error(`Invalid file history record: ${recordPath}`);
		const backupPath = join(directory, `${source.id}.bak`);
		let backupBytes = 0;
		let backupExists = false;
		try {
			backupBytes = (await stat(backupPath)).size;
			backupExists = true;
		} catch (error) {
			if (!isNotFound(error)) throw error;
		}
		return {
			record: source as FileHistoryRecord,
			recordPath,
			directory,
			backupPath,
			backupBytes,
			backupExists,
		};
	} catch (error) {
		if (isNotFound(error)) return undefined;
		throw error;
	}
};

const listFileDirectories = async (projectDirectory: string): Promise<string[]> => {
	try {
		return (await readdir(projectDirectory, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(projectDirectory, entry.name));
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
};

const unlinkIfPresent = async (path: string): Promise<void> => {
	try {
		await unlink(path);
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
};

const removeOrphanBackups = async (directory: string, filenames: string[]): Promise<void> => {
	const recordNames = new Set(filenames.filter((name) => name.endsWith(".json")));
	for (const backup of filenames.filter((name) => name.endsWith(".bak"))) {
		const recordName = `${backup.slice(0, -4)}.json`;
		if (!recordNames.has(recordName)) await unlinkIfPresent(join(directory, backup));
	}
};

const listDirectoryRecords = async (
	projectDirectory: string,
	directory: string,
): Promise<StoredRecord[]> => {
	const filenames = await readdir(directory);
	const records = (
		await Promise.all(
			filenames
				.filter((name) => name.endsWith(".json"))
				.map((filename) => readRecord(join(directory, filename), directory)),
		)
	).filter((record): record is StoredRecord => record !== undefined);
	for (const record of records) {
		if (
			hash(record.record.projectRoot) !== basename(projectDirectory) ||
			hash(record.record.targetPath) !== basename(directory)
		)
			throw new Error(
				`File history record is stored under an unexpected path: ${record.recordPath}`,
			);
	}
	await removeOrphanBackups(directory, filenames);
	return records;
};

const listRecords = async (projectDirectory: string): Promise<StoredRecord[]> => {
	const directories = await listFileDirectories(projectDirectory);
	const records = await Promise.all(
		directories.map((directory) => listDirectoryRecords(projectDirectory, directory)),
	);
	return records.flat();
};

const removeRecord = async (stored: StoredRecord): Promise<void> => {
	await unlinkIfPresent(stored.recordPath);
	await unlinkIfPresent(stored.backupPath);
};

const writeRecord = async (recordPath: string, record: FileHistoryRecord): Promise<void> => {
	const temporaryPath = `${recordPath}.tmp`;
	await writeFile(temporaryPath, JSON.stringify(record), "utf8");
	await rename(temporaryPath, recordPath);
};

const orderOldestFirst = (records: StoredRecord[]): StoredRecord[] =>
	records.toSorted((left, right) => left.record.createdAt - right.record.createdAt);

const orderNewestFirst = (records: StoredRecord[]): StoredRecord[] =>
	records.toSorted((left, right) => right.record.createdAt - left.record.createdAt);

const pruneFileVersions = async (
	records: StoredRecord[],
	incomingDirectory: string,
	maxVersionsPerFile: number,
): Promise<StoredRecord[]> => {
	const directories = new Set(records.map((stored) => stored.directory));
	directories.add(incomingDirectory);
	let retained = records;
	for (const directory of directories) {
		const versions = orderOldestFirst(retained.filter((stored) => stored.directory === directory));
		const allowed = maxVersionsPerFile - (directory === incomingDirectory ? 1 : 0);
		for (const stored of versions.slice(0, Math.max(0, versions.length - allowed))) {
			await removeRecord(stored);
			retained = retained.filter((entry) => entry.recordPath !== stored.recordPath);
		}
	}
	return retained;
};

const pruneProjectBytes = async (
	records: StoredRecord[],
	incomingBytes: number,
	maxBytes: number,
): Promise<void> => {
	let totalBytes = records.reduce((total, stored) => total + stored.backupBytes, incomingBytes);
	for (const stored of orderOldestFirst(records)) {
		if (totalBytes <= maxBytes) break;
		if (stored.backupBytes === 0) continue;
		await removeRecord(stored);
		totalBytes -= stored.backupBytes;
	}
	if (totalBytes > maxBytes)
		throw new Error(`File history could not be pruned below the ${maxBytes}-byte limit`);
};

export const createFileHistory = (
	rootDirectory: string,
	limits: FileHistoryLimits = {},
): FileHistory => {
	const maxVersionsPerFile = limits.maxVersionsPerFile ?? DEFAULT_MAX_VERSIONS_PER_FILE;
	const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
	if (!Number.isSafeInteger(maxVersionsPerFile) || maxVersionsPerFile < 1)
		throw new Error("maxVersionsPerFile must be a positive integer");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
		throw new Error("maxBytes must be a non-negative integer");

	const pendingUndo = new Map<string, { id: string; fingerprint: string | undefined }>();
	let lastCreatedAt = 0;

	const projectDirectory = (projectRoot: string): Promise<string> =>
		realpath(projectRoot).then((canonicalRoot) => join(rootDirectory, hash(canonicalRoot)));
	const undoKey = (projectRoot: string, sessionId: string): string =>
		`${projectRoot}\n${sessionId}`;

	const prune = async (
		directory: string,
		incoming: { targetDirectory: string; backupBytes: number },
	): Promise<void> => {
		if (incoming.backupBytes > maxBytes)
			throw new Error(`File backup exceeds the ${maxBytes}-byte history limit`);
		const records = await pruneFileVersions(
			await listRecords(directory),
			incoming.targetDirectory,
			maxVersionsPerFile,
		);
		await pruneProjectBytes(records, incoming.backupBytes, maxBytes);
	};

	const nextCreatedAt = (): number => {
		lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
		return lastCreatedAt;
	};

	const captureOriginalHash = async (change: {
		targetPath: string;
		backupPath: string | undefined;
		expectedBytes: number;
	}): Promise<string | undefined> => {
		if (!change.backupPath) return undefined;
		await copyFile(change.targetPath, change.backupPath);
		const originalHash = await hashFile(change.backupPath);
		if (
			(await stat(change.targetPath)).size !== change.expectedBytes ||
			(await hashFile(change.targetPath)) !== originalHash
		)
			throw new Error(`File changed while creating its backup: ${change.targetPath}`);
		return originalHash;
	};

	const persistPendingRecord = async (change: {
		id: string;
		projectRoot: string;
		targetPath: string;
		sessionId: string | undefined;
		recordPath: string;
		backupPath: string | undefined;
		expectedBytes: number;
	}): Promise<void> => {
		try {
			const originalHash = await captureOriginalHash(change);
			const record: FileHistoryRecord = {
				id: change.id,
				projectRoot: change.projectRoot,
				targetPath: change.targetPath,
				...(change.sessionId ? { sessionId: change.sessionId } : {}),
				hadOriginal: Boolean(change.backupPath),
				...(originalHash ? { originalHash } : {}),
				createdAt: nextCreatedAt(),
				status: "pending",
			};
			await writeRecord(change.recordPath, record);
		} catch (error) {
			if (change.backupPath) await unlinkIfPresent(change.backupPath);
			throw error;
		}
	};

	const inspectUndoRecord = async (
		stored: StoredRecord,
		projectRoot: string,
		sessionId: string,
		key: string,
	): Promise<UndoPreview | undefined> => {
		if (stored.record.sessionId !== sessionId || stored.record.projectRoot !== projectRoot)
			return undefined;
		const target = await canonicalizePath(stored.record.targetPath);
		if (target !== stored.record.targetPath)
			throw new Error(`File path changed since it was written: ${stored.record.targetPath}`);
		const fingerprint = await hashFileIfPresent(target);
		const isOriginalState = stored.record.hadOriginal
			? fingerprint === stored.record.originalHash
			: fingerprint === undefined;
		if (isOriginalState) {
			await removeRecord(stored);
			return undefined;
		}
		pendingUndo.set(key, { id: stored.record.id, fingerprint });
		return {
			action: stored.record.hadOriginal ? "restore" : "delete",
			targetPath: stored.record.targetPath,
		};
	};

	const validateUndoState = async (
		stored: StoredRecord,
		fingerprint: string | undefined,
	): Promise<string | undefined> => {
		const target = await canonicalizePath(stored.record.targetPath);
		if (target !== stored.record.targetPath)
			throw new Error(`File path changed since it was written: ${stored.record.targetPath}`);
		const currentHash = await hashFileIfPresent(target);
		if (currentHash !== fingerprint)
			throw new Error(`File changed after the undo preview: ${stored.record.targetPath}`);
		if (stored.record.status === "complete" && currentHash !== stored.record.resultHash)
			throw new Error(`File changed since it was written: ${stored.record.targetPath}`);
		if (stored.record.hadOriginal && !stored.backupExists)
			throw new Error(`Original backup is missing for ${stored.record.targetPath}`);
		return currentHash;
	};

	const applyUndo = async (
		stored: StoredRecord,
		currentHash: string | undefined,
	): Promise<UndoOutcome> => {
		if (stored.record.hadOriginal) {
			await mkdir(dirname(stored.record.targetPath), { recursive: true });
			await copyFile(stored.backupPath, stored.record.targetPath);
		} else if (currentHash !== undefined) {
			await unlink(stored.record.targetPath);
		}
		return {
			action: stored.record.hadOriginal ? "restored" : "deleted",
			targetPath: stored.record.targetPath,
		};
	};

	return {
		beginChange: async (projectRoot, targetPath, sessionId) => {
			const canonicalRoot = await realpath(projectRoot);
			const canonicalTarget = await canonicalizePath(targetPath);
			const targetStat = await (async () => {
				try {
					return await stat(canonicalTarget);
				} catch (error) {
					if (isNotFound(error)) return undefined;
					throw error;
				}
			})();
			if (targetStat && !targetStat.isFile())
				throw new Error(`Cannot back up non-file target: ${targetPath}`);
			const backupBytes = targetStat?.size ?? 0;
			const directory = join(rootDirectory, hash(canonicalRoot));
			const targetDirectory = join(directory, hash(canonicalTarget));
			await mkdir(targetDirectory, { recursive: true });
			await prune(directory, { targetDirectory, backupBytes });

			const id = randomUUID();
			const recordPath = join(targetDirectory, `${id}.json`);
			const backupPath = targetStat ? join(targetDirectory, `${id}.bak`) : undefined;
			await persistPendingRecord({
				id,
				projectRoot: canonicalRoot,
				targetPath: canonicalTarget,
				sessionId,
				recordPath,
				backupPath,
				expectedBytes: backupBytes,
			});
			return { id, recordPath, ...(backupPath ? { backupPath } : {}) };
		},
		completeChange: async (change) => {
			const stored = await readRecord(change.recordPath, dirname(change.recordPath));
			if (!stored || stored.record.id !== change.id)
				throw new Error("File history change is no longer available");
			const resultHash = await hashFile(stored.record.targetPath);
			await writeRecord(change.recordPath, {
				...stored.record,
				resultHash,
				status: "complete",
			});
			if (stored.record.sessionId)
				pendingUndo.delete(undoKey(stored.record.projectRoot, stored.record.sessionId));
		},
		abortChange: async (change) => {
			const stored = await readRecord(change.recordPath, dirname(change.recordPath));
			if (stored) await removeRecord(stored);
		},
		previewUndo: async (projectRoot, sessionId) => {
			const canonicalRoot = await realpath(projectRoot);
			const directory = await projectDirectory(canonicalRoot);
			const key = undoKey(canonicalRoot, sessionId);
			const records = orderNewestFirst(await listRecords(directory));
			for (const stored of records) {
				const preview = await inspectUndoRecord(stored, canonicalRoot, sessionId, key);
				if (preview) return preview;
			}
			pendingUndo.delete(key);
			return undefined;
		},
		confirmUndo: async (projectRoot, sessionId) => {
			const canonicalRoot = await realpath(projectRoot);
			const key = undoKey(canonicalRoot, sessionId);
			const pending = pendingUndo.get(key);
			if (!pending) throw new Error("Preview an undo before confirming it");
			const directory = await projectDirectory(canonicalRoot);
			const stored = (await listRecords(directory)).find(
				(entry) =>
					entry.record.id === pending.id &&
					entry.record.projectRoot === canonicalRoot &&
					entry.record.sessionId === sessionId,
			);
			if (!stored) {
				pendingUndo.delete(key);
				throw new Error("The file change is no longer available to undo");
			}
			const currentHash = await validateUndoState(stored, pending.fingerprint);
			const outcome = await applyUndo(stored, currentHash);
			await removeRecord(stored);
			pendingUndo.delete(key);
			return outcome;
		},
		cancelUndo: async (projectRoot, sessionId) => {
			pendingUndo.delete(undoKey(await realpath(projectRoot), sessionId));
		},
	};
};

export const defaultFileHistory = createFileHistory(join(homedir(), ".anvil", "file-history"));

export const writeWithFileHistory = async (
	history: FileHistory,
	projectRoot: string,
	sessionId: string | undefined,
	targetPath: string,
	write: () => Promise<void>,
): Promise<void> => {
	const change = await history.beginChange(projectRoot, targetPath, sessionId);
	try {
		await write();
	} catch (error) {
		await history.abortChange(change);
		throw error;
	}
	await history.completeChange(change);
};
