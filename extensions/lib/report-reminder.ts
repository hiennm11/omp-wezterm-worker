/**
 * The reminder for a worker that ends a cycle without a report.
 *
 * A worker often ends its turn with prose and no report. The extension
 * reminds the worker first. It wakes the owner only when the reminder fails.
 *
 * The decision is a pure function of the cycle, the reminder of the cycle and
 * the clock. A test can check it without a pane.
 */

import { settleCycleEvents } from "./cycle-event.ts";
import { CYCLE_SETTLE_MS, type CycleState } from "./cycle-state.ts";
import type { Job, MissingReportReminder } from "./job.ts";
import { runMonitorAction } from "./monitor-actions.ts";
import { sendToPane } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The action that the report tick takes for a cycle without a report. */
export type MissingReportAction = "nudge" | "wait" | "wake";

/**
 * The time that the worker gets to report after the reminder.
 *
 * The owner wakes when this time passes and no report arrives.
 */
export const MISSING_REPORT_GRACE_MS = 120_000;

/**
 * The action that a cycle without a report needs.
 *
 * A cycle that still settles waits. A settled cycle that holds no reminder
 * gets one reminder. A cycle that holds a reminder waits for the grace. A
 * cycle whose grace passed wakes the owner.
 *
 * The reminder belongs to the cycle that received it. A new cycle gets its
 * own reminder.
 */
export function missingReportAction(
	state: CycleState,
	reminder: MissingReportReminder | null,
	now: number,
): MissingReportAction {
	if (!state.closed) return "wait";
	if (now - state.closedSince < CYCLE_SETTLE_MS) return "wait";
	if (!reminder || reminder.evidenceId !== state.evidenceId) return "nudge";
	if (now - reminder.sentAt >= MISSING_REPORT_GRACE_MS) return "wake";
	return "wait";
}

/**
 * The text of the reminder.
 *
 * The text says that the turn ended without a report. It names the report
 * tool with the state and the result that the worker must send.
 */
export function reminderText(jobId: string): string {
	return [
		`Worker ${jobId}: your last turn ended without a report.`,
		"Call the tool `wezterm_worker_report` with the state of your task and the result.",
		"The report call is the last action of a cycle. Your answer text proves nothing.",
	].join("\n");
}

/**
 * Settle a cycle that ended without a report.
 *
 * The function sends one reminder into the pane of the worker. It keeps the
 * reminder on the job, so a later tick sends nothing and a restart sends
 * nothing. The owner wakes when the grace passes and no report arrives.
 */
export function settleMissingReport(
	rt: WorkerRuntime,
	job: Job,
	cycle: CycleState,
	now: number,
): MissingReportAction {
	const action = missingReportAction(cycle, job.missingReportReminder ?? null, now);
	if (action === "nudge") {
		// The reminder belongs to the cycle. The job holds it, so a later tick
		// and a restart send nothing.
		job.missingReportReminder = { evidenceId: cycle.evidenceId, sentAt: now };
		rt.persist();
		void runMonitorAction(rt, job.id, async () => {
			const sent = await sendToPane(rt, job, reminderText(job.id));
			if (sent.ok) return;
			rt.errors.push(sent.error ?? `The reminder for worker ${job.id} failed.`);
		});
		// No report arrived, so the event of the cycle stays unresolved.
		settleCycleEvents(rt, job, cycle, null, now, true);
		return action;
	}
	if (action === "wait") {
		settleCycleEvents(rt, job, cycle, null, now, true);
		return action;
	}
	settleCycleEvents(rt, job, cycle, "missing_report", now);
	return action;
}
