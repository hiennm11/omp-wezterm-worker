/**
 * The recovery of the stored records.
 *
 * The recovery runs at startup. It reconciles the launch attempts that a
 * crash left without a receipt. It never repeats a spawn on its own.
 */

import { type AttemptState, markUnresolved, openAttempts, readAttempt } from "./attempts.ts";
import type { LifecycleDb } from "./db.ts";
import { taskKey } from "./owner.ts";
import { type Ownership, readOwnership } from "./ownership.ts";

/** The reason a recovery resolved an attempt. */
export type RecoveryOutcome =
	/** The attempt found its worker and the receipt is repaired. */
	| { kind: "attached"; attemptId: string; jobId: string; paneId: number | null }
	/** The attempt found no worker. The capacity stays held. */
	| { kind: "unresolved"; attemptId: string; jobId: string }
	/** The attempt was already settled. */
	| { kind: "settled"; attemptId: string; jobId: string; state: AttemptState };

/**
 * A worker that the recovery found.
 *
 * The pane id and the worker identity come from the process table. The
 * session id is the id of the session header of the worker transcript.
 */
export interface FoundWorker {
	jobId: string;
	paneId: number | null;
	sessionId: string | null;
	sessionFile: string | null;
}

/**
 * The worker that an attempt belongs to, or null.
 *
 * The caller reads the process table. The function only decides which of
 * the attempts the worker belongs to.
 */
export function findWorkerForAttempt(
	attempt: { id: string; jobId: string },
	workers: FoundWorker[],
): FoundWorker | null {
	return workers.find((worker) => worker.jobId === attempt.jobId) ?? null;
}

/**
 * Whether this session may reconcile the attempt.
 *
 * An attempt of a task without an ownership row belongs to every session.
 * An attempt of a task that this session owns belongs to this session.
 * An attempt of a task of another session stays with its owner. A session
 * without an identity owns no task.
 */
export function mayReconcileAttempt(
	attempt: { jobId: string },
	owner: Ownership | null,
	sessionId: string | null,
): boolean {
	// A row of another task says nothing about this attempt.
	if (owner && owner.taskKey !== taskKey(attempt.jobId)) return false;
	if (!owner) return true;
	if (!sessionId) return false;
	return owner.sessionId === sessionId;
}

/**
 * Reconcile the attempts that a crash left open.
 *
 * An attempt that finds its worker becomes attached. An attempt that finds
 * nothing becomes unresolved, and it keeps its capacity. The supervisor never
 * sends the command again.
 *
 * The session id decides which attempts this session may settle. The job id
 * limits the work to the attempts of one task.
 */
export function reconcileAttempts(
	db: LifecycleDb,
	workers: FoundWorker[],
	sessionId: string | null,
	now: number,
	jobId?: string,
): RecoveryOutcome[] {
	const outcomes: RecoveryOutcome[] = [];
	for (const attempt of openAttempts(db)) {
		if (jobId !== undefined && attempt.jobId !== jobId) continue;
		const owner = readOwnership(db, taskKey(attempt.jobId)).owner;
		if (!mayReconcileAttempt(attempt, owner, sessionId)) continue;
		const worker = findWorkerForAttempt(attempt, workers);
		if (worker) {
			db.write(() => {
				db.handle
					.prepare(
						"UPDATE launch_attempts SET state = 'attached', pane_id = ?, session_file = ?, session_id = ?, updated_at = ? WHERE id = ?",
					)
					.run(worker.paneId, worker.sessionFile, worker.sessionId, now, attempt.id);
			});
			outcomes.push({
				kind: "attached",
				attemptId: attempt.id,
				jobId: attempt.jobId,
				paneId: worker.paneId,
			});
			continue;
		}
		markUnresolved(db, attempt.id, now);
		outcomes.push({ kind: "unresolved", attemptId: attempt.id, jobId: attempt.jobId });
	}
	return outcomes;
}

/**
 * The state of one attempt, for the status tool.
 */
export function attemptSummary(db: LifecycleDb, attemptId: string): string | null {
	const attempt = readAttempt(db, attemptId);
	return attempt ? attempt.state : null;
}
