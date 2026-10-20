/**
 * How a worker ends.
 *
 * A worker ends in one of three ways: it finishes, it fails, or the main
 * agent cancels it. All three go through `finalizeJob`.
 */

import type { Job, JobStatus } from "./job.ts";
import { killPane, paneExists } from "./pane.ts";
import { delay } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { inspectWorktree } from "./worktree.ts";

/**
 * Close the worker's pane and record the final state.
 *
 * A finished worker leaves a pane behind, and a pane left behind accumulates
 * until the user closes them by hand. The pane is closed here so the terminal
 * returns to the state before the spawn.
 *
 * The pane is closed *after* the result is captured, because the transcript
 * is the result source and the worker process stops writing once its pane
 * dies.
 *
 * The isolated worktree is never removed here. A worker that committed or
 * edited something owns that output, so the checkout survives the worker and
 * is released only by wezterm_worker_cleanup.
 */
export async function finalizeJob(
	rt: WorkerRuntime,
	job: Job,
	status: JobStatus,
	error: string | null,
	result: string | null,
): Promise<void> {
	job.status = status;
	job.error = error;
	job.result = result;
	job.finishedAt = Date.now();
	rt.stopMonitor(job.id);

	// Close the pane this worker created. Only this pane id, never a sweep
	// over the pane list, so panes belonging to the user are never touched.
	// The cancel path already closed it, hence the paneClosed guard.
	if (job.paneId !== null && job.closePaneOnFinish && !job.paneClosed) {
		await killPane(rt, job.paneId);
		job.paneClosed = true;
	}

	// Record the dirty state now, so the status tool can say whether the kept
	// worktree still holds something worth looking at.
	if (job.worktreePath) {
		const state = await inspectWorktree(rt, job.worktreePath);
		job.worktreeDirty = state.exists ? !state.clean : null;
	}

	rt.persist();
}

export async function cancelJob(
	rt: WorkerRuntime,
	job: Job,
): Promise<{ paneClosed: boolean; error: string | null }> {
	job.cancelled = true;
	// Kill only the pane this extension created. Never touch other panes.
	// The pane is closed here, so finalizeJob must not close it a second time.
	let paneClosed = false;
	let error: string | null = null;
	if (job.paneId !== null) {
		error = await killPane(rt, job.paneId);
		if (error === null) {
			// The command reports success when it accepts the request. The
			// pane list is the evidence that the pane is really gone.
			for (let wait = 0; wait < 20; wait++) {
				if (!(await paneExists(rt, job.paneId))) {
					paneClosed = true;
					break;
				}
				await delay(250);
			}
			if (!paneClosed) error = "The pane of the worker is still open after the cancel.";
		}
		job.paneClosed = paneClosed;
	}
	await finalizeJob(rt, job, "cancelled", "Cancelled by the main agent", job.result);
	return { paneClosed, error };
}
