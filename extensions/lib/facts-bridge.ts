/**
 * The facts of a Claude Code worker, as the bridge serves them.
 *
 * The mod of a worker never reads a fact file. It asks the bridge for the
 * fact and the bridge writes it. The shape of a fact therefore lives in one
 * place, and both backends write the same shape.
 */

import { factKeyRefusal, factTextRefusal } from "./facts-model.ts";
import { appendProposedFact } from "./facts-store.ts";

/** The facts of one session directory, as the bridge serves them. */
export interface BridgeFacts {
	/** Save a proposed fact of the worker, or refuse its text. */
	proposeFact(key: string, text: string): { key: string; text: string } | { refusal: string };
}

/**
 * The facts of one session directory.
 *
 * The bridge serves the facts of the run that it belongs to. The proposed
 * facts live in the session directory of the run.
 */
export function factsOf(sessionDir: string, runId: string): BridgeFacts {
	return {
		proposeFact(key: string, text: string): { key: string; text: string } | { refusal: string } {
			const name = key.trim();
			const body = text.trim();
			const keyRefusal = factKeyRefusal(name);
			if (keyRefusal) return { refusal: keyRefusal };
			const textRefusal = factTextRefusal(body);
			if (textRefusal) return { refusal: textRefusal };
			const fact = appendProposedFact(sessionDir, {
				key: name,
				text: body,
				writer: runId,
				at: Date.now(),
			});
			return { key: fact.key, text: `The fact '${fact.key}' is proposed. The main session promotes it.` };
		},
	};
}
