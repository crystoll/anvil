import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startMockOllama } from "./test-support/mock-ollama.js";
import type { MockStreamServer, StreamFaultScript } from "./test-support/mock-stream-server.js";

const testDirectories: string[] = [];
const servers: MockStreamServer[] = [];
const children: ReturnType<typeof spawn>[] = [];

const waitForExit = (child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number> =>
	new Promise((resolveExit, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`CLI did not exit within ${timeoutMs}ms`));
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolveExit(code ?? -1);
		});
	});

const waitForOutput = (getOutput: () => string, text: string, occurrences = 1): Promise<void> =>
	new Promise((resolveOutput, reject) => {
		const timeout = setTimeout(() => {
			clearInterval(checkInterval);
			reject(
				new Error(`CLI output did not include "${text}" ${occurrences} times: ${getOutput()}`),
			);
		}, 10_000);
		const check = () => {
			const count = getOutput().split(text).length - 1;
			if (count < occurrences) return;
			clearTimeout(timeout);
			clearInterval(checkInterval);
			resolveOutput();
		};
		const checkInterval = setInterval(check, 10);
		check();
	});

const waitForRequests = async (mock: MockStreamServer, count: number): Promise<void> => {
	const deadline = Date.now() + 10_000;
	while (mock.requests.length < count) {
		if (Date.now() >= deadline)
			throw new Error(`Mock server received fewer than ${count} requests`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 5));
	}
};

const runOneShot = async (script: StreamFaultScript, args: string[]) => {
	const mock = await startMockOllama(script);
	servers.push(mock);
	const directory = mkdtempSync(join(tmpdir(), "anvil-cli-one-shot-"));
	testDirectories.push(directory);
	const homeDir = join(directory, "home");
	const projectDir = join(directory, "project");
	mkdirSync(join(homeDir, ".anvil"), { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(homeDir, ".anvil", "config.yaml"),
		`default_provider: ollama
default_model: test-model
providers:
  ollama:
    endpoint: ${mock.endpoint}
connect_timeout: 2
stream_timeout: 5
max_rounds: 3
show_tokens: false
`,
	);

	const mainPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/main.js");
	const child = spawn(process.execPath, [mainPath, ...args], {
		cwd: projectDir,
		env: { ...process.env, HOME: homeDir },
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.push(child);
	let output = "";
	let errors = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		output += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		errors += chunk;
	});
	const exited = waitForExit(child, 15_000);
	child.stdin.end();
	await waitForRequests(mock, 1);
	mock.setScript({
		frames: [
			{
				message: { role: "assistant", content: "Finished" },
				done: true,
				prompt_eval_count: 12,
				eval_count: 1,
			},
		],
	});

	return { code: await exited, errors, output, projectDir, requests: mock.requests };
};

const writeFileFrames = (): StreamFaultScript => ({
	delayMs: 100,
	frames: [
		{
			message: {
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "write-1",
						function: {
							name: "write_file",
							arguments: { path: "created.txt", content: "created" },
						},
					},
				],
			},
			done: true,
			prompt_eval_count: 10,
			eval_count: 2,
		},
	],
});

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	}
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const directory of testDirectories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("readline CLI", () => {
	it("saves interrupted input and resumes it from another directory", async () => {
		const mock = await startMockOllama({ stallAfter: 0 });
		servers.push(mock);
		const directory = mkdtempSync(join(tmpdir(), "anvil-cli-resume-"));
		testDirectories.push(directory);
		const homeDir = join(directory, "home");
		const projectDir = join(directory, "project");
		const resumeDir = join(directory, "resume");
		mkdirSync(join(homeDir, ".anvil"), { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(resumeDir, { recursive: true });
		writeFileSync(
			join(homeDir, ".anvil", "config.yaml"),
			`default_provider: ollama
default_model: test-model
providers:
  ollama:
    endpoint: ${mock.endpoint}
connect_timeout: 2
stream_timeout: 5
max_rounds: 3
show_tokens: false
`,
		);

		const mainPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/main.js");
		const env = { ...process.env, HOME: homeDir };
		const interrupted = spawn(process.execPath, [mainPath], {
			cwd: projectDir,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(interrupted);
		const interruptedExit = waitForExit(interrupted, 15_000);
		interrupted.stdin.write("first request\n");
		await waitForRequests(mock, 1);
		interrupted.kill("SIGTERM");

		expect(await interruptedExit).toBe(143);
		await mock.clientDisconnected;
		const historyDir = join(homeDir, ".anvil", "history");
		const sessionFile = readdirSync(historyDir).find((file) => file.endsWith(".json"));
		if (!sessionFile) throw new Error("Interrupted session was not saved");
		const session = JSON.parse(readFileSync(join(historyDir, sessionFile), "utf8")) as {
			id: string;
			status: string;
			messages: { role: string; content?: string }[];
		};
		expect(session.status).toBe("interrupted");
		expect(session.messages).toContainEqual(
			expect.objectContaining({ role: "user", content: "first request" }),
		);

		mock.setScript({
			frames: [
				{
					message: { role: "assistant", content: "Resumed" },
					done: true,
					prompt_eval_count: 12,
					eval_count: 1,
				},
			],
		});
		const resumed = spawn(process.execPath, [mainPath, "--resume", session.id], {
			cwd: resumeDir,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(resumed);
		let errors = "";
		resumed.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			errors += chunk;
		});
		const resumedExit = waitForExit(resumed, 15_000);
		resumed.stdin.end("continue\n/quit\n");

		expect(await resumedExit, errors).toBe(0);
		expect(mock.requests).toHaveLength(2);
		expect(mock.requests[1]).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({ role: "user", content: "first request" }),
				expect.objectContaining({ role: "user", content: "continue" }),
			]),
		});
	}, 30_000);

	it("processes queued prompts and drains piped input through /quit at EOF", async () => {
		const mock = await startMockOllama({
			frames: [
				{ message: { role: "assistant", content: "response" }, done: false },
				{
					message: { role: "assistant", content: "" },
					done: true,
					prompt_eval_count: 10,
					eval_count: 2,
				},
			],
		});
		servers.push(mock);
		const directory = mkdtempSync(join(tmpdir(), "anvil-cli-e2e-"));
		testDirectories.push(directory);
		const homeDir = join(directory, "home");
		const projectDir = join(directory, "project");
		mkdirSync(join(homeDir, ".anvil"), { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(homeDir, ".anvil", "config.yaml"),
			`default_provider: ollama
default_model: test-model
providers:
  ollama:
    endpoint: ${mock.endpoint}
connect_timeout: 2
stream_timeout: 5
max_rounds: 3
show_tokens: false
`,
		);

		const mainPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/main.js");
		const child = spawn(process.execPath, [mainPath], {
			cwd: projectDir,
			env: { ...process.env, HOME: homeDir },
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(child);
		let output = "";
		let errors = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			errors += chunk;
		});
		const exited = waitForExit(child, 15_000);
		child.stdin.end("first prompt\nsecond prompt\n/quit\n");

		const code = await exited;
		expect(code, errors).toBe(0);
		expect(mock.requests).toHaveLength(2);
		expect(mock.requests[0]).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({ role: "user", content: "first prompt" }),
			]),
		});
		expect(mock.requests[1]).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({ role: "user", content: "second prompt" }),
			]),
		});
		expect(output).toContain("Type /quit to exit");
	}, 30_000);

	it("approves every queued tool call and previews edit search and replacement text", async () => {
		const mock = await startMockOllama({
			frames: [
				{
					message: {
						role: "assistant",
						content: "",
						tool_calls: [
							{
								id: "edit-1",
								function: {
									name: "edit_file",
									arguments: { path: "example.txt", search: "old", replace: "first" },
								},
							},
							{
								id: "edit-2",
								function: {
									name: "edit_file",
									arguments: { path: "example.txt", search: "first", replace: "second" },
								},
							},
						],
					},
					done: true,
					prompt_eval_count: 10,
					eval_count: 2,
				},
			],
		});
		servers.push(mock);
		const directory = mkdtempSync(join(tmpdir(), "anvil-cli-approval-e2e-"));
		testDirectories.push(directory);
		const homeDir = join(directory, "home");
		const projectDir = join(directory, "project");
		mkdirSync(join(homeDir, ".anvil"), { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "example.txt"), "old");
		writeFileSync(
			join(homeDir, ".anvil", "config.yaml"),
			`default_provider: ollama
default_model: test-model
providers:
  ollama:
    endpoint: ${mock.endpoint}
connect_timeout: 2
stream_timeout: 5
max_rounds: 3
show_tokens: false
`,
		);

		const mainPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/main.js");
		const child = spawn(process.execPath, [mainPath], {
			cwd: projectDir,
			env: { ...process.env, HOME: homeDir },
			stdio: ["pipe", "pipe", "pipe"],
		});
		children.push(child);
		let output = "";
		let errors = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			output += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			errors += chunk;
		});
		const exited = waitForExit(child, 15_000);
		child.stdin.write("edit the file\n");

		await waitForOutput(() => output, "approve? [y/a/n/cancel]: ");
		expect(output).toContain("- old");
		expect(output).toContain("+ first");
		child.stdin.write("y\n");
		await waitForOutput(() => output, "approve? [y/a/n/cancel]: ", 2);
		expect(output).toContain("- first");
		expect(output).toContain("+ second");
		mock.setScript({
			frames: [
				{
					message: { role: "assistant", content: "Finished" },
					done: true,
					prompt_eval_count: 12,
					eval_count: 1,
				},
			],
		});
		child.stdin.write("y\n");
		await waitForOutput(() => `${mock.requests.length}`, "2");
		child.stdin.end("/quit\n");

		const code = await exited;
		expect(code, errors).toBe(0);
		expect(mock.requests).toHaveLength(2);
		expect(readFileSync(join(projectDir, "example.txt"), "utf8")).toBe("second");
	}, 30_000);

	it("skips approval-requiring tools in one-shot mode unless --yes is set", async () => {
		const result = await runOneShot(writeFileFrames(), ["-c", "create the file"]);

		expect(result.code, result.errors).toBe(0);
		expect(existsSync(join(result.projectDir, "created.txt"))).toBe(false);
		expect(result.errors).toContain("Skipped write_file");
		expect(result.requests).toHaveLength(2);
		expect(result.requests[1]).toMatchObject({
			messages: expect.arrayContaining([
				expect.objectContaining({
					role: "tool",
					content: expect.stringContaining("approval is required"),
				}),
			]),
		});
	}, 30_000);

	it("runs approval-requiring tools in one-shot mode with --yes", async () => {
		const result = await runOneShot(writeFileFrames(), ["-c", "create the file", "--yes"]);

		expect(result.code, result.errors).toBe(0);
		expect(readFileSync(join(result.projectDir, "created.txt"), "utf8")).toBe("created");
		expect(result.errors).not.toContain("Skipped write_file");
		expect(result.requests).toHaveLength(2);
	}, 30_000);
});
