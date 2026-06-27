import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSkills } from "./discover.js";

const TEST_DIR = join(import.meta.dirname, "../../.test-skills");
const SKILLS_A = join(TEST_DIR, "a-skills");
const SKILLS_B = join(TEST_DIR, "b-skills");

const VALID_SKILL = `---
name: test-skill
description: A test skill
---

Do the thing.
`;

beforeEach(() => {
	mkdirSync(SKILLS_A, { recursive: true });
	mkdirSync(SKILLS_B, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("skill discovery", () => {
	it("finds skills in a directory", () => {
		mkdirSync(join(SKILLS_A, "my-skill"));
		writeFileSync(join(SKILLS_A, "my-skill", "SKILL.md"), VALID_SKILL);

		const skills = discoverSkills([SKILLS_A]);
		expect(skills).toHaveLength(1);
		expect(skills[0]?.name).toBe("test-skill");
	});

	it("searches multiple directories", () => {
		mkdirSync(join(SKILLS_A, "skill-one"));
		writeFileSync(join(SKILLS_A, "skill-one", "SKILL.md"), VALID_SKILL);

		mkdirSync(join(SKILLS_B, "skill-two"));
		writeFileSync(
			join(SKILLS_B, "skill-two", "SKILL.md"),
			`---
name: second
description: Another skill
---

Body.
`,
		);

		const skills = discoverSkills([SKILLS_A, SKILLS_B]);
		expect(skills).toHaveLength(2);
	});

	it("skips directories without SKILL.md", () => {
		mkdirSync(join(SKILLS_A, "empty-dir"));

		const skills = discoverSkills([SKILLS_A]);
		expect(skills).toHaveLength(0);
	});

	it("skips invalid skills gracefully", () => {
		mkdirSync(join(SKILLS_A, "bad"));
		writeFileSync(join(SKILLS_A, "bad", "SKILL.md"), "no frontmatter here");

		mkdirSync(join(SKILLS_A, "good"));
		writeFileSync(join(SKILLS_A, "good", "SKILL.md"), VALID_SKILL);

		const skills = discoverSkills([SKILLS_A]);
		expect(skills).toHaveLength(1);
	});

	it("handles nonexistent directories gracefully", () => {
		const skills = discoverSkills(["/nonexistent/path"]);
		expect(skills).toHaveLength(0);
	});

	it("deduplicates by name, first found wins", () => {
		mkdirSync(join(SKILLS_A, "dupe"));
		writeFileSync(join(SKILLS_A, "dupe", "SKILL.md"), VALID_SKILL);

		mkdirSync(join(SKILLS_B, "dupe"));
		writeFileSync(
			join(SKILLS_B, "dupe", "SKILL.md"),
			`---
name: test-skill
description: Duplicate with different body
---

Different body.
`,
		);

		const skills = discoverSkills([SKILLS_A, SKILLS_B]);
		expect(skills).toHaveLength(1);
		expect(skills[0]?.body).toBe("Do the thing.");
	});
});
