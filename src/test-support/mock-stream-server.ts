import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type StreamFaultScript = {
	frames?: unknown[];
	delayMs?: number;
	stallAfter?: number;
	dropAfter?: number;
	errorLine?: string;
	rawLine?: string;
	httpStatus?: number;
};

export type MockStreamServer = {
	endpoint: string;
	requests: unknown[];
	setScript: (next: StreamFaultScript) => void;
	clientDisconnected: Promise<void>;
	close: () => Promise<void>;
};

type StreamFormat = {
	contentType: string;
	frame: (frame: unknown) => string;
	error: (message: string) => string;
	end: string;
};

type MockStreamServerOptions = { healthPath?: string };

export const startMockStreamServer = async (
	path: string,
	script: StreamFaultScript,
	format: StreamFormat,
	options: MockStreamServerOptions = {},
): Promise<MockStreamServer> => {
	const requests: unknown[] = [];
	let currentScript = script;
	let disconnectClient: () => void = () => undefined;
	let disconnected = false;
	const clientDisconnected = new Promise<void>((resolve) => {
		disconnectClient = resolve;
	});

	const server = createServer(async (request, response) => {
		if (request.method === "GET" && request.url === options.healthPath) {
			response
				.writeHead(200, { "Content-Type": "application/json" })
				.end(JSON.stringify({ models: [] }));
			return;
		}
		if (request.url !== path) {
			response.writeHead(404).end();
			return;
		}
		requests.push(await readRequest(request));
		await writeScript(response, currentScript, format);
	});

	server.on("request", (_request, response) => {
		response.on("close", () => {
			if (!response.writableEnded && !disconnected) {
				disconnected = true;
				disconnectClient();
			}
		});
	});

	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;

	return {
		endpoint: `http://127.0.0.1:${address.port}`,
		requests,
		setScript: (next) => {
			currentScript = next;
		},
		clientDisconnected,
		close: () => closeServer(server),
	};
};

const readRequest = async (request: IncomingMessage): Promise<unknown> => {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const writeScript = async (
	response: ServerResponse,
	script: StreamFaultScript,
	format: StreamFormat,
): Promise<void> => {
	if (script.httpStatus) {
		response.writeHead(script.httpStatus).end();
		return;
	}

	response.writeHead(200, { "Content-Type": format.contentType });
	response.flushHeaders();
	const frames = script.frames ?? [];
	for (const [index, frame] of frames.entries()) {
		if (index === script.dropAfter) {
			response.destroy();
			return;
		}
		if (index === script.stallAfter) return;
		if (script.delayMs) await delay(script.delayMs);
		response.write(format.frame(frame));
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	if (script.dropAfter === frames.length) {
		response.destroy();
		return;
	}
	if (script.stallAfter === frames.length) return;
	if (script.rawLine !== undefined) response.write(`${script.rawLine}\n`);
	if (script.errorLine !== undefined) response.write(format.error(script.errorLine));
	response.end(format.end);
};

const delay = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

const closeServer = (server: Server): Promise<void> =>
	new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
