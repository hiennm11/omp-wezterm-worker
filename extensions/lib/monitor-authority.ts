/**
 * The authority of a monitor.
 *
 * A monitor ends a worker when the deadline passes. That write needs the
 * authority of the task. A session that released its task, or that lost the
 * task to another session, must not end the worker.
 *
 * The verdict is a pure function of the ownership row and the session. The
 * poll functions apply it.
 */

import type { Ownership } from "./ownership.ts";

/** What a monitor does with the worker after it read the ownership. */
export type MonitorVerdict = "act" | "wait" | "stop";

/**
 * Decide what a monitor may do with a worker.
 *
 * `act`: the session holds the authority, so the monitor may act.
 * `wait`: the release runs now, so the monitor waits. The release can fail,
 * so the monitor must not stop the worker in this phase.
 * `stop`: the session lost the task, so the monitor stops and writes nothing.
 *
 * A task without an owner and a session without an identity both give
 * `act`. A monitor must not stop a worker because the session cannot prove
 * that it holds the authority.
 */
export function monitorVerdict(owner: Ownership | null, sessionId: string | null): MonitorVerdict {
	if (owner === null || sessionId === null) return "act";
	if (owner.sessionId !== sessionId) return "stop";
	if (owner.phase === "released") return "stop";
	if (owner.phase === "releasing") return "wait";
	return "act";
}
