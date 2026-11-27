/**
 * The fact that the main session promotes.
 *
 * A fact has a key, a text, a writer, a time and a state. The key names the
 * fact in the store. The text holds 4000 characters at most. The writer
 * names the session or the worker that wrote the text. The state says what
 * the store does with the fact.
 *
 * A proposed fact waits for the main session. A promoted fact can reach
 * another worker. A retracted fact stays in the file, but a reader ignores
 * it.
 */

/** The state that a fact holds in the store. */
export type FactState = "proposed" | "promoted" | "retracted";

/** One fact of the store. */
export interface Fact {
	/** The key of the fact. The key is unique in the store. */
	key: string;
	/** The text of the fact. */
	text: string;
	/** The id of the worker or the session that wrote the text. */
	writer: string;
	/** The time of the fact, in milliseconds since the epoch. */
	at: number;
	/** The state of the fact in the store. */
	state: FactState;
}

/** The longest text that a fact accepts. */
export const MAX_FACT_LENGTH = 4000;

/** The largest total size of the texts that a snapshot may hold. */
export const MAX_SNAPSHOT_LENGTH = 16000;

/**
 * The reason that a fact text is refused, or null when the text is accepted.
 *
 * A fact without text proves nothing. A fact longer than the limit does not
 * fit into a snapshot.
 */
export function factTextRefusal(text: string): string | null {
	const body = typeof text === "string" ? text.trim() : "";
	if (!body) return "A fact needs text.";
	if (body.length > MAX_FACT_LENGTH) return `A fact holds at most ${MAX_FACT_LENGTH} characters.`;
	return null;
}

/**
 * The reason that a fact key is refused, or null when the key is accepted.
 *
 * The key names the fact, so it must hold text.
 */
export function factKeyRefusal(key: string): string | null {
	const body = typeof key === "string" ? key.trim() : "";
	if (!body) return "A fact needs a key.";
	return null;
}

/** The sentence that the reply of a retraction holds. */
export const RETRACTION_NOTICE =
	"A worker that already started keeps its snapshot. The retraction changes no worker that runs.";

/**
 * The refusal that a session without an identity gets.
 *
 * A session without an identity has no store of facts, so it can neither
 * promote a fact nor read one into a worker.
 */
export const NO_SESSION_IDENTITY = "This session has no identity. It has no store of facts.";

/**
 * The text of a list of facts.
 *
 * The reply names the state of every fact, so the main session sees that a
 * key was retracted.
 */
export function formatFacts(facts: Fact[]): string {
	if (facts.length === 0) return "The store holds no fact.";
	const lines = facts.map((fact) => `${fact.key} [${fact.state}] ${fact.writer}: ${fact.text}`);
	return lines.join("\n");
}
