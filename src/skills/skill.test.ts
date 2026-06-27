import { describe, expect, it } from "vitest";
import { parseSkill } from "./skill.js";

describe("skill parser", () => {
	it("parses valid skill with frontmatter and body", () => {
		const input = `---
name: code-review
description: Review code for quality and security issues
---

## Review checklist

1. Check for security vulnerabilities
2. Verify error handling
3. Ensure tests exist
`;

		const result = parseSkill(input);
		expect(result.isOk()).toBe(true);
		const skill = result._unsafeUnwrap();
		expect(skill.name).toBe("code-review");
		expect(skill.description).toBe("Review code for quality and security issues");
		expect(skill.body).toContain("## Review checklist");
		expect(skill.body).toContain("Check for security vulnerabilities");
	});

	it("returns err when frontmatter is missing", () => {
		const input = `# No frontmatter here

Just some content.
`;

		const result = parseSkill(input);
		expect(result.isErr()).toBe(true);
	});

	it("returns err when name is missing", () => {
		const input = `---
description: Something
---

Body here.
`;

		const result = parseSkill(input);
		expect(result.isErr()).toBe(true);
	});

	it("returns err when description is missing", () => {
		const input = `---
name: my-skill
---

Body here.
`;

		const result = parseSkill(input);
		expect(result.isErr()).toBe(true);
	});

	it("trims whitespace from body", () => {
		const input = `---
name: test
description: A test skill
---

  Body content here.
`;

		const result = parseSkill(input);
		expect(result._unsafeUnwrap().body).toBe("Body content here.");
	});

	it("handles extra frontmatter fields gracefully", () => {
		const input = `---
name: deploy
description: Deploy to production
disable-model-invocation: true
allowed-tools: Bash(git *)
---

Deploy steps here.
`;

		const result = parseSkill(input);
		expect(result.isOk()).toBe(true);
		expect(result._unsafeUnwrap().name).toBe("deploy");
	});
});
