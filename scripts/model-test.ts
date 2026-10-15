#!/usr/bin/env tsx
/**
 * Model testing harness — runs repeatable tasks across all available models.
 * Usage: pnpm exec tsx scripts/model-test.ts [model1 model2 ...]
 * If no models specified, tests all available Ollama models.
 */

import { execSync, spawnSync } from "node:child_process";

type TestCase = {
	name: string;
	category: "qa" | "tool_use";
	prompt: string;
	/** Check if output indicates success */
	check: (result: { output: string; toolCalls: string[] }) => boolean;
	timeoutSec: number;
};

type Result = {
	model: string;
	test: string;
	category: string;
	success: boolean;
	timeSec: number;
	tokens: { prompt: number; completion: number } | undefined;
	finishReason: string | undefined;
	toolCalls: string[];
};

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

const TEST_CASES: TestCase[] = [
	{
		name: "simple_qa",
		category: "qa",
		prompt: "What is 2+2? Reply with just the number.",
		check: ({ output }) => output.includes("4"),
		timeoutSec: 60,
	},
	{
		name: "tool_list_dir",
		category: "tool_use",
		prompt: "List the files in the src/ directory",
		check: ({ toolCalls }) => toolCalls.includes("list_dir"),
		timeoutSec: 60,
	},
	{
		name: "tool_chain_search_read",
		category: "tool_use",
		prompt:
			"Search src/ for createSessionController, read the matching file, and summarize its responsibility in one sentence",
		check: ({ toolCalls }) => toolCalls.includes("search") && toolCalls.includes("read_file"),
		timeoutSec: 120,
	},
];

const getModels = (): string[] => {
	const args = process.argv.slice(2);
	if (args.length > 0) return args;
	try {
		const raw = execSync("curl -s http://localhost:11434/api/tags", { encoding: "utf-8" });
		const data = JSON.parse(raw);
		return (data.models as Array<{ name: string }>).map((m) => m.name);
	} catch {
		console.error("Failed to list Ollama models");
		process.exit(1);
	}
};

const parseTokens = (
	output: string,
): { tokens?: { prompt: number; completion: number }; finishReason?: string } => {
	const tokMatch = output.match(/\[(\d+)→(\d+) tok(?: (\w+))?\]/g);
	if (!tokMatch) return {};
	let totalPrompt = 0;
	let totalCompletion = 0;
	let finishReason: string | undefined;
	for (const m of tokMatch) {
		const parts = m.match(/\[(\d+)→(\d+) tok(?: (\w+))?\]/);
		if (parts) {
			totalPrompt = Math.max(totalPrompt, Number(parts[1]));
			totalCompletion += Number(parts[2]);
			if (parts[3]) finishReason = parts[3];
		}
	}
	return { tokens: { prompt: totalPrompt, completion: totalCompletion }, finishReason };
};

const runTest = (model: string, test: TestCase): Result => {
	const start = Date.now();
	const toolCalls: string[] = [];

	const execution = spawnSync(
		process.execPath,
		["--import", "tsx", "src/cli.ts", "--debug", "--model", model, "-c", test.prompt],
		{
			encoding: "utf-8",
			cwd: process.cwd(),
			timeout: test.timeoutSec * 1000,
			maxBuffer: 10 * 1024 * 1024,
		},
	);
	const output = [
		execution.stdout ?? "",
		execution.error?.code === "ETIMEDOUT" ? "\n[TIMEOUT]" : "",
		execution.error && execution.error.code !== "ETIMEDOUT"
			? `\n[ERROR: ${execution.error.message}]`
			: "",
	].join("");
	const normalizedOutput = output.replace(ANSI_ESCAPE_PATTERN, "");

	const timeSec = Math.round((Date.now() - start) / 1000);
	const { tokens, finishReason } = parseTokens(normalizedOutput);

	for (const m of normalizedOutput.matchAll(/↳ (\S+) done/g)) toolCalls.push(m[1] ?? "");

	return {
		model,
		test: test.name,
		category: test.category,
		success: execution.status === 0 && test.check({ output: normalizedOutput, toolCalls }),
		timeSec,
		tokens,
		finishReason,
		toolCalls,
	};
};

const printSummary = (results: Result[], models: string[]) => {
	console.log("\n## Summary\n");
	console.log("| Model | Pass Rate | Avg Time | Total Tokens |");
	console.log("|-------|-----------|----------|--------------|");
	for (const model of models) {
		const mrs = results.filter((r) => r.model === model);
		const passed = mrs.filter((r) => r.success).length;
		const avgTime = Math.round(mrs.reduce((a, r) => a + r.timeSec, 0) / mrs.length);
		const totalTok = mrs.reduce((a, r) => a + (r.tokens?.completion ?? 0), 0);
		console.log(`| ${model} | ${passed}/${mrs.length} | ${avgTime}s | ${totalTok} |`);
	}
};

const formatRow = (r: Result) => {
	const pass = r.success ? "✅" : "❌";
	const tok = r.tokens ? `${r.tokens.prompt}→${r.tokens.completion}` : "—";
	const tools = r.toolCalls.length > 0 ? r.toolCalls.join(", ") : "—";
	return `| ${r.model} | ${r.test} | ${pass} | ${r.timeSec}s | ${tok} | ${r.finishReason ?? "—"} | ${tools} |`;
};

const formatTable = (results: Result[]) => {
	const models = [...new Set(results.map((r) => r.model))];
	const tests = [...new Set(results.map((r) => r.test))];

	console.log("\n## Results\n");
	console.log("| Model | Test | Pass | Time | Tokens (p→c) | Finish | Tools |");
	console.log("|-------|------|------|------|--------------|--------|-------|");

	for (const model of models) {
		for (const test of tests) {
			const r = results.find((x) => x.model === model && x.test === test);
			if (r) console.log(formatRow(r));
		}
	}

	printSummary(results, models);
};

// Main
const models = getModels();
console.log(`Testing ${models.length} model(s): ${models.join(", ")}`);
console.log(`Running ${TEST_CASES.length} test cases each\n`);

const results: Result[] = [];

for (const model of models) {
	console.log(`\n--- ${model} ---`);
	for (const test of TEST_CASES) {
		process.stdout.write(`  ${test.name}... `);
		const result = runTest(model, test);
		results.push(result);
		console.log(`${result.success ? "✅" : "❌"} (${result.timeSec}s)`);
	}
}

formatTable(results);
if (results.some((result) => !result.success)) process.exitCode = 1;
