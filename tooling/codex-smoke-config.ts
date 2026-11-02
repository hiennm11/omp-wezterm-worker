/**
 * The comparison of the config file of Codex.
 *
 * The app server of Codex writes a trust entry into the config of the user
 * for a folder that the config does not know. The smoke test runs in a new
 * folder, so that write happens. The smoke test accepts the write and it
 * checks that the rest of the file did not change.
 *
 * The module parses the file. It never writes into it and it never deletes
 * a line of it.
 */

import { readFileSync } from "node:fs";

/** The result of the comparison of the config file of Codex. */
export interface ConfigComparison {
	/** The verdict of the comparison. */
	verdict: "unchanged" | "trust-entry-added" | "changed";
	/** The hash of the file before the run. */
	hashBefore: string;
	/** The hash of the file after the run. */
	hashAfter: string;
	/** The entry that the app server added, when it added one. */
	addedEntry: string | null;
	/** The lines that differ, when the file changed in another way. */
	differences: string[];
}

/** The name of a section of the config file of Codex. */
const PROJECT_SECTION = /^\[projects\.'(.+?)'\]$/;

/**
 * The lines of the section of a project.
 *
 * The function reads the file and gives the lines of the section of the
 * project back. The section holds a header and the line of its trust level.
 */
export function projectSectionLines(text: string, projectPath: string): string[] {
	const lines = text.split(/\r?\n/);
	const wanted = projectPath.toLowerCase();
	const found: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const match = PROJECT_SECTION.exec(lines[index].trim());
		if (!match) continue;
		if (match[1].toLowerCase() !== wanted) continue;
		found.push(lines[index]);
		for (let next = index + 1; next < lines.length; next += 1) {
			if (lines[next].trim().startsWith("[")) break;
			if (!lines[next].trim()) continue;
			found.push(lines[next]);
			break;
		}
	}
	return found;
}

/**
 * The lines of a config file without the section of a project.
 *
 * The function gives every line back except the lines of the section of the
 * given project. The rest of the file must hold the same lines after the
 * run.
 */
export function linesWithoutProject(text: string, projectPath: string): string[] {
	const lines = text.split(/\r?\n/);
	const kept: string[] = [];
	let skipping = false;
	for (const line of lines) {
		const match = PROJECT_SECTION.exec(line.trim());
		if (match) {
			skipping = match[1].toLowerCase() === projectPath.toLowerCase();
			if (skipping) continue;
		} else if (skipping) {
			if (line.trim().startsWith("[")) skipping = false;
			else continue;
		}
		kept.push(line);
	}
	return kept;
}

/**
 * Compare the config file of Codex before and after a run.
 *
 * The function accepts two cases. The file holds the same text, or the file
 * differs only by the added entry of the project of the fixture. Every other
 * difference is a change.
 *
 * The function reads the file twice. It never writes into it.
 */
export function compareConfigText(
	textBefore: string,
	textAfter: string,
	hashBefore: string,
	hashAfter: string,
	projectPath: string,
): ConfigComparison {
	if (textBefore === textAfter) {
		return { verdict: "unchanged", hashBefore, hashAfter, addedEntry: null, differences: [] };
	}
	const entry = projectSectionLines(textAfter, projectPath);
	if (entry.length === 0) {
		return {
			verdict: "changed",
			hashBefore,
			hashAfter,
			addedEntry: null,
			differences: ["the config of Codex holds no entry of the project of the fixture"],
		};
	}
	const before = linesWithoutProject(textBefore, projectPath);
	const after = linesWithoutProject(textAfter, projectPath);
	if (before.join("\n") !== after.join("\n")) {
		return {
			verdict: "changed",
			hashBefore,
			hashAfter,
			addedEntry: entry[0],
			differences: ["the config of Codex changed outside the entry of the project of the fixture"],
		};
	}
	return { verdict: "trust-entry-added", hashBefore, hashAfter, addedEntry: entry[0], differences: [] };
}

/**
 * Read the config file of Codex and compare it with the text before the run.
 *
 * The function reads the file and gives the comparison back. It never writes
 * into the file.
 */
export function compareConfigFile(
	file: string,
	textBefore: string,
	hashBefore: string,
	hashAfter: string,
	projectPath: string,
): ConfigComparison {
	let textAfter: string;
	try {
		textAfter = readFileSync(file, "utf8");
	} catch {
		return {
			verdict: "changed",
			hashBefore,
			hashAfter,
			addedEntry: null,
			differences: ["the config file of Codex is gone"],
		};
	}
	return compareConfigText(textBefore, textAfter, hashBefore, hashAfter, projectPath);
}
