#!/usr/bin/env tsx
/**
 * Model testing harness — runs repeatable tasks across all available models.
 * Usage: tsx scripts/model-test.ts [model1 model2 ...]
 * If no models specified, tests all available Ollama models.
 */

import { execSync } from "node:child_process";

type TestCase = {
	name: string;
	category: "qa" | "tool_chain" | "lsp";
	prompt: string;
	/** Check if output indicates success */
	check: (output: string) => boolean;
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

const TEST_CASES: TestCase[] = [
	{
		name: "simple_qa",
		category: "qa",
		prompt: "What is 2+2? Reply with just the number.",
		check: (out) => out.includes("4"),
		timeoutSec: 60,
	},
	{
		name: "tool_list_dir",
		category: "tool_chain",
		prompt: "List the files in the src/ directory",
		check: (out) => out.includes("list_dir") || out.includes("cli.ts"),
		timeoutSec: 60,
	},
	{
		name: "tool_chain_search_read",
		category: "tool_chain",
		prompt:
			"Search my obsidian vault for 'bard build', read the first result, and summarize it in one sentence",
		check: (out) => out.includes("obsidian.search") && out.includes("obsidian.read"),
		timeoutSec: 180,
	},
	{
		name: "lsp_write_and_fix",
		category: "lsp",
		prompt:
			"Write a file /tmp/model-test.ts with content 'const x: number = \"hello\";' then fix any type errors the LSP reports",
		check: (out) =>
			out.includes("write_file") && (out.includes("edit_file") || out.includes("write_file done")),
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
	let output = "";
	const toolCalls: string[] = [];

	try {
		output = execSync(
			`timeout ${test.timeoutSec} tsx src/cli.ts --debug --model "${model}" -c "${test.prompt.replace(/"/g, '\\"')}"`,
			{ encoding: "utf-8", cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
		);
	} catch (e: unknown) {
		const err = e as { stdout?: string; status?: number };
		output = err.stdout ?? "";
		if (err.status === 124) output += "\n[TIMEOUT]";
	}

	const timeSec = Math.round((Date.now() - start) / 1000);
	const { tokens, finishReason } = parseTokens(output);

	for (const m of output.matchAll(/↳ (\S+) done/g)) toolCalls.push(m[1] ?? "");

	return {
		model,
		test: test.name,
		category: test.category,
		success: test.check(output),
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
