/**
 * How a worker ends.
 *
 * A worker ends in one of three ways: it finishes, it fails, or the main
 * agent cancels it. All three go through `finalizeJob`.
 */

import { failJob, type Job, type JobStatus, type PendingStop } from "./job.ts";
import { closePaneConfirmed, killPane } from "./pane.ts";
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
 * A running worker is stopped through `stopJob`, which confirms that the pane
 * is gone before it calls this function. `closePaneOnFinish` only decides
 * whether the pane of a worker that is done is closed.
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
	// The cancel path already closed it, hence the paneClosed guard. A failed
	// kill leaves the flag false, so the status tool still shows the pane.
	if (job.paneId !== null && job.closePaneOnFinish && !job.paneClosed) {
		const failure = await killPane(rt, job.paneId);
		job.paneClosed = failure === null;
	}

	// Record the dirty state now, so the status tool can say whether the kept
	// worktree still holds something worth looking at.
	if (job.worktreePath) {
		const state = await inspectWorktree(rt, job.worktreePath);
		job.worktreeDirty = state.exists ? !state.clean : null;
	}

	rt.persist();
}

/**
 * Stop a running worker and end it only when the pane list shows its pane is gone.
 *
 * An unconfirmed stop leaves the worker `running` with `pendingStop` set, so
 * cancel can retry it and the monitor retries it on every poll. A later
 * request overwrites a pending one, because an explicit cancel wins.
 */
export async function stopJob(
	rt: WorkerRuntime,
	job: Job,
	status: PendingStop["status"],
	error: string,
): Promise<{ stopped: boolean; error: string | null }> {
	if (rt.stopping.has(job.id))
		return { stopped: false, error: "A stop of this worker is already in progress." };
	rt.stopping.add(job.id);
	try {
		job.pendingStop = { status, error, failure: job.pendingStop?.failure ?? null };
		rt.persist();
		// Kill only the pane this extension created. Never touch other panes.
		const failure = job.paneId === null ? null : await closePaneConfirmed(rt, job.paneId);
		if (failure === null) {
			// finalizeJob must not close the pane a second time.
			job.paneClosed = true;
			job.pendingStop = null;
			await finalizeJob(rt, job, status, error, job.result);
			return { stopped: true, error: null };
		}
		job.pendingStop.failure = failure;
		rt.persist();
		return { stopped: false, error: failure };
	} finally {
		rt.stopping.delete(job.id);
	}
}

export async function cancelJob(
	rt: WorkerRuntime,
	job: Job,
): Promise<{ stopped: boolean; error: string | null }> {
	return stopJob(rt, job, "cancelled", "Cancelled by the main agent");
}

/** End a restored worker whose pane is gone. A pending stop is confirmed by the missing pane. */
export async function settleDetachedJob(rt: WorkerRuntime, job: Job): Promise<void> {
	const pending = job.pendingStop;
	if (pending === null) {
		failJob(job, "Worker pane was closed before this session re-attached");
		rt.persist();
		return;
	}
	job.paneClosed = true;
	job.pendingStop = null;
	await finalizeJob(rt, job, pending.status, pending.error, job.result);
}
