import {
	type MockStreamServer,
	type StreamFaultScript,
	startMockStreamServer,
} from "./mock-stream-server.js";

/** Start a local Ollama-compatible server for socket-level streaming tests. */
export const startMockOllama = (script: StreamFaultScript): Promise<MockStreamServer> =>
	startMockStreamServer(
		"/api/chat",
		script,
		{
			contentType: "application/x-ndjson",
			frame: (frame) => `${JSON.stringify(frame)}\n`,
			error: (message) => `${JSON.stringify({ error: message })}\n`,
			end: "",
		},
		{ healthPath: "/api/tags" },
	);
