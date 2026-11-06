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
	logger?: (message: string) => void,
	eventName = "session_switch",
): Promise<void> {
	if (isSubagent(ctx)) return;
	const previousSessionId = rt.sessionId;
	const nextSessionId = ctx.sessionManager?.getSessionId?.() ?? null;
	logger?.(
		`[wezterm-worker] ${eventName} started: old session ${previousSessionId ?? "unknown"}, ` +
			`new session ${nextSessionId ?? "unknown"}, ${rt.jobs.size} task(s).`,
	);
	const released = await releaseSessionTasks(rt);
	for (const jobId of released) rt.stopMonitor(jobId);
	bindSession(rt, ctx.sessionManager);
	logger?.(
		`[wezterm-worker] ${eventName} released ${released.length} task(s): ${released.join(", ") || "none"}; ` +
			`session ${rt.sessionId ?? "unknown"} is bound.`,
	);
	for (const job of rt.jobs.values()) {
		if (job.status !== "running") continue;
		const acquisition = await acquireTask(rt, job.id);
		if (!maySupervise(acquisition)) {
			if (!acquisition.acquired) {
				logger?.(`[wezterm-worker] ${eventName} skipped task ${job.id}: ${acquisition.reason}.`);
			}
			continue;
		}
		if (acquisition.acquired) {
			logger?.(
				`[wezterm-worker] ${eventName} acquired task ${job.id}, generation ${acquisition.generation}.`,
			);
		}
		await attachWorker(rt, job, notify);
	}
}
