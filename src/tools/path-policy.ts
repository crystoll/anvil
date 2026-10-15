import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const expandHome = (path: string): string =>
	path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;

const errorCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

const resolveExistingPath = async (
	candidate: string,
): Promise<{ resolved: string } | { linkTarget: string } | null> => {
	try {
		return { resolved: await realpath(candidate) };
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}

	try {
		const stats = await lstat(candidate);
		if (stats.isSymbolicLink())
			return { linkTarget: resolve(dirname(candidate), await readlink(candidate)) };
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	return null;
};

/** Resolve existing symlinks and preserve missing path components for new-file targets. */
export const resolveRealPath = async (
	path: string,
	projectRoot: string,
	expandTilde = false,
): Promise<string> => {
	const root = await realpath(projectRoot);
	let candidate = resolve(root, expandTilde ? expandHome(path) : path);
	const missingParts: string[] = [];

	while (true) {
		const existingPath = await resolveExistingPath(candidate);
		if (existingPath && "resolved" in existingPath)
			return resolve(existingPath.resolved, ...missingParts);
		if (existingPath && "linkTarget" in existingPath) {
			candidate = existingPath.linkTarget;
			continue;
		}

		const parent = dirname(candidate);
		if (parent === candidate) throw new Error(`Unable to resolve path: ${path}`);
		missingParts.unshift(basename(candidate));
		candidate = parent;
	}
};

/** Check whether a tool path resolves beyond the project root. */
export const isPathOutsideProject = async (
	path: string,
	projectRoot: string,
	expandTilde = false,
): Promise<boolean> => {
	const [root, target] = await Promise.all([
		realpath(projectRoot),
		resolveRealPath(path, projectRoot, expandTilde),
	]);
	const relativePath = relative(root, target);
	return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
};

/** Require approval when a glob's literal prefix or traversal can reach outside the project. */
export const isGlobOutsideProject = async (
	pattern: string,
	projectRoot: string,
): Promise<boolean> => {
	const segments = pattern.split(/[\\/]/);
	const wildcardIndex = segments.findIndex((segment) => /[*?[\]{}]/.test(segment));
	const staticPath =
		wildcardIndex < 0 ? segments.join("/") : segments.slice(0, wildcardIndex).join("/") || ".";
	if (wildcardIndex >= 0 && segments.slice(wildcardIndex).includes("..")) return true;
	return isPathOutsideProject(staticPath, projectRoot, true);
};

/** Resolve a glob's literal prefix and return a pattern relative to the canonical project root. */
export const resolveGlobPattern = async (
	pattern: string,
	projectRoot: string,
): Promise<{ pattern: string; cwd: string }> => {
	const root = await realpath(projectRoot);
	const segments = pattern.split(/[\\/]/);
	const wildcardIndex = segments.findIndex((segment) => /[*?[\]{}]/.test(segment));
	const staticPath =
		wildcardIndex < 0 ? pattern : segments.slice(0, wildcardIndex).join("/") || ".";
	const suffix = wildcardIndex < 0 ? [] : segments.slice(wildcardIndex);
	const canonicalPrefix = await resolveRealPath(staticPath, root, true);
	const prefix = relative(root, canonicalPrefix) || ".";
	return { pattern: [prefix, ...suffix].join("/"), cwd: root };
};
