/**
 * The pane of the source run of a resume.
 *
 * A resume starts a second writer for the transcript of its source run. The
 * pane of the source run can still write into that transcript. The resume
 * must wait until that pane is gone.
 *
 * A Codex worker owns two panes. The pane of the TUI holds the thread, and
 * the pane of the app server holds the program of that thread. Both panes
 * must be gone before a resume starts.
 *
 * An unreadable pane list gives the state `unknown`. A resume must not start
 * on an unknown state, because a broken WezTerm must not look like a closed
 * pane.
 */

import type { Job } from "./job.ts";
import { type PaneState, paneStatesOf } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The pane of the source run that a refusal names. */
export type SourcePaneKind = "tui" | "server";

/**
 * The reason that a resume must not start, or null when it can start.
 *
 * The function is pure. It takes the state of the pane and the id of the
 * pane. It reads no process and no file.
 */
export function sourcePaneRefusal(
	state: PaneState,
	paneId: number,
	kind: SourcePaneKind = "tui",
): string | null {
	if (state === "present") {
		if (kind === "server") {
			return `The pane ${paneId} of the app server of the source run is still open. Close pane ${paneId}, then resume again.`;
		}
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
	const tuiPaneId = source.paneId;
	const serverPaneId = source.codex?.serverPaneId ?? null;
	const ids = [tuiPaneId, serverPaneId].filter((id): id is number => id !== null);
	if (ids.length === 0) return null;
	const states = await paneStatesOf(rt, ids);
	if (tuiPaneId !== null) {
		const refusal = sourcePaneRefusal(states.get(tuiPaneId) ?? "unknown", tuiPaneId, "tui");
		if (refusal) return refusal;
	}
	if (serverPaneId !== null) {
		const refusal = sourcePaneRefusal(states.get(serverPaneId) ?? "unknown", serverPaneId, "server");
		if (refusal) return refusal;
	}
	return null;
}
