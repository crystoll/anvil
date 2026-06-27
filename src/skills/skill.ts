import yaml from "js-yaml";
import { type Result, err, ok } from "neverthrow";

/** A parsed skill definition. */
export type Skill = {
	name: string;
	description: string;
	body: string;
};

/** Parse a SKILL.md file into a Skill. */
export const parseSkill = (content: string): Result<Skill, string> => {
	const parts = splitFrontmatter(content);
	if (!parts) return err("Missing YAML frontmatter (---...---)");

	let meta: Record<string, unknown>;
	try {
		meta = yaml.load(parts.frontmatter) as Record<string, unknown>;
	} catch {
		return err("Invalid YAML in frontmatter");
	}

	const name = meta?.name;
	if (typeof name !== "string" || !name) return err("Frontmatter must include 'name'");

	const description = meta?.description;
	if (typeof description !== "string" || !description)
		return err("Frontmatter must include 'description'");

	return ok({ name, description, body: parts.body.trim() });
};

const splitFrontmatter = (content: string): { frontmatter: string; body: string } | undefined => {
	const trimmed = content.trimStart();
	if (!trimmed.startsWith("---")) return undefined;

	const endIdx = trimmed.indexOf("---", 3);
	if (endIdx === -1) return undefined;

	return {
		frontmatter: trimmed.slice(3, endIdx),
		body: trimmed.slice(endIdx + 3),
	};
};
