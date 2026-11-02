/**
 * The helpers that read the home folder of Claude Code.
 *
 * The helpers read the config, the session folders and the history of the
 * user. They never write into that folder. The smoke test runs the real
 * Claude Code program, and that program writes its own session folder into
 * the home folder of the user.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The home folder of Claude Code. */
export function claudeHome(): string {
	return join(homedir(), ".claude");
}

/** The path of the config file of Claude Code. */
export function claudeSettingsFile(): string {
	return join(claudeHome(), "settings.json");
}

/** The path of the folder that holds the session folders of Claude Code. */
export function claudeProjectsFolder(): string {
	return join(claudeHome(), "projects");
}

/**
 * The hash of a file, or the text `missing` when the file is absent.
 *
 * The function reads the file and never writes into it.
 */
export function hashOfFile(file: string): string {
	try {
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return "missing";
	}
}

/**
 * The names of the entries of the folder of the session folders.
 *
 * The function lists the folder and never writes into it. A folder that
 * cannot be read gives an empty list, and the caller knows that the state
 * of the folder is unknown.
 */
export function claudeProjectEntries(): string[] {
	try {
		return readdirSync(claudeProjectsFolder()).sort();
	} catch {
		return [];
	}
}

/**
 * The session folder of a run of Claude Code.
 *
 * Claude Code names the folder of a session after the folder of the working
 * directory. The function finds the folder that holds the session file of
 * the given session id.
 */
export function claudeSessionFolderOf(sessionId: string): string | null {
	for (const entry of claudeProjectEntries()) {
		const folder = join(claudeProjectsFolder(), entry);
		let names: string[];
		try {
			names = readdirSync(folder);
		} catch {
			continue;
		}
		if (names.some((name) => name.startsWith(sessionId))) return folder;
	}
	return null;
}
