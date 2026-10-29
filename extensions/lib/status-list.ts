/**
 * The list of workers that the status tool shows.
 *
 * The registry holds more than a hundred workers. The tool shows the active
 * ones, the ones with an event that waits for the owner, and the newest of
 * the finished ones. The rest stay hidden, and the tool names the count.
 *
 * The selection is a pure function of the jobs and the pending run ids. A
 * test calls it without a runtime.
 */

import { isActive, type Job } from "./job.ts";

/** The workers that the tool shows, and the count of the hidden ones. */
export interface StatusSelection {
	/** The workers that the reply shows, in the order of the groups. */
	shown: Job[];
	/** The number of workers that the reply hides. */
	hidden: number;
}

/**
 * Choose the workers that the status tool shows.
 *
 * The groups keep their order. The active workers come first, then the
 * workers with a pending event, then the newest of the finished workers. A
 * worker that belongs to two groups appears once.
 *
 * The function reads no runtime and starts no program.
 */
export function selectStatusJobs(
	jobs: readonly Job[],
	pendingRunIds: ReadonlySet<string>,
	finishedLimit: number,
): StatusSelection {
	const active: Job[] = [];
	const withEvent: Job[] = [];
	const finished: Job[] = [];
	for (const job of jobs) {
		if (isActive(job)) active.push(job);
		else if (pendingRunIds.has(job.id)) withEvent.push(job);
		else finished.push(job);
	}
	const newestFirst = (a: Job, b: Job): number => b.createdAt - a.createdAt;
	active.sort(newestFirst);
	withEvent.sort(newestFirst);
	finished.sort(newestFirst);
	const shown = [...active, ...withEvent, ...finished.slice(0, finishedLimit)];
	return { shown, hidden: jobs.length - shown.length };
}
