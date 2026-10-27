/**
 * The recovery of the resource groups.
 *
 * A crash can end a run without the code that frees its group. The recovery
 * runs at startup. It reads the pane list one time. It frees the groups whose
 * holder ended and whose pane is gone. An open pane and an unreadable pane
 * list keep the group held.
 *
 * The decision is a pure function of the groups, the jobs and the states of
 * the panes. The database work stays in `groups.ts`.
 */

import { decideHolder } from "./group-holder.ts";
import { heldGroups, type ResourceGroup, releaseExecutionByHolder } from "./groups.ts";
import { isActive, type Job } from "./job.ts";
import { type PaneState, paneStatesOf } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * The groups that the recovery must free.
 *
 * The states hold the state of every pane that the caller read. A group is
 * free when its holder ended and its pane is gone. A holder that is still
 * active keeps its group. A holder that has no job keeps its group, because
 * the extension cannot prove that the run ended.
 */
export function groupsToRelease(
	groups: ResourceGroup[],
	jobs: Job[],
	states: ReadonlyMap<number, PaneState>,
): ResourceGroup[] {
	const byId = new Map(jobs.map((job) => [job.id, job]));
	return groups.filter((group) => {
		const holder = group.executionHolder;
		if (holder === null) return false;
		const job = byId.get(holder);
		if (!job) return false;
		const state = job.paneId !== null && !job.paneClosed ? (states.get(job.paneId) ?? null) : null;
		return decideHolder(job, state) === "release";
	});
}

/**
 * Free the groups whose holder ended.
 *
 * The function returns the ids of the groups that it freed. It reads the pane
 * list one time, and only when a holder needs the state of its pane.
 */
export async function releaseEndedGroups(rt: WorkerRuntime, jobs: Job[], now: number): Promise<string[]> {
	const db = rt.openDb();
	const groups = heldGroups(db);
	const byId = new Map(jobs.map((job) => [job.id, job]));
	const paneIds: number[] = [];
	for (const group of groups) {
		const holder = group.executionHolder;
		if (holder === null) continue;
		const job = byId.get(holder);
		if (!job || isActive(job)) continue;
		if (job.paneId === null || job.paneClosed) continue;
		if (!paneIds.includes(job.paneId)) paneIds.push(job.paneId);
	}
	const states = paneIds.length > 0 ? await paneStatesOf(rt, paneIds) : new Map<number, PaneState>();

	const released = groupsToRelease(groups, jobs, states);
	const holders = new Set(released.map((group) => group.executionHolder).filter((id) => id !== null));
	for (const holder of holders) {
		releaseExecutionByHolder(db, holder, now);
	}
	let changed = false;
	for (const group of released) {
		const holder = group.executionHolder;
		if (holder === null) continue;
		const job = byId.get(holder);
		if (!job || job.paneId === null) continue;
		if (states.get(job.paneId) !== "gone") continue;
		// The pane list proved the pane is gone. The record of the run must
		// show that, so the next reader does not probe the pane again.
		job.paneClosed = true;
		changed = true;
	}
	if (changed) rt.persist();
	return released.map((group) => group.id);
}
