/**
 * The settling of an instruction cycle.
 *
 * A cycle ends at a verified terminal assistant boundary. The boundary must
 * hold for a while, because the worker writes its report in the turn that
 * follows its answer. A cycle that ends too early creates an event that the
 * report then resolves.
 */

import type { CallLedger } from "./calls.ts";
import { cycleEnd, cycleEvidenceId } from "./cycle.ts";

/**
 * The state of one cycle, with the time it was seen.
 */
export interface CycleState {
	/** The evidence id of the cycle start. */
	evidenceId: string;
	/** The number of the terminal assistant message, or 0 while it is open. */
	terminalTurn: number;
	/** True when the cycle holds no open tool call. */
	closed: boolean;
	/** The time when the closed state was first seen. */
	closedSince: number;
}

/**
 * Read the state of the cycle of a transcript.
 *
 * The state keeps the time when the cycle closed. A report that arrives
 * later resolves the event of that cycle.
 */
export function readCycleState(ledger: CallLedger, previous: CycleState | null, now: number): CycleState {
	const end = cycleEnd(ledger);
	const evidenceId = cycleEvidenceId(ledger);
	const closed = end.kind === "terminal";
	const terminalTurn = closed ? end.turn : 0;
	// The cycle changed. The settling time starts again.
	if (!previous || previous.evidenceId !== evidenceId || previous.terminalTurn !== terminalTurn) {
		return { evidenceId, terminalTurn, closed, closedSince: closed ? now : 0 };
	}
	return { ...previous, closed, closedSince: previous.closedSince };
}

/**
 * The time that a closed cycle must hold before it needs an intervention.
 *
 * The worker writes its report in the turn after its answer. The cycle must
 * hold for this long before the supervisor asks the owner for help.
 */
export const CYCLE_SETTLE_MS = 30_000;

/**
 * The reason a closed cycle needs an intervention, or null.
 *
 * A cycle that closed less than the settling time ago is still settling.
 * A cycle that holds a report needs no intervention.
 */
export function needsIntervention(state: CycleState, hasReport: boolean, now: number): boolean {
	if (hasReport) return false;
	if (!state.closed) return false;
	return now - state.closedSince >= CYCLE_SETTLE_MS;
}
