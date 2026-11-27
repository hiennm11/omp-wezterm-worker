/**
 * The snapshot of the facts that a worker receives.
 *
 * The main session promotes the facts. The spawn reads the promoted facts
 * once and writes their texts into a frozen snapshot in the session
 * directory of the worker. The bootstrap prompt of the worker holds the
 * snapshot, so both backends give the worker the same facts.
 *
 * The snapshot never changes. A fact that the main session retracts later
 * does not reach a worker that already started.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NO_SESSION_IDENTITY } from "./facts-model.ts";
import { factsByKeys, promotedFactsFile } from "./facts-store.ts";

/** The name of the file of the snapshot in a session directory. */
export const FACTS_SNAPSHOT_FILE = ".wezterm-worker-facts-snapshot.md";

/** The file of the snapshot in a session directory. */
export function factsSnapshotFile(sessionDir: string): string {
	return join(sessionDir, FACTS_SNAPSHOT_FILE);
}

/**
 * The result of a read of the facts of a key list.
 *
 * The result holds the texts of the keys, or the reason that the read
 * refuses them.
 */
export type SnapshotRead = { texts: Map<string, string> } | { error: string };

/**
 * The texts of the promoted facts of a key list.
 *
 * The read refuses the whole list when the session has no identity, when a
 * key does not exist, when a key is retracted, or when the texts hold more
 * characters than the limit. The error names the key or the size.
 */
export function snapshotRead(stateDir: string, sessionId: string | null, keys: string[]): SnapshotRead {
	if (!sessionId) return { error: NO_SESSION_IDENTITY };
	return factsByKeys(promotedFactsFile(stateDir, sessionId), keys);
}

/**
 * Write the snapshot of the facts into a session directory.
 *
 * The file holds one entry for each key. The text of a fact is never cut.
 * The function writes nothing when the worker receives no fact, so a
 * session directory without facts holds no snapshot file.
 */
export function writeFactsSnapshot(
	sessionDir: string,
	texts: ReadonlyMap<string, string> | null,
): string | null {
	if (!texts || texts.size === 0) return null;
	const file = factsSnapshotFile(sessionDir);
	const lines = ["# The facts of the main session", ""];
	for (const [key, text] of texts) {
		lines.push(`## ${key}`, "", text, "");
	}
	writeFileSync(file, lines.join("\n"), "utf8");
	return file;
}

/**
 * The text of the snapshot of a session directory.
 *
 * The function returns null when the session directory holds no snapshot.
 */
export function readFactsSnapshot(sessionDir: string): string | null {
	try {
		return readFileSync(factsSnapshotFile(sessionDir), "utf8");
	} catch {
		return null;
	}
}
