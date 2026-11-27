/**
 * The store of the facts.
 *
 * The store holds two files, and each file has one writer. The worker writes
 * the proposed file in its own session directory. The main session writes the
 * promoted file in the facts folder of the state directory.
 *
 * The files follow the rule of the report store: one append per fact, and a
 * partial line is skipped while the file is written. A new fact with an
 * existing key replaces the older fact, and the replaced line stays in the
 * file.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { type Fact, MAX_SNAPSHOT_LENGTH } from "./facts-model.ts";

/** The name of the file of the proposed facts. */
export const PROPOSED_FACTS_FILE = ".wezterm-worker-facts-proposed.jsonl";

/** The name of the folder of the promoted facts inside the state directory. */
export const FACTS_DIR = "facts";

/**
 * The file of the proposed facts of a session directory.
 *
 * Only the worker writes this file. The cleanup of the worker removes the
 * session directory, so it removes the file too.
 */
export function proposedFactsFile(sessionDir: string): string {
	return join(sessionDir, PROPOSED_FACTS_FILE);
}

/**
 * The file of the promoted facts of a session.
 *
 * Only the main session writes this file. The extension never removes it,
 * because a promoted fact is a work product.
 */
export function promotedFactsFile(stateDir: string, sessionId: string): string {
	return join(stateDir, FACTS_DIR, `${sessionId}.jsonl`);
}

/** Append one line to a file of facts. */
function appendFactLine(file: string, fact: Fact): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(fact)}\n`, "utf8");
}

/**
 * Append a proposed fact to the file of a session directory.
 *
 * The function returns the fact with its state.
 */
export function appendProposedFact(
	sessionDir: string,
	fact: { key: string; text: string; writer: string; at: number },
): Fact {
	const full: Fact = { ...fact, state: "proposed" };
	appendFactLine(proposedFactsFile(sessionDir), full);
	return full;
}

/**
 * Append a promoted fact to the file of a session.
 *
 * The function returns the fact with its state.
 */
export function appendPromotedFact(
	stateDir: string,
	sessionId: string,
	fact: { key: string; text: string; writer: string; at: number },
): Fact {
	const full: Fact = { ...fact, state: "promoted" };
	appendFactLine(promotedFactsFile(stateDir, sessionId), full);
	return full;
}

/**
 * Append a retraction of a key to the file of a session.
 *
 * The retraction is a new line. The line of the fact stays in the file. The
 * function returns null when the file holds no fact with that key.
 */
export function appendRetraction(
	stateDir: string,
	sessionId: string,
	fact: { key: string; writer: string; at: number },
): Fact | null {
	const file = promotedFactsFile(stateDir, sessionId);
	const current = effectiveFacts(readFacts(file)).find((item) => item.key === fact.key);
	if (!current) return null;
	const full: Fact = { ...current, writer: fact.writer, at: fact.at, state: "retracted" };
	appendFactLine(file, full);
	return full;
}

/**
 * The facts of a file, one line at a time.
 *
 * A line that is not valid JSON is skipped, because a partial line is normal
 * while the file is written. A line that holds no key or no text is
 * skipped too.
 */
export function readFacts(file: string): Fact[] {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const facts: Fact[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as Partial<Fact>;
			if (typeof parsed.key !== "string" || !parsed.key) continue;
			if (typeof parsed.text !== "string") continue;
			facts.push({
				key: parsed.key,
				text: parsed.text,
				writer: typeof parsed.writer === "string" ? parsed.writer : "",
				at: typeof parsed.at === "number" ? parsed.at : 0,
				state:
					parsed.state === "retracted" ? "retracted" : parsed.state === "proposed" ? "proposed" : "promoted",
			});
		} catch {
			/* a partial line is normal while the file is written */
		}
	}
	return facts;
}

/**
 * The facts of a file, where the last line of a key wins.
 *
 * A retraction replaces the fact of its key, so the caller sees the state of
 * the key.
 */
export function effectiveFacts(facts: Fact[]): Fact[] {
	const byKey = new Map<string, Fact>();
	for (const fact of facts) byKey.set(fact.key, fact);
	return [...byKey.values()];
}

/** The facts of the proposed file of a session directory. */
export function readProposedFacts(sessionDir: string): Fact[] {
	return effectiveFacts(readFacts(proposedFactsFile(sessionDir)));
}

/** The facts of the promoted file of a session. */
export function readPromotedFacts(stateDir: string, sessionId: string): Fact[] {
	return effectiveFacts(readFacts(promotedFactsFile(stateDir, sessionId)));
}

/** The result of a read of a key list. */
export type FactsRead = { texts: Map<string, string> } | { error: string };

/**
 * The texts of the facts of a key list.
 *
 * The read refuses the whole call when a key does not exist, when a key is
 * retracted, or when the texts hold more than the limit. The error names the
 * key or the size.
 */
export function factsByKeys(file: string, keys: string[]): FactsRead {
	const facts = effectiveFacts(readFacts(file));
	const texts = new Map<string, string>();
	let total = 0;
	for (const key of keys) {
		const fact = facts.find((item) => item.key === key);
		if (!fact) return { error: `The fact '${key}' does not exist.` };
		if (fact.state === "retracted") return { error: `The fact '${key}' is retracted.` };
		texts.set(key, fact.text);
		total += fact.text.length;
	}
	if (total > MAX_SNAPSHOT_LENGTH) {
		return {
			error: `The texts hold ${total} characters. The limit is ${MAX_SNAPSHOT_LENGTH} characters.`,
		};
	}
	return { texts };
}
