/**
 * The instruction cycle of a worker.
 *
 * A cycle starts at the accepted task instruction or at a steering input. It
 * ends at a verified terminal assistant boundary with no open tool call. The
 * cycle is the unit of the missing report rule. One assistant message is not.
 */

import type { CallLedger } from "./calls.ts";

/** The state of the worker at the end of a cycle. */
export type CycleEnd =
	/** The cycle ended at a terminal assistant message. */
	| { kind: "terminal"; turn: number }
	/** The cycle has an open tool call and cannot end yet. */
	| { kind: "open"; callId: string; name: string; turn: number }
	/** The transcript holds no assistant message yet. */
	| { kind: "empty" };

/**
 * The state of the instruction cycle of a transcript.
 *
 * The cycle starts at the last user message. It ends at the last assistant
 * message when no call of that message is open.
 */
export function cycleEnd(ledger: CallLedger): CycleEnd {
	if (ledger.turns === 0) return { kind: "empty" };
	const open = ledger.calls.find((call) => !call.settled);
	if (open) return { kind: "open", callId: open.callId, name: open.name, turn: open.turn };
	return { kind: "terminal", turn: ledger.turns };
}

/**
 * The evidence id that starts a cycle.
 *
 * The id is the entry id of the user message that started the cycle. It
 * joins the run id and the condition into the key of one event, so a recovery
 * finds the event that exists.
 */
export function cycleEvidenceId(ledger: CallLedger): string {
	return ledger.lastUserEntryId ?? `turn-${ledger.userMessages}`;
}

/**
 * The reason a cycle has no report, or null when the cycle has one.
 *
 * A cycle that holds no report needs an intervention. A cycle that holds a
 * report needs none. Ordinary text after the report does not remove it.
 */
export function missingReportCondition(ledger: CallLedger, hasReport: boolean): "missing_report" | null {
	if (hasReport) return null;
	const end = cycleEnd(ledger);
	// An open call does not close the cycle. The worker is still working.
	if (end.kind === "open") return null;
	return "missing_report";
}

/**
 * The condition of an idle worker after a working report.
 *
 * A working report followed by a verified idle execution is a separate
 * condition. It creates its own event.
 */
export function idleAfterWorkingCondition(
	ledger: CallLedger,
	lastReportState: string | null,
): "idle_after_working" | null {
	if (lastReportState !== "working") return null;
	const end = cycleEnd(ledger);
	if (end.kind !== "terminal") return null;
	return "idle_after_working";
}
