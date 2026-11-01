/**
 * The state of a released run.
 *
 * A release gives the authority of a task away. The worker keeps running,
 * but the session that released it must not observe the worker any more.
 *
 * The state of the run lives in the runtime of the session. A release closes
 * the bridge of a native worker, closes the client of a Codex worker, and
 * removes the run state. The handover file goes too, so a worker that polls
 * it waits for its next owner.
 *
 * The release never stops the worker, never ends the app server and never
 * closes a pane. The worker lives until its next owner ends it.
 */

import { clearHandover } from "./bridge-handover.ts";
import { closeCodexClient } from "./codex-stop.ts";
import type { Job } from "./job.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * Give up the state of a run that this session released.
 *
 * The function runs after the authority moved. The session keeps no bridge,
 * no client and no run state of the worker, so no observation of the worker
 * reaches this session any more.
 */
export async function releaseRunState(rt: WorkerRuntime, job: Job): Promise<void> {
	/* The bridge of a native worker holds the observations of the run. It
	   closes with the release, so no late observation of the worker reaches
	   the state of this session. */
	const bridge = rt.bridges.get(job.id);
	if (bridge) {
		rt.bridges.delete(job.id);
		await bridge.close();
	}
	/* The client of a Codex worker holds a socket to the app server. The
	   handler of that client writes the observations of the run into the
	   ledger of the task. The socket closes with the release, so the worker
	   of the task has one writer. */
	closeCodexClient(rt, job);
	/* The run state holds the reports and the cycles of the worker. The
	   session that released the worker keeps no copy of them. */
	rt.claudeStates.delete(job.id);
	/* The handover file names the bridge of this session. It goes with the
	   release, so the worker waits for its next owner. */
	clearHandover(job.sessionDir);
}
