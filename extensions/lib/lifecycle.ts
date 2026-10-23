/**
 * How a worker ends.
 *
 * A worker ends in one of three ways: it finishes, it fails, or the main
 * agent cancels it. All three go through `finalizeJob`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { clearHandover } from "./bridge-handover.ts";
import type { BridgeState } from "./claude-bridge.ts";
import { releaseExecutionByHolder } from "./groups.ts";
import { failJob, type Job, type JobStatus, type PendingStop } from "./job.ts";
import { closeLedger, completionBlockerOf } from "./ledger-sync.ts";
import { closePaneConfirmed, killPane } from "./pane.ts";
import { reportState } from "./report-decision.ts";
import { readReports } from "./report-store.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { confirmStopIntent, failStopIntent, recordStopIntent } from "./stop-intent.ts";
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

	// A run that holds a resource group frees it when the run ends and its
	// pane is gone. A live pane can still write into the shared transcript,
	// so the group stays held until the pane dies.
	if (job.paneId === null || job.paneClosed) {
		releaseExecutionByHolder(rt.openDb(), job.id, Date.now());
	}

	// A worker that did not complete may leave an execution open. The ledger
	// of the run names the loss, so the owner can resolve it. A completed
	// worker holds no outstanding row, so it needs no close. The close runs
	// after the pane died, so the transcript holds the last state of the
	// worker. A native worker writes no transcript, so the close of its
	// ledger must not wait for one.
	if (status !== "completed") {
		closeLedger(rt.openDb(), job, Date.now());
	}

	// Record the dirty state now, so the status tool can say whether the kept
	// worktree still holds something worth looking at.
	if (job.worktreePath) {
		const state = await inspectWorktree(rt, job.worktreePath);
		job.worktreeDirty = state.exists ? !state.clean : null;
	}

	// The bridge of a native worker belongs to this run. It closes with the
	// run, so the loopback port is released and no late observation of the
	// dead session reaches the state.
	const bridge = rt.bridges.get(job.id);
	if (bridge) {
		rt.bridges.delete(job.id);
		await bridge.close();
		writeBridgeLog(job.sessionDir, bridge);
		/* The handover file names the bridge of this run. It goes with the
		   run, so a worker that outlives the run finds no owner. */
		clearHandover(job.sessionDir);
	}
	/* The run state holds the usage and the cycles of a native run. The
	   job keeps a copy, so a finished run stays readable. */
	const state = rt.claudeStates.get(job.id);
	if (state) {
		job.nativeUsage = { ...state.usage };
		job.nativeCycles = state.cycles.length;
	}
	rt.claudeStates.delete(job.id);

	rt.persist();
}

/**
 * Save the record of a bridge beside the run.
 *
 * The record holds the observations of the run and the requests that the
 * worker made. It is the evidence of what the native program sent.
 */
function writeBridgeLog(sessionDir: string, bridge: BridgeState): void {
	const lines = bridge.observations.map((observation) => JSON.stringify(observation));
	try {
		writeFileSync(join(sessionDir, ".wezterm-worker-bridge.jsonl"), `${lines.join("\n")}\n`, "utf8");
	} catch {
		/* the record is a convenience, never a requirement */
	}
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
		// The intent is stored before the destructive command runs. A crash
		// after the command leaves a pending intent, and a recovered owner
		// reconciles it before it steers, resumes, or cleans up.
		const intentId = `stop-${job.id}`;
		recordStopIntent(rt.openDb(), intentId, job.id, status, error, Date.now());
		// Kill only the pane this extension created. Never touch other panes.
		const failure = job.paneId === null ? null : await closePaneConfirmed(rt, job.paneId);
		if (failure === null) {
			// finalizeJob must not close the pane a second time.
			job.paneClosed = true;
			job.pendingStop = null;
			confirmStopIntent(rt.openDb(), intentId, Date.now());
			await finalizeJob(rt, job, status, error, job.result);
			return { stopped: true, error: null };
		}
		job.pendingStop.failure = failure;
		failStopIntent(rt.openDb(), intentId, Date.now());
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

/**
 * End a restored worker whose pane is gone. A pending stop is confirmed by the missing pane.
 *
 * Without a pending stop, a completion report on disk still proves that the
 * task finished (ADR 0001). The same blocker as the live monitor applies, so
 * the recovery path never completes a worker that the monitor would refuse.
 */
export async function settleDetachedJob(rt: WorkerRuntime, job: Job): Promise<void> {
	const pending = job.pendingStop;
	if (pending === null) {
		// The pane is gone, so the worker stopped. Its ledger closes now, and
		// the rows that never settled become unknown.
		const db = rt.openDb();
		closeLedger(db, job, Date.now());
		const { state, result } = reportState(readReports(job.sessionDir, job.id));
		if (state === "completed") {
			const blocker = completionBlockerOf(db, job.id);
			if (!blocker) {
				job.paneClosed = true;
				await finalizeJob(rt, job, "completed", null, result ?? "");
				return;
			}
			failJob(job, `Worker pane was closed before this session re-attached. ${blocker}`);
			releaseExecutionByHolder(db, job.id, Date.now());
			rt.persist();
			return;
		}
		failJob(job, "Worker pane was closed before this session re-attached");
		releaseExecutionByHolder(db, job.id, Date.now());
		rt.persist();
		return;
	}
	job.paneClosed = true;
	job.pendingStop = null;
	await finalizeJob(rt, job, pending.status, pending.error, job.result);
}
