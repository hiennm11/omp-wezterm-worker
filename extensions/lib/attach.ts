/**
 * The supervision of a worker that this session takes over.
 *
 * A session that owns a worker must watch it. The startup handler and the
 * takeover tool both attach to a worker, so the code of the attachment lives
 * here and both callers use it.
 */

import type { Job } from "./job.ts";
import { settleDetachedJob } from "./lifecycle.ts";
import { monitorJob } from "./monitor.ts";
import { paneState } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * Watch a worker that this session owns.
 *
 * A monitor only makes sense while the pane still exists. A pane that was
 * closed by the user ends the worker instead of hanging forever. An
 * unreadable pane list keeps the monitor, which retries any pending stop.
 */
export async function attachWorker(rt: WorkerRuntime, job: Job, notify: (job: Job) => void): Promise<void> {
	if (job.paneId === null || (await paneState(rt, job.paneId)) !== "gone") {
		monitorJob(rt, job, notify);
		return;
	}
	await settleDetachedJob(rt, job);
}
