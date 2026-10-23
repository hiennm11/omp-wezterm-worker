/**
 * The authority of a write for a task.
 *
 * The record tools and the delivery write a row for the task of a worker.
 * Only the session that holds the authority of that task may write the row.
 * The check and the write run in one transaction, so a session that lost the
 * task writes nothing.
 */

import { controlRefusal, refusalDetails } from "./authority.ts";
import type { LifecycleDb } from "./db.ts";
import { taskKey } from "./owner.ts";
import { readOwnership } from "./ownership.ts";

/** The result of a write under the authority of a task. */
export type WriteOutcome<T> =
	| { refused: false; value: T }
	| { refused: true; refusal: string; details: Record<string, unknown> };

/**
 * Write a row for a task under the authority of that task.
 *
 * A task id of null names no task, so no authority is checked. A session
 * without an identity owns nothing, so it writes as it did before.
 */
export function writeUnderAuthority<T>(
	db: LifecycleDb,
	sessionId: string | null,
	taskId: string | null,
	write: () => T,
): WriteOutcome<T> {
	return db.write(() => {
		if (taskId === null) return { refused: false, value: write() };
		const owner = readOwnership(db, taskKey(taskId)).owner;
		const refusal = controlRefusal(owner, sessionId, taskId);
		if (refusal) {
			return { refused: true, refusal, details: refusalDetails(taskId, owner) };
		}
		return { refused: false, value: write() };
	});
}
