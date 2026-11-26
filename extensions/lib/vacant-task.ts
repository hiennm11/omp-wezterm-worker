/**
 * The claim of a vacant task.
 *
 * A finished worker keeps an ownership row in the phase active. The row
 * names a session that no longer runs, so no session can handle the events
 * of that worker. Another session claims the task on demand.
 *
 * The claim needs two facts. The run must have ended. The owner process
 * must be confirmed gone. The lease of the session is no evidence, because
 * a process of the same session holds the lease after a restart.
 *
 * The module holds one function. Every tool that acts on a worker of
 * another session calls it once.
 */

import { ensureOwnProcessStart, previousOwnerState, taskKey } from "./owner.ts";
import { type Ownership, takeOverOwnership } from "./ownership.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The statuses of a run that ended. */
const ENDED_STATUSES = ["completed", "failed", "cancelled"];

/** The result of a claim. */
export type ClaimResult = { claimed: true; generation: number } | { claimed: false; reason: string };

/**
 * The status of the run of a worker, or null when the database holds none.
 *
 * The database holds the shared record of the run. A run that the database
 * does not hold has no state, so the caller cannot claim it.
 */
function runStatus(rt: WorkerRuntime, workerId: string): string | null {
	const row = rt.openDb().handle.prepare("SELECT status FROM runs WHERE id = ?").get(workerId) as
		| { status: string }
		| undefined;
	return row ? String(row.status) : null;
}

/**
 * Claim the task of a worker that another session owns.
 *
 * The claim happens only when the run ended and the owner process is gone.
 * Every other case keeps the task with the owner that holds it. The claim
 * uses the generation of the row that the caller read. A row that moved
 * since that read refuses the claim.
 *
 * The function returns null when there is nothing to claim. That is the case
 * when the task has no owner row, when this session holds the task, and when
 * this session has no identity.
 */
export async function claimVacantTask(
	rt: WorkerRuntime,
	workerId: string,
	owner: Ownership | null,
): Promise<ClaimResult | null> {
	const sessionId = rt.sessionId;
	if (sessionId === null || owner === null) return null;
	if (owner.sessionId === sessionId) return null;
	if (owner.phase !== "active") {
		return { claimed: false, reason: "The task is not in the phase active." };
	}
	const status = runStatus(rt, workerId);
	if (status === null || !ENDED_STATUSES.includes(status)) {
		return { claimed: false, reason: "The run did not end." };
	}
	const previous = await previousOwnerState(rt, owner);
	if (previous.state !== "gone") {
		return { claimed: false, reason: previous.reason };
	}
	/* The new row needs the start time of this process. A row without it
	   names no owner, so no session can claim the task later. */
	await ensureOwnProcessStart(rt);
	if (rt.processStartedAt === null) {
		return {
			claimed: false,
			reason: "The process table cannot give the start time of this process.",
		};
	}
	const written = takeOverOwnership(
		rt.openDb(),
		taskKey(workerId),
		sessionId,
		rt.processId,
		rt.processStartedAt,
		owner.generation,
		Date.now(),
	);
	if (!written.ok) return { claimed: false, reason: written.reason };
	return { claimed: true, generation: written.generation };
}
