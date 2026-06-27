import { describe, expect, it } from "vitest";
import { VERSION } from "./index.js";

describe("anvil", () => {
	it("exports a version string", () => {
		expect(VERSION).toBe("0.2.0");
	});
});
