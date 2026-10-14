import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../agent/loop.js";
import { consumeAgentEvents } from "./consume-events.js";

describe("consumeAgentEvents", () => {
	it("continues through errors so overflow recovery events are handled", async () => {
		const handled: string[] = [];
		async function* events(): AsyncGenerator<AgentEvent> {
			yield { kind: "error", message: "context length exceeded", status: "error" };
			yield { kind: "overflow" };
			yield { kind: "compacting" };
			yield { kind: "compacted", before: 20000, after: 5000 };
			yield { kind: "content", text: "Recovered" };
		}

		await consumeAgentEvents(events(), (event) => {
			handled.push(event.kind);
			return undefined;
		});

		expect(handled).toEqual(["error", "overflow", "compacting", "compacted", "content"]);
	});

	it("stops when an event handler requests a short circuit", async () => {
		const handled: string[] = [];
		async function* events(): AsyncGenerator<AgentEvent> {
			yield { kind: "error", message: "temporary", status: "error" };
			yield { kind: "content", text: "stop here" };
			yield { kind: "content", text: "not reached" };
		}

		const result = await consumeAgentEvents(events(), (event) => {
			handled.push(event.kind);
			return event.kind === "content" ? 0 : undefined;
		});

		expect(result).toBe(0);
		expect(handled).toEqual(["error", "content"]);
	});
});
