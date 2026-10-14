import type { AgentEvent } from "../agent/loop.js";

/** Consume agent events until a handler explicitly requests a short circuit. */
export const consumeAgentEvents = async (
	events: AsyncGenerator<AgentEvent>,
	handleEvent: (event: AgentEvent) => Promise<number | undefined> | number | undefined,
): Promise<number | undefined> => {
	for await (const event of events) {
		const result = await handleEvent(event);
		if (result !== undefined) return result;
	}
	return undefined;
};
