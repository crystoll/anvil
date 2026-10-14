import { ok, type Result } from "neverthrow";
import type { Message, TokenUsage } from "../provider/types.js";
import { saveSession } from "./session.js";

/** Keeps one conversation in one session file, however often it is saved. */
export type SessionWriter = {
	id: () => string | undefined;
	/** Usage is kept for the saves that follow, so saving mid-turn doesn't drop it from the file. */
	save: (usage?: TokenUsage) => Result<string | undefined, string>;
	startNew: () => void;
	resume: (id: string) => void;
};

const hasConversation = (messages: readonly Message[]): boolean =>
	messages.some((message) => message.role !== "system");

/** Creates the session file on the first save that has something worth keeping. */
export const createSessionWriter = (
	dir: string,
	messages: () => readonly Message[],
	initialId?: string,
): SessionWriter => {
	let currentId = initialId;
	let lastUsage: TokenUsage | undefined;

	const switchTo = (id: string | undefined) => {
		currentId = id;
		lastUsage = undefined;
	};

	const save = (usage?: TokenUsage): Result<string | undefined, string> => {
		if (usage) lastUsage = usage;
		const conversation = messages();
		if (!hasConversation(conversation)) return ok(undefined);
		return saveSession(dir, [...conversation], currentId, lastUsage).andTee((id) => {
			currentId = id;
		});
	};

	return {
		id: () => currentId,
		save,
		startNew: () => switchTo(undefined),
		resume: switchTo,
	};
};
