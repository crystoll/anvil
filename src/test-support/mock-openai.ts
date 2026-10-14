import {
	type MockStreamServer,
	type StreamFaultScript,
	startMockStreamServer,
} from "./mock-stream-server.js";

/** Start a local OpenAI-compatible server for socket-level streaming tests. */
export const startMockOpenAI = (script: StreamFaultScript): Promise<MockStreamServer> =>
	startMockStreamServer("/v1/chat/completions", script, {
		contentType: "text/event-stream",
		frame: (frame) => `data: ${JSON.stringify(frame)}\n\n`,
		error: (message) => `data: ${JSON.stringify({ error: { message } })}\n\n`,
		end: "data: [DONE]\n\n",
	});
