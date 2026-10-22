/**
 * The events of a worker that runs a native backend.
 *
 * A native worker reports its state through its own bridge. The supervisor
 * turns the native observations into the events that the owner handles.
 *
 * The events keep the identity of the run. The key joins the run, the cycle
 * and the condition, so a recovery finds the event that exists.
 */

import type { ClaudeRunState } from "./claude-run-state.ts";
import type { LifecycleDb } from "./db.ts";
import { createEvent, eventKey, resolveObsoleteEvent } from "./events.ts";

/**
 * The condition that a permission request raises.
 *
 * A permission request is its own condition. The person answers it in the
 * pane, and the owner must know that the worker waits.
 */
export const PERMISSION_CONDITION = "permission_request";

/**
 * Record the events of a native run.
 *
 * The function creates the event of a permission request once. It resolves
 * the event when the request settles. A repeated observation never creates a
 * second event.
 */
export function recordNativeEvents(db: LifecycleDb, runId: string, state: ClaudeRunState, now: number): void {
	for (const [callId, tool] of state.openApprovals) {
		const evidenceId = `approval-${callId}`;
		const key = eventKey(runId, evidenceId, PERMISSION_CONDITION);
		createEvent(
			db,
			`ev-${runId}-${evidenceId}-${PERMISSION_CONDITION}`,
			key,
			runId,
			PERMISSION_CONDITION,
			PERMISSION_CONDITION,
			JSON.stringify({ callId, tool }),
			true,
			now,
		);
	}
	for (const callId of state.resolvedApprovals.keys()) {
		const evidenceId = `approval-${callId}`;
		resolveObsoleteEvent(
			db,
			runId,
			evidenceId,
			PERMISSION_CONDITION,
			"The person resolved the permission request in the pane.",
			now,
		);
	}
}
