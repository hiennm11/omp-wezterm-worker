/**
 * The event of a cycle that needs an intervention.
 *
 * The monitor raises the event and settles the events that the transcript
 * made obsolete. This module holds both steps, so the monitor stays small.
 */

import type { CycleState } from "./cycle-state.ts";
import { raiseEvent } from "./event-wake.ts";
import type { EventCondition } from "./events.ts";
import { eventKey, resolveObsoleteEvent } from "./events.ts";
import type { Job } from "./job.ts";
import type { WorkerRuntime } from "./runtime.ts";

/**
 * The evidence id of an event of one condition.
 *
 * A thinking stall can happen again in the same cycle, after the worker made
 * progress. The id of the last transcript entry names each stall. The other
 * conditions belong to the whole cycle.
 */
export function eventEvidenceId(cycle: CycleState, condition: EventCondition): string {
	if (condition === "thinking_stall" && cycle.lastEntryId !== null) {
		return `${cycle.evidenceId}@${cycle.lastEntryId}`;
	}
	return cycle.evidenceId;
}

/** Raise the event of a cycle, and settle the events that the transcript made obsolete. */
export function settleCycleEvents(
	rt: WorkerRuntime,
	job: Job,
	cycle: CycleState,
	condition: EventCondition | null,
	now: number,
): void {
	if (condition) {
		const evidenceId = eventEvidenceId(cycle, condition);
		raiseEvent(
			rt,
			{
				id: `ev-${job.id}-${evidenceId}-${condition}`,
				key: eventKey(job.id, evidenceId, condition),
				runId: job.id,
				kind: condition,
				condition,
				payload: null,
				actionable: true,
			},
			now,
		);
	}
	const db = rt.openDb();
	if (condition !== "thinking_stall" && cycle.lastEntryId !== null) {
		resolveObsoleteEvent(
			db,
			job.id,
			eventEvidenceId(cycle, "thinking_stall"),
			"thinking_stall",
			"The transcript changed after the stall.",
			now,
		);
	}
	if (condition !== "missing_report" && condition !== "idle_after_working") {
		resolveObsoleteEvent(
			db,
			job.id,
			cycle.evidenceId,
			"missing_report",
			"The worker reported its task state.",
			now,
		);
	}
}
