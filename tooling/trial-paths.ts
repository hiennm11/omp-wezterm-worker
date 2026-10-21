/**
 * The paths of the Windows trial.
 *
 * The report is a document that the public repository holds, so it must not
 * hold the name of the user account or a path outside the project. Every
 * path in the report is therefore relative to the project root, and a path
 * outside the project becomes a placeholder.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** The placeholder that stands for a path outside the project. */
export const OUTSIDE = "<outside the project>";

/** The project root. Every relative path in the report starts here. */
export const PROJECT_ROOT = resolve(import.meta.dirname, "..");

/**
 * A path for the report.
 *
 * A path under the project root becomes a relative path with forward
 * slashes. Every other path becomes the placeholder, because it holds the
 * name of the user account. A path on another drive counts as outside: the
 * relative path of such a path is absolute again.
 */
export function reportPath(path: string): string {
	const absolute = resolve(path);
	const inside = relative(PROJECT_ROOT, absolute);
	if (inside === "") return ".";
	if (isAbsolute(inside)) return OUTSIDE;
	if (inside === ".." || inside.startsWith(`..${sep}`)) return OUTSIDE;
	return inside.split(sep).join("/");
}

/**
 * Remove the name of the user account from a text.
 *
 * The delivery of a worker names the directory that it worked in. That
 * directory is under the project, but the text can hold the home directory
 * of the user too, so the home directory becomes a placeholder.
 */
export function redactHome(text: string): string {
	const home = homedir();
	let result = text;
	if (home) result = result.split(home).join("<home>");
	return result.replace(/[A-Za-z]:\\Users\\[^\\\s"'|]+/g, "<home>").replace(/\/home\/[^/\s"'|]+/g, "<home>");
}

/** One path that the report replaces with a label. */
export interface TrialRoot {
	/** The absolute path on this machine. */
	absolute: string;
	/** The label that stands for it in the report. */
	label: string;
}

/** The text of a regular expression that matches the string. */
function escapePattern(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace the machine paths of a text with their labels.
 *
 * The longest path comes first, so a path under another path is replaced
 * with its own label and not with the label of its parent. The path in the
 * text may use either separator, and the result uses the forward slash, so
 * the report reads the same on every machine.
 */
export function replaceRoots(text: string, roots: TrialRoot[]): string {
	let result = text;
	for (const root of [...roots].sort((a, b) => b.absolute.length - a.absolute.length)) {
		if (!root.absolute) continue;
		const segments = root.absolute.split(/[\\/]+/).filter((part) => part.length > 0);
		if (segments.length === 0) continue;
		const pattern = segments.map(escapePattern).join("[\\\\/]");
		// The match holds the root and the path that follows it, so the
		// whole path becomes one label. The group holds the tail of the
		// path, so the separator of the text does not matter.
		const regex = new RegExp(`${pattern}((?:[\\\\/][^\\s"'|,)]*)?)`, "g");
		result = result.replace(regex, (_match, tail: string) => {
			return `${root.label}${tail.replace(/\\/g, "/")}`;
		});
	}
	return result;
}
