/**
 * The holder of a resource group that ended.
 *
 * A run keeps its group when its pane stays open after the run ends. The
 * pane can still write into the shared transcript, so the group stays held.
 * A user can close that pane by hand. Nothing else frees the group then, and
 * a resume and a cleanup of the task refuse for ever.
 *
 * A resume and a cleanup read the pane list. When the pane of the holder is
 * gone, the holder frees the group. An unreadable pane list keeps the group
 * held, because a broken WezTerm must not look like a closed pane.
 *
 * The decision is a pure function of the job of the holder and the state of
 * its pane. The database work stays in `groups.ts`.
 */

import { type ResourceGroup, releaseExecutionByHolder } from "./groups.ts";
import { isActive, type Job } from "./job.ts";
import { type PaneState, paneState } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * What a caller must do with the holder of a group.
 *
 * The value `release` frees the group. The value `keep-pane-open` and the
 * value `keep-pane-unknown` refuse the caller and name the pane. The value
 * `keep` leaves the group as it is, so the old refusal of the caller stays
 * in force.
 */
export type HolderDecision = "release" | "keep-pane-open" | "keep-pane-unknown" | "keep";

/**
 * The decision about the holder of a group.
 *
 * The function is pure. It takes the job of the holder, or undefined when
 * this process does not know the holder, and the state of its pane, or null
 * when the pane was not read.
 *
 * A job with a closed pane or without a pane needs no probe of the pane
 * list. Such a job releases its group.
 */
export function decideHolder(job: Job | undefined, state: PaneState | null): HolderDecision {
	if (!job) return "keep";
	if (isActive(job)) return "keep";
	if (job.paneId === null || job.paneClosed) return "release";
	if (state === "gone") return "release";
	if (state === "present") return "keep-pane-open";
	if (state === "unknown") return "keep-pane-unknown";
	return "keep";
}

/**
 * Free the group of a holder that ended, when its pane is gone.
 *
 * The function returns the refusal text, or null when the group is free or
 * when the caller must keep its own refusal. A refusal names the pane that
 * holds the group.
 */
export async function freeEndedHolder(
	rt: WorkerRuntime,
	group: ResourceGroup,
): Promise<string | null> {
	const holder = group.executionHolder;
	if (holder === null) return null;
	const job = rt.jobs.get(holder);
	if (!job) return null;
	if (isActive(job)) return null;

	let state: PaneState | null = null;
	if (job.paneId !== null && !job.paneClosed) state = await paneState(rt, job.paneId);

	const decision = decideHolder(job, state);
	if (decision === "release") {
		// The pane list proved the pane is gone. The record of the run must
		// show that, so the next reader does not probe the pane again.
		if (state === "gone") job.paneClosed = true;
		rt.persist();
		releaseExecutionByHolder(rt.openDb(), holder, Date.now());
		return null;
	}
	if (decision === "keep-pane-open" && job.paneId !== null) {
		return (
			`The resources of this task are held by run ${holder}. ` +
			`Its pane ${job.paneId} is still open. Close pane ${job.paneId}, then try again.`
		);
	}
	if (decision === "keep-pane-unknown" && job.paneId !== null) {
		return `The pane list cannot be read, so the state of pane ${job.paneId} is unknown. Try again.`;
	}
	return null;
}
