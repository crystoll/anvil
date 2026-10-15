import { ok, type Result } from "neverthrow";
import type { Message, TokenUsage } from "../provider/types.js";
import type { SessionMetadata, SessionStatus } from "./session.js";
import { saveSession } from "./session.js";

/** Keeps one conversation in one session file, however often it is saved. */
export type SessionWriter = {
	id: () => string | undefined;
	/** Usage is kept for the saves that follow, so saving mid-turn doesn't drop it from the file. */
	save: (usage?: TokenUsage) => Result<string | undefined, string>;
	setStatus: (status: SessionStatus) => void;
	startNew: () => void;
	resume: (id: string) => void;
	resumeNotice?: string;
};

export type SessionWriterOptions = {
	getMetadata?: () => SessionMetadata;
	resumeNotice?: string;
};

const hasConversation = (messages: readonly Message[]): boolean =>
	messages.some((message) => message.role !== "system");

/** Creates the session file on the first save that has something worth keeping. */
export const createSessionWriter = (
	dir: string,
	messages: () => readonly Message[],
	initialId?: string,
	options: SessionWriterOptions = {},
): SessionWriter => {
	let currentId = initialId;
	let lastUsage: TokenUsage | undefined;
	let currentStatus: SessionStatus | undefined;

	const switchTo = (id: string | undefined) => {
		currentId = id;
		lastUsage = undefined;
		currentStatus = undefined;
	};

	const save = (usage?: TokenUsage): Result<string | undefined, string> => {
		if (usage) lastUsage = usage;
		const conversation = messages();
		if (!hasConversation(conversation)) return ok(undefined);
		const latestMetadata = options.getMetadata?.();
		const metadata =
			currentStatus && latestMetadata
				? { ...latestMetadata, status: currentStatus }
				: currentStatus
					? { status: currentStatus }
					: latestMetadata;
		return saveSession(dir, [...conversation], currentId, lastUsage, metadata).andTee((id) => {
			currentId = id;
		});
	};

	return {
		id: () => currentId,
		save,
		setStatus: (status) => {
			currentStatus = status;
		},
		startNew: () => switchTo(undefined),
		resume: switchTo,
		...(options.resumeNotice ? { resumeNotice: options.resumeNotice } : {}),
	};
};
