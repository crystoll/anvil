import type { Message } from "./types.js";

/** Make partial assistant responses explicit when reusing them as provider context. */
export const requestMessageContent = (message: Message): string => {
	if (message.status === "interrupted") return `${message.content}\n[response interrupted]`;
	if (message.status === "error") return `${message.content}\n[response ended with an error]`;
	return message.content;
};
