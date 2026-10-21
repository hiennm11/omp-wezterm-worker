/**
 * The decision that the reports of a worker produce.
 *
 * A report is the only evidence that proves a task state. The decision is a
 * pure function of the reports and the call ledger, so a test can check it
 * without a pane.
 */

import type { CallLedger } from "./calls.ts";
import { cycleEnd, cycleEvidenceId } from "./cycle.ts";
import type { WorkerReport } from "./report-model.ts";

/** The task state that the reports prove. */
export type TaskState = "working" | "waiting" | "needs_input" | "completed" | "unknown";

/** The decision that the reports produce. */
export interface ReportDecision {
	/** The state that the last valid report proves. */
	state: TaskState;
	/** The result of the last completed report, when there is one. */
	result: string | null;
	/** The condition that needs an intervention, or null. */
	condition: "missing_report" | "idle_after_working" | null;
	/** The evidence id of the cycle that the decision looks at. */
	evidenceId: string;
}

/**
 * The state of the reports.
 *
 * A report of an unknown state does not prove anything. The last valid report
 * wins.
 */
export function reportState(reports: WorkerReport[]): { state: TaskState; result: string | null } {
	let state: TaskState = "unknown";
	let result: string | null = null;
	for (const report of reports) {
		if (report.state === "completed") {
			state = "completed";
			result = report.result;
			continue;
		}
		if (report.state === "working" || report.state === "waiting" || report.state === "needs_input") {
			state = report.state;
			result = null;
		}
	}
	return { state, result };
}

/**
 * Decide the state of a run from its reports and its transcript.
 *
 * A cycle that holds a report needs no intervention. A cycle that holds no
 * report needs one. Ordinary text after a report does not remove it.
 */
export function decideFromReports(ledger: CallLedger, reports: WorkerReport[]): ReportDecision {
	const evidenceId = cycleEvidenceId(ledger);
	const { state, result } = reportState(reports);
	const hasReport = state !== "unknown";

	// A cycle with an open call has not ended. The worker is still working.
	const end = cycleEnd(ledger);
	if (end.kind === "open") {
		return { state, result, condition: null, evidenceId };
	}

	// A report inside the cycle satisfies the report rule.
	if (hasReport) {
		// A working report followed by a verified idle execution is a
		// separate condition. It creates its own event.
		if (state === "working" && end.kind === "terminal") {
			return { state, result, condition: "idle_after_working", evidenceId };
		}
		return { state, result, condition: null, evidenceId };
	}

	return { state, result, condition: "missing_report", evidenceId };
}

/**
 * The reason a completion report cannot be accepted, or null.
 *
 * Known outstanding execution blocks completion. An unknown execution
 * blocks it too, because the supervisor cannot prove that the work finished.
 */
export function completionBlocker(outstanding: number, unknown: number): string | null {
	if (unknown > 0) {
		return `${unknown} execution(s) have no settlement evidence. The owner must resolve them.`;
	}
	if (outstanding > 0) {
		return `${outstanding} execution(s) are still outstanding.`;
	}
	return null;
}
