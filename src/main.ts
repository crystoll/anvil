#!/usr/bin/env node

const args = process.argv.slice(2);
const simple =
	args.includes("--simple") ||
	!process.stdout.isTTY ||
	process.env.TERM === "dumb" ||
	args.includes("-c");

if (simple) {
	await import("./cli.js");
} else {
	await import("./tui/app.js");
}
