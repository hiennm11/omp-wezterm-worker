/**
 * The sync between a transcript and the execution ledger of a run.
 *
 * The ledger holds one row for every call that the run issued. A call that
 * has a result settles its row. A call that starts a background job stays
 * open until the transcript names the job as finished. A call that never
 * settles blocks the completion report of the run.
 */

import { type CallLedger, readCallLedger } from "./calls.ts";
import type { LifecycleDb } from "./db.ts";
import { createEvent, eventKey } from "./events.ts";
import {
	attachJob,
	type ExecutionRecord,
	executionsOfRun,
	markOpenUnknown,
	openExecution,
	outstandingExecutions,
	settleByCallId,
	settleByJobId,
} from "./executions.ts";
import { completionBlocker } from "./report-decision.ts";
import { listSessionFiles } from "./transcript.ts";

/** The name of the report tool. The report file is its own evidence. */
const REPORT_TOOL = "wezterm_worker_report";

/** The run whose ledger the sync writes. */
export interface LedgerRun {
	id: string;
	sessionDir: string;
	sessionFile: string | null;
	/** The number of assistant turns that the transcript held before the run started. */
	baselineTurns: number;
}

/**
 * Write the state of the calls of a transcript into the ledger of a run.
 *
 * A call of an earlier run opens no row. A call to the report tool opens no
 * row. Every other call opens one row. A row that already exists is written
 * only when its state changes, so a sync that changes nothing writes nothing.
 */
export function syncExecutions(
	db: LifecycleDb,
	runId: string,
	ledger: CallLedger,
	baselineTurns: number,
	now: number,
): void {
	const rows = new Map<string, ExecutionRecord>();
	for (const row of executionsOfRun(db, runId)) {
		if (row.callId !== null) rows.set(row.callId, row);
	}
	for (const call of ledger.calls) {
		if (call.turn <= baselineTurns) continue;
		if (call.name === REPORT_TOOL) continue;
		let row = rows.get(call.callId);
		if (!row) {
			row = openExecution(
				db,
				`ex-${runId}-${call.callId}`,
				runId,
				"tool",
				call.name,
				call.callId,
				null,
				`turn ${call.turn}`,
				"transcript",
				now,
			);
			rows.set(call.callId, row);
		}
		// A row that the run settled or lost keeps its state.
		if (row.state !== "open") continue;
		if (call.jobId) {
			if (row.jobId === call.jobId) continue;
			const attached = attachJob(db, runId, call.callId, call.jobId, now);
			if (attached) rows.set(call.callId, attached);
			continue;
		}
		if (!call.settled) continue;
		const settled = settleByCallId(db, runId, call.callId, "tool result", now);
		if (settled) rows.set(call.callId, settled);
	}
	for (const background of ledger.backgroundResults) {
		settleByJobId(db, runId, background.jobId, `background job ${background.status}`, now);
	}
}

/**
 * The reason that the completion report of a run cannot be accepted.
 *
 * The rows of the run decide the answer. The function returns null when
 * nothing is outstanding.
 */
export function completionBlockerOf(db: LifecycleDb, runId: string): string | null {
	const rows = outstandingExecutions(db, runId);
	const unknown = rows.filter((row) => row.state === "unknown").length;
	return completionBlocker(rows.length - unknown, unknown);
}

/**
 * The transcript of a run, or null when the run has none.
 *
 * A restored run holds the name of its transcript only when the process
 * persisted it. The session directory is the fallback.
 */
export function transcriptOf(run: LedgerRun): string | null {
	return run.sessionFile ?? listSessionFiles(run.sessionDir)[0] ?? null;
}

/**
 * Close the ledger of a run that stopped.
 *
 * The sync writes what the transcript still shows. Every row that stays open
 * becomes unknown, because the worker stopped without settling it. The run
 * gets one event that names the lost executions.
 */
export function closeLedger(db: LifecycleDb, run: LedgerRun, now: number): void {
	const file = transcriptOf(run);
	if (file) syncExecutions(db, run.id, readCallLedger(file), run.baselineTurns, now);
	const lost = markOpenUnknown(db, run.id, now);
	if (lost === 0) return;
	createEvent(
		db,
		`ev-${run.id}-ledger-execution_loss`,
		eventKey(run.id, "ledger", "execution_loss"),
		run.id,
		"execution_loss",
		"execution_loss",
		JSON.stringify({ count: lost }),
		true,
		now,
	);
}
