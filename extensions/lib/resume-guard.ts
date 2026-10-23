/**
 * The pane of the source run of a resume.
 *
 * A resume starts a second writer for the transcript of its source run. The
 * pane of the source run can still write into that transcript. The resume
 * must wait until that pane is gone.
 *
 * An unreadable pane list gives the state `unknown`. A resume must not start
 * on an unknown state, because a broken WezTerm must not look like a closed
 * pane.
 */

import type { Job } from "./job.ts";
import { paneState, type PaneState } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * The reason that a resume must not start, or null when it can start.
 *
 * The function is pure. It takes the state of the pane and the id of the
 * pane. It reads no process and no file.
 */
export function sourcePaneRefusal(state: PaneState, paneId: number): string | null {
	if (state === "present") {
		return `The pane ${paneId} of the source run is still open. Close pane ${paneId}, then resume again.`;
	}
	if (state === "unknown") {
		return `The pane list cannot be read, so the state of pane ${paneId} is unknown. Try the resume again.`;
	}
	return null;
}

/**
 * The reason that a resume of `source` must not start, or null when it can.
 *
 * A source run without a pane has nothing that can write into the shared
 * transcript. The function reads no pane list for such a source run.
 */
export async function checkSourcePane(rt: WorkerRuntime, source: Job): Promise<string | null> {
	if (source.paneId === null) return null;
	return sourcePaneRefusal(await paneState(rt, source.paneId), source.paneId);
}
