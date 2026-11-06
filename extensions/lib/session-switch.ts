/**
 * Release the previous session, then restore supervision for the new one.
 */

import { attachWorker } from "./attach.ts";
import type { EventCtx } from "./host.ts";
import { acquireTask, bindSession, maySupervise } from "./owner.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { releaseSessionTasks } from "./session-release.ts";
import { isSubagent } from "./subagent.ts";

/** Move supervision from the previous main session to the new main session. */
export async function switchSession(
	rt: WorkerRuntime,
	ctx: EventCtx,
	notify: Parameters<typeof attachWorker>[2],
): Promise<void> {
	if (isSubagent(ctx)) return;
	const released = await releaseSessionTasks(rt);
	for (const jobId of released) rt.stopMonitor(jobId);
	bindSession(rt, ctx.sessionManager);
	for (const job of rt.jobs.values()) {
		if (job.status !== "running") continue;
		const acquisition = await acquireTask(rt, job.id);
		if (!maySupervise(acquisition)) continue;
		await attachWorker(rt, job, notify);
	}
}
