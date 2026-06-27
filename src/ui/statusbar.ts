import { stdout } from "node:process";

/** Renders a dim status line with left/right aligned text. */
export const createStatusBar = () => {
	const render = (left: string, right: string) => {
		if (!stdout.isTTY) return;
		const cols = stdout.columns || 80;
		const maxLeft = cols - right.length - 2;
		const truncLeft = left.length > maxLeft ? `…${left.slice(-(maxLeft - 1))}` : left;
		const padding = " ".repeat(Math.max(0, cols - truncLeft.length - right.length));
		stdout.write(`\x1b[2m${truncLeft}${padding}${right}\x1b[0m\n`);
	};
	return { render };
};
