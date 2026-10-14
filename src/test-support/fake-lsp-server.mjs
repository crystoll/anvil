// Minimal Content-Length-framed LSP server for client tests.
// Usage: node fake-lsp-server.mjs <mode> [pidFile]
//   respond: answers every request, exits on the "exit" notification
//   silent:  reads requests but never answers
//   exit:    exits with code 3 on the first message
//   noisy:   floods stderr with blocking writes first, then behaves like respond
//   unicode: answers hover with "→" text
//   unicode-split: same, but the reply is split mid-character across two writes
//   asks:    asks for workspace/configuration with the initialize request's id before
//            answering it, then answers hover with the client's reply
import { writeFileSync, writeSync } from "node:fs";

const [mode = "respond", pidFile] = process.argv.slice(2);
if (pidFile) writeFileSync(pidFile, String(process.pid));
if (mode === "noisy") writeSync(2, Buffer.alloc(4 << 20, "x"));

const frame = (message) => {
	const body = JSON.stringify({ jsonrpc: "2.0", ...message });
	return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

const send = (message) => process.stdout.write(frame(message));
const reply = (id, result) => send({ id, result });

const hover = { contents: "hello(): string → greets" };

const replyInTwoWrites = (id, result, splitInside) => {
	const bytes = frame({ id, result });
	const cut = bytes.indexOf(splitInside) + 1;
	process.stdout.write(bytes.subarray(0, cut));
	setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50);
};

let initializeId;
let configuration;

const answerAsking = (message) => {
	if (message.method === "initialize") {
		initializeId = message.id;
		const items = [{ section: "typescript" }, { section: "javascript" }];
		send({ id: message.id, method: "workspace/configuration", params: { items } });
	} else if (message.method === undefined) {
		configuration = message.result;
		reply(initializeId, { capabilities: {} });
	} else if (message.method !== "textDocument/hover") {
		reply(message.id, null);
	} else if (configuration !== undefined) {
		reply(message.id, { contents: JSON.stringify(configuration) });
	}
};

const answer = (message) => {
	if (mode === "asks") return answerAsking(message);
	if (message.method === "textDocument/hover" && mode === "unicode") {
		return reply(message.id, hover);
	}
	if (message.method === "textDocument/hover" && mode === "unicode-split") {
		return replyInTwoWrites(message.id, hover, "→");
	}
	reply(message.id, message.method === "initialize" ? { capabilities: {} } : null);
};

const handle = (message) => {
	if (mode === "silent") return;
	if (mode === "exit") process.exit(3);
	if (message.method === "exit") process.exit(0);
	if (message.id === undefined) return;
	answer(message);
};

let buffer = Buffer.alloc(0);

const takeMessage = () => {
	const headerEnd = buffer.indexOf("\r\n\r\n");
	if (headerEnd === -1) return undefined;
	const header = buffer.subarray(0, headerEnd).toString();
	const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1] ?? 0);
	const bodyStart = headerEnd + 4;
	if (buffer.length < bodyStart + length) return undefined;
	const body = buffer.subarray(bodyStart, bodyStart + length).toString();
	buffer = buffer.subarray(bodyStart + length);
	return JSON.parse(body);
};

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (let message = takeMessage(); message; message = takeMessage()) handle(message);
});
