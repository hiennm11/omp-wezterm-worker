/**
 * The supervision of a worker that this session takes over.
 *
 * A session that owns a worker must watch it. The startup handler and the
 * takeover tool both attach to a worker, so the code of the attachment lives
 * here and both callers use it.
 */

import { readBackend } from "./backend.ts";
import { releaseExecutionByHolder } from "./groups.ts";
import { failJob, type Job } from "./job.ts";
import { settleDetachedJob } from "./lifecycle.ts";
import { monitorJob, monitorNativeJob } from "./monitor.ts";
import { paneState } from "./pane.ts";
import { reattachNative } from "./reattach-native.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * Watch a worker that this session owns.
 *
 * A monitor only makes sense while the pane still exists. A pane that was
 * closed by the user ends the worker instead of hanging forever. An
 * unreadable pane list keeps the monitor, which retries any pending stop.
 *
 * A native worker needs a bridge of its own. A new owner starts one and
 * writes the handover file again, so the worker follows it.
 */
export async function attachWorker(rt: WorkerRuntime, job: Job, notify: (job: Job) => void): Promise<void> {
	const pane = job.paneId === null ? "gone" : await paneState(rt, job.paneId);
	if (pane === "gone") {
		await settleDetachedJob(rt, job);
		return;
	}
	if (readBackend(job) === "omp") {
		monitorJob(rt, job, notify);
		return;
	}
	try {
		await reattachNative(rt, job);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		failJob(job, `The native worker could not be attached again: ${message}`);
		releaseExecutionByHolder(rt.openDb(), job.id, Date.now());
		rt.persist();
		return;
	}
	monitorNativeJob(rt, job, notify);
}
