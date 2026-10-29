/**
 * The actions of a monitor.
 *
 * The end and the stop of a monitor write the lifecycle of a worker. Both run
 * as counted actions, so the release of the task waits for them. The release
 * moves the authority to another session, and a write after that move would
 * end a worker that another session now owns.
 *
 * The action reads the ownership row again when it starts. The check of the
 * tick is not enough, because the ownership can move between the check and
 * the start of the action.
 */

import { randomUUID } from "node:crypto";

import { monitorVerdict } from "./monitor-authority.ts";
import { taskKey } from "./owner.ts";
import { readOwnership } from "./ownership.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * Run an action of a monitor.
 *
 * The action runs only when the session holds the authority of the task. A
 * skipped action writes nothing and notifies nothing. The next tick decides
 * again.
 *
 * The name of the action names the task and the run of the action. The random
 * part keeps the names of two polls of one task apart, because two polls can
 * run at the same time.
 */
export async function runMonitorAction(
	rt: WorkerRuntime,
	jobId: string,
	action: () => Promise<void>,
): Promise<void> {
	const name = `monitor:${jobId}:${randomUUID()}`;
	await rt.runAction(name, async () => {
		const owner = readOwnership(rt.openDb(), taskKey(jobId)).owner;
		if (monitorVerdict(owner, rt.sessionId) !== "act") return;
		await action();
	});
}
