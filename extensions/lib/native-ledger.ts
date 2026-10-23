/**
 * The execution ledger of a native run.
 *
 * A native worker writes no OMP transcript, so its bridge carries the
 * evidence of its calls. An opened call opens a row. A settled call and a
 * failed call settle the row of the same call. A call that never settles
 * blocks the completion report of the run.
 */

import type { BridgeObservation } from "./claude-bridge.ts";
import { applyObservation, type ClaudeRunState } from "./claude-run-state.ts";
import type { LifecycleDb } from "./db.ts";
import { openExecution, settleByCallId } from "./executions.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The name of the report tool. The report file is its own evidence. */
const REPORT_TOOL = "wezterm_worker_report";

/** The observation that opens a row. */
const OPENED = "tool.call.opened";

/** The observation that settles a row of a call that returned. */
const SETTLED = "tool.call.settled";

/** The observation that settles a row of a call that failed. */
const FAILED = "tool.call.failed";

/**
 * Write the evidence of one native observation into the ledger of a run.
 *
 * The function is a pure function of the database and the observation. An
 * observation without a call id changes nothing. A call to the report tool
 * opens no row. A settlement of a call without a row creates no row.
 */
export function recordNativeCall(
	db: LifecycleDb,
	runId: string,
	observation: BridgeObservation,
	now: number,
): void {
	const payload = (observation.payload ?? {}) as Record<string, unknown>;
	const callId = (payload.callId as string) ?? null;
	if (!callId) return;
	const tool = (payload.tool as string) ?? "unknown";
	if (observation.source === OPENED) {
		/* The native host calls the report tool under its MCP name, so the
		   test must match the end of the name and not the whole name. */
		if (tool.endsWith(REPORT_TOOL)) return;
		openExecution(db, `ex-${runId}-${callId}`, runId, "tool", tool, callId, null, OPENED, "bridge", now);
		return;
	}
	if (observation.source === SETTLED) {
		settleByCallId(db, runId, callId, "tool result", now);
		return;
	}
	if (observation.source === FAILED) {
		settleByCallId(db, runId, callId, "tool call failed", now);
	}
}

/**
 * Apply one native observation to the state and the ledger of a run.
 *
 * The bridge calls this function for every observation of the run. A
 * database error must not reach the bridge, because the bridge serves the
 * worker that reports. The error goes to the error list of the runtime.
 */
export function observeNative(
	rt: WorkerRuntime,
	state: ClaudeRunState,
	runId: string,
	observation: BridgeObservation,
): void {
	try {
		applyObservation(state, observation);
		recordNativeCall(rt.openDb(), runId, observation, Date.now());
	} catch (e) {
		rt.errors.push(e instanceof Error ? e.message : String(e));
	}
}
