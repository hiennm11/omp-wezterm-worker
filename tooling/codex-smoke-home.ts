/**
 * The helpers that read the home folder of Codex.
 *
 * The helpers read the config, the credentials and the rollout files of the
 * user. They never write into that folder.
 */

import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The home folder of Codex. */
export function codexHome(): string {
	return join(homedir(), ".codex");
}

/** The path of the config file of Codex. */
export function codexConfigFile(): string {
	return join(codexHome(), "config.toml");
}

/** The path of the credentials of Codex. */
export function codexAuthFile(): string {
	return join(codexHome(), "auth.json");
}

/** The hash of a file, or the text `missing` when the file is absent. */
export function hashOfFile(file: string): string {
	try {
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return "missing";
	}
}

/** The projects that the config of the user names. */
export function configuredProjectPaths(): string[] {
	try {
		const text = readFileSync(codexConfigFile(), "utf8");
		const found: string[] = [];
		for (const line of text.split(/\r?\n/)) {
			const match = /^\[projects\.'(.+?)'\]/.exec(line.trim());
			if (match) found.push(match[1]);
		}
		return found;
	} catch {
		return [];
	}
}

/** The names of the MCP servers that the config of the user names. */
export function configuredMcpServerNames(): string[] {
	try {
		const text = readFileSync(codexConfigFile(), "utf8");
		const names: string[] = [];
		for (const line of text.split(/\r?\n/)) {
			const match = /^\[mcp_servers\.([^\]]+)\]/.exec(line.trim());
			if (match) names.push(match[1]);
		}
		return names;
	} catch {
		return [];
	}
}

/**
 * The folders that the config of the user trusts and that hold a Git
 * repository.
 *
 * The app server of Codex writes a trust entry into the config of the user
 * for a folder that the config does not know. A smoke test that runs in an
 * unknown folder changes the config of the user, and the change hides the
 * behaviour of the extension. The smoke test therefore runs in a folder of a
 * project that the config already trusts.
 */
export function trustedGitRoots(): string[] {
	const found: string[] = [];
	for (const path of configuredProjectPaths()) {
		if (!existsSync(join(path, ".git"))) continue;
		if (found.includes(path)) continue;
		found.push(path);
	}
	return found;
}

/**
 * The folder that holds the temporary work of the smoke test.
 *
 * The folder is a subfolder of a project that the config of the user
 * trusts. The subfolder holds no Git repository of its own, because the
 * app server of Codex resolves the trust of the repository of the closest
 * parent. A subfolder with a repository of its own would get a trust entry
 * of its own, and the config of the user would change.
 */
export function trustedFixtureParent(): string | null {
	const temp = homedir().toLowerCase();
	const roots = trustedGitRoots();
	const preferred = roots.filter((path) => path.toLowerCase().startsWith(temp));
	const chosen = preferred[0] ?? roots[0] ?? null;
	if (!chosen) return null;
	return join(chosen, "codex-smoke-work");
}

/** The files of the session folder of Codex that hold a rollout. */
export function rolloutFiles(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".jsonl")) found.push(path);
		}
	};
	walk(join(codexHome(), "sessions"));
	return found;
}

/**
 * The rollout file of a thread.
 *
 * The name of the file carries the id of the thread. The function finds the
 * file of a thread id and gives the path back.
 */
export function rolloutFileOf(threadId: string): string | null {
	const found = rolloutFiles().find((file) => file.includes(threadId));
	return found ?? null;
}

/**
 * The policy of the approval of a turn.
 *
 * The config of the user sets the policy of the approval to `never`, so a
 * turn without a policy runs every command without a question. The policy
 * `untrusted` makes the core of Codex ask the person for every command that
 * it does not know. The smoke test names that policy, so the TUI shows its
 * dialog and the extension can record the event of the request.
 */
export const APPROVAL_POLICY = "untrusted";

/**
 * The times of the events of a thread, read from its rollout file.
 *
 * The rollout file holds the turns of the thread. The function reads the
 * time of the start of the first turn, the time of the delivery of the
 * instruction that names a client id, and the time of the first user
 * message of a turn.
 *
 * The app server sends the event `turn/started` only to the connections
 * that subscribed before the turn started. The rollout file holds every
 * event of the turn, so the smoke test reads the times there.
 */
export function rolloutEventTimes(
	threadId: string,
	clientId: string,
): { turnStarted: number | null; delivered: number | null; firstUserMessage: number | null } {
	const file = rolloutFileOf(threadId);
	const empty = { turnStarted: null, delivered: null, firstUserMessage: null };
	if (!file) return empty;
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return empty;
	}
	let turnStarted: number | null = null;
	let delivered: number | null = null;
	let firstUserMessage: number | null = null;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let parsed: {
			timestamp?: string;
			payload?: {
				type?: string;
				item?: { type?: string; client_id?: string };
			};
		};
		try {
			parsed = JSON.parse(line) as typeof parsed;
		} catch {
			continue;
		}
		const at = parsed.timestamp ? Date.parse(parsed.timestamp) : Number.NaN;
		if (Number.isNaN(at)) continue;
		const payload = parsed.payload;
		if (payload?.type === "task_started" && turnStarted === null) turnStarted = at;
		if (payload?.type === "item_completed" && payload.item?.type === "UserMessage") {
			if (firstUserMessage === null) firstUserMessage = at;
			if (payload.item.client_id === clientId && delivered === null) delivered = at;
		}
	}
	return { turnStarted, delivered, firstUserMessage };
}
