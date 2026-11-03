/**
 * The pane check of a monitor.
 *
 * A worker whose pane is gone has no process. The monitor must not keep it
 * active until the total deadline, because an active worker holds a capacity
 * slot. Only the pane list proves that a pane is gone (GLOSSARY: Stopped).
 */

import { isActive, type Job } from "./job.ts";
import { settleDetachedJob } from "./lifecycle.ts";
import { runMonitorAction } from "./monitor-actions.ts";
import { type PaneState, paneState } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * True when the pane list confirms that the pane of an active worker is gone.
 * A pending stop has its own confirmation path, and an unreadable pane list
 * ("unknown") is never a proof.
 */
export function shouldSettleGonePane(job: Job, state: PaneState): boolean {
	return isActive(job) && job.pendingStop === null && job.paneId !== null && state === "gone";
}

/**
 * Create the pane check of one monitor. Call the returned function on a tick.
 * One read runs at a time, so a slow pane list does not start a second read.
 */
export function createPaneWatch(rt: WorkerRuntime, job: Job, notify: (job: Job) => void): () => void {
	let reading = false;
	return () => {
		const paneId = job.paneId;
		if (reading || paneId === null || !isActive(job) || job.pendingStop !== null) return;
		reading = true;
		void runMonitorAction(rt, job.id, async () => {
			const state = await paneState(rt, paneId);
			if (!shouldSettleGonePane(job, state)) return;
			await settleDetachedJob(rt, job);
			notify(job);
		}).finally(() => {
			reading = false;
		});
	};
}
