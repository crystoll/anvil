import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Skill } from "./skill.js";
import { parseSkill } from "./skill.js";

/** Discover skills from multiple directories. First-found wins on name conflicts. */
export const discoverSkills = (dirs: string[]): Skill[] => {
	const seen = new Set<string>();
	const skills: Skill[] = [];

	for (const dir of dirs) {
		for (const skill of scanDir(dir)) {
			if (seen.has(skill.name)) continue;
			seen.add(skill.name);
			skills.push(skill);
		}
	}
	return skills;
};

const scanDir = (dir: string): Skill[] => {
	if (!existsSync(dir)) return [];

	const entries = readdirSync(dir, { withFileTypes: true });
	const results: Skill[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const skillPath = join(dir, entry.name, "SKILL.md");
		if (!existsSync(skillPath)) continue;

		const content = readFileSync(skillPath, "utf-8");
		const result = parseSkill(content);
		if (result.isOk()) results.push(result.value);
	}
	return results;
};
