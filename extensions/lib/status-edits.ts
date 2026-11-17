/**
 * The line of the status tool that counts the file changes of a worker.
 *
 * The count comes from the transcript of the worker. Only an OMP worker has
 * a transcript that holds the change calls, so only an OMP worker shows the
 * line. A Claude worker shows no line.
 */

import type { RunBackend } from "./backend.ts";

/**
 * The text of the line, or null when the worker shows no line.
 *
 * A run of the removed backend reads as another backend than OMP, so it
 * shows no line. A worker with no count has no transcript that the owner
 * can read.
 */
export function editsText(
	backend: RunBackend,
	editCalls: number | undefined,
	turnsText: string,
): string | null {
	if (backend !== "omp") return null;
	if (editCalls === undefined) return null;
	return `${editCalls} edit call(s) in ${turnsText} turns`;
}
