/**
 * The start evidence of an execution row that a transcript opened.
 *
 * The evidence names the turn of the call that started the execution. It
 * names the command of the call too, because the owner needs the command to
 * act on a background job that never reported.
 */

/** The evidence that names the turn and the command of a call. */
export function startEvidenceOf(turn: number, command: string | null): string {
	if (command === null) return `turn ${turn}`;
	return `turn ${turn}: ${command}`;
}

/**
 * The command that the start evidence names, or null when it names none.
 *
 * The evidence starts with the turn. The command follows the first colon
 * and a space.
 */
export function commandOfStartEvidence(evidence: string): string | null {
	const marker = evidence.indexOf(": ");
	if (marker < 0) return null;
	return evidence.slice(marker + 2);
}
