/**
 * The recovery of the resource groups.
 *
 * A crash can end a run without the code that frees its group. The recovery
 * runs at startup. It frees the groups whose holder ended and whose pane is
 * gone.
 *
 * The decision is a pure function of the groups and the jobs. The database
 * work stays in `groups.ts`.
 */

import type { LifecycleDb } from "./db.ts";
import { heldGroups, releaseExecutionByHolder, type ResourceGroup } from "./groups.ts";
import { isActive, type Job } from "./job.ts";

/**
 * The groups that the recovery must free.
 *
 * A group is free when its holder ended and its pane is gone. A holder that
 * is still active keeps its group. A holder that has no job keeps its group,
 * because the extension cannot prove that the run ended.
 */
export function groupsToRelease(groups: ResourceGroup[], jobs: Job[]): ResourceGroup[] {
	const byId = new Map(jobs.map((job) => [job.id, job]));
	return groups.filter((group) => {
		const holder = group.executionHolder;
		if (holder === null) return false;
		const job = byId.get(holder);
		if (!job) return false;
		if (isActive(job)) return false;
		return job.paneId === null || job.paneClosed;
	});
}

/**
 * Free the groups whose holder ended.
 *
 * The function returns the ids of the groups that it freed.
 */
export function releaseEndedGroups(db: LifecycleDb, jobs: Job[], now: number): string[] {
	const released = groupsToRelease(heldGroups(db), jobs);
	for (const group of released) {
		releaseExecutionByHolder(db, group.executionHolder ?? "", now);
	}
	return released.map((group) => group.id);
}
