import { createInterface } from "node:readline";

process.stderr.write("fake MCP server started\n");

const tools = ["echo", "fail", "hang", "crash", "environment"].map((name) => ({
	name,
	description: `${name} fixture tool`,
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
}));

const respond = (id, result) =>
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.method === "initialize") {
		if (process.argv.includes("--silent")) return;
		respond(request.id, {
			protocolVersion: request.params.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "fake-mcp-server", version: "1.0.0" },
		});
		return;
	}
	if (request.method === "tools/list") {
		respond(request.id, { tools });
		return;
	}
	if (request.method !== "tools/call") return;

	switch (request.params.name) {
		case "echo":
			respond(request.id, {
				content: [{ type: "text", text: request.params.arguments.text ?? "" }],
			});
			break;
		case "fail":
			respond(request.id, {
				isError: true,
				content: [{ type: "text", text: "fixture failure" }],
			});
			break;
		case "hang":
			break;
		case "crash":
			process.exit(1);
			break;
		case "environment":
			respond(request.id, {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							configured: process.env.ANVIL_MCP_TEST_VALUE,
							secret: process.env.ANVIL_MCP_TEST_SECRET,
						}),
					},
				],
			});
			break;
	}
});
