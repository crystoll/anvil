// Minimal Content-Length-framed LSP server for client tests.
// Usage: node fake-lsp-server.mjs <mode> [pidFile]
//   respond: answers every request, exits on the "exit" notification
//   silent:  reads requests but never answers
//   exit:    exits with code 3 on the first message
//   noisy:   floods stderr with blocking writes first, then behaves like respond
import { writeFileSync, writeSync } from "node:fs";

const [mode = "respond", pidFile] = process.argv.slice(2);
if (pidFile) writeFileSync(pidFile, String(process.pid));
if (mode === "noisy") writeSync(2, Buffer.alloc(4 << 20, "x"));

const reply = (id, result) => {
	const body = JSON.stringify({ jsonrpc: "2.0", id, result });
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

const handle = (message) => {
	if (mode === "silent") return;
	if (mode === "exit") process.exit(3);
	if (message.method === "exit") process.exit(0);
	if (message.id === undefined) return;
	reply(message.id, message.method === "initialize" ? { capabilities: {} } : null);
};

let buffer = "";

const takeMessage = () => {
	const headerEnd = buffer.indexOf("\r\n\r\n");
	if (headerEnd === -1) return undefined;
	const length = Number(/Content-Length: (\d+)/i.exec(buffer.slice(0, headerEnd))?.[1] ?? 0);
	const bodyStart = headerEnd + 4;
	if (buffer.length < bodyStart + length) return undefined;
	const body = buffer.slice(bodyStart, bodyStart + length);
	buffer = buffer.slice(bodyStart + length);
	return JSON.parse(body);
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (let message = takeMessage(); message; message = takeMessage()) handle(message);
});
