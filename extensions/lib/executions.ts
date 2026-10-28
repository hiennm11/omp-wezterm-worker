/**
 * The execution ledger of one run.
 *
 * A tool call opens a row. A tool result with the same call id settles that
 * row. A result for one call never settles another call. A row that never
 * settles stays unknown, and an unknown row blocks a completion report.
 */

import type { LifecycleDb } from "./db.ts";

/**
 * The state of an execution row.
 *
 * The open state means that the call started and that no result arrived.
 * The settled state means that a result with the same call id arrived.
 * The unknown state means that the transcript shows the call without its
 * result after a crash.
 */
export type ExecutionState = "open" | "settled" | "unknown";

/** One execution row. */
export interface ExecutionRecord {
	id: string;
	runId: string;
	kind: "tool" | "background";
	toolName: string | null;
	callId: string | null;
	jobId: string | null;
	startEvidence: string;
	observation: string;
	settlementEvidence: string | null;
	state: ExecutionState;
	createdAt: number;
	updatedAt: number;
}

/**
 * Open a row for a tool call.
 *
 * The call id is the key. A second call with the same id in the same run
 * returns the row that already exists.
 */
export function openExecution(
	db: LifecycleDb,
	id: string,
	runId: string,
	kind: "tool" | "background",
	toolName: string | null,
	callId: string | null,
	jobId: string | null,
	startEvidence: string,
	observation: string,
	now: number,
): ExecutionRecord {
	return db.write(() => {
		const existing = callId ? findByCallId(db, runId, callId) : null;
		if (existing) return existing;
		db.handle
			.prepare(
				`INSERT INTO executions
				 (id, run_id, kind, tool_name, call_id, job_id, start_evidence, observation, settlement_evidence, state, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'open', ?, ?)`,
			)
			.run(id, runId, kind, toolName, callId, jobId, startEvidence, observation, now, now);
		return {
			id,
			runId,
			kind,
			toolName,
			callId,
			jobId,
			startEvidence,
			observation,
			settlementEvidence: null,
			state: "open" as const,
			createdAt: now,
			updatedAt: now,
		};
	});
}

/** The row of one call id in one run, or null. */
export function findByCallId(db: LifecycleDb, runId: string, callId: string): ExecutionRecord | null {
	const row = db.handle
		.prepare(
			`SELECT id, run_id, kind, tool_name, call_id, job_id, start_evidence, observation, settlement_evidence, state, created_at, updated_at
			 FROM executions WHERE run_id = ? AND call_id = ?`,
		)
		.get(runId, callId) as Record<string, unknown> | undefined;
	return row ? toRecord(row) : null;
}

/** The row of one background job in one run, or null. */
export function findByJobId(db: LifecycleDb, runId: string, jobId: string): ExecutionRecord | null {
	const row = db.handle
		.prepare(
			`SELECT id, run_id, kind, tool_name, call_id, job_id, start_evidence, observation, settlement_evidence, state, created_at, updated_at
			 FROM executions WHERE run_id = ? AND job_id = ?`,
		)
		.get(runId, jobId) as Record<string, unknown> | undefined;
	return row ? toRecord(row) : null;
}

/**
 * Attach a background job to the row of one call id.
 *
 * The result of a call that starts a background job names the job. The row
 * becomes a background row. A row that is not open keeps its state.
 */
export function attachJob(
	db: LifecycleDb,
	runId: string,
	callId: string,
	jobId: string,
	now: number,
): ExecutionRecord | null {
	return db.write(() => {
		const result = db.handle
			.prepare(
				`UPDATE executions
				 SET kind = 'background', job_id = ?, updated_at = ?
				 WHERE run_id = ? AND call_id = ? AND state = 'open'`,
			)
			.run(jobId, now, runId, callId);
		if (Number(result.changes) === 0) return null;
		return findByCallId(db, runId, callId);
	});
}

/**
 * Store the task id in the row of one call id.
 *
 * A native background call names its task in the result of the call. Only a
 * row of kind background takes the task id, because a foreground call has no
 * task. A call id without a row changes nothing.
 */
export function setJobIdByCallId(
	db: LifecycleDb,
	runId: string,
	callId: string,
	jobId: string,
	now: number,
): ExecutionRecord | null {
	return db.write(() => {
		const result = db.handle
			.prepare(
				`UPDATE executions
				 SET job_id = ?, updated_at = ?
				 WHERE run_id = ? AND call_id = ? AND kind = 'background'`,
			)
			.run(jobId, now, runId, callId);
		if (Number(result.changes) === 0) return null;
		return findByCallId(db, runId, callId);
	});
}

/**
 * Settle the row of one call id.
 *
 * A result for one call never settles another call. The function returns the
 * row that it settled, or null when the call id is unknown.
 */
export function settleByCallId(
	db: LifecycleDb,
	runId: string,
	callId: string,
	settlementEvidence: string,
	now: number,
): ExecutionRecord | null {
	return db.write(() => {
		const result = db.handle
			.prepare(
				`UPDATE executions
				 SET settlement_evidence = ?, state = 'settled', updated_at = ?
				 WHERE run_id = ? AND call_id = ? AND state = 'open'`,
			)
			.run(settlementEvidence, now, runId, callId);
		if (Number(result.changes) === 0) return null;
		return findByCallId(db, runId, callId);
	});
}

/**
 * Settle the row of one background job.
 *
 * The job must report that it no longer runs. A report that the job still
 * runs does not settle the row.
 */
export function settleByJobId(
	db: LifecycleDb,
	runId: string,
	jobId: string,
	settlementEvidence: string,
	now: number,
): ExecutionRecord | null {
	return db.write(() => {
		const result = db.handle
			.prepare(
				`UPDATE executions
				 SET settlement_evidence = ?, state = 'settled', updated_at = ?
				 WHERE run_id = ? AND job_id = ? AND state = 'open'`,
			)
			.run(settlementEvidence, now, runId, jobId);
		if (Number(result.changes) === 0) return null;
		return findByJobId(db, runId, jobId);
	});
}

/**
 * Mark the open rows of one run as unknown.
 *
 * The ledger sync calls this when the worker stops. The owner resolves the
 * rows that the worker left open.
 */
export function markOpenUnknown(db: LifecycleDb, runId: string, now: number): number {
	return db.write(() => {
		const result = db.handle
			.prepare("UPDATE executions SET state = 'unknown', updated_at = ? WHERE run_id = ? AND state = 'open'")
			.run(now, runId);
		return Number(result.changes);
	});
}

/** The rows of one run. */
export function executionsOfRun(db: LifecycleDb, runId: string): ExecutionRecord[] {
	const rows = db.handle
		.prepare(
			`SELECT id, run_id, kind, tool_name, call_id, job_id, start_evidence, observation, settlement_evidence, state, created_at, updated_at
			 FROM executions WHERE run_id = ? ORDER BY created_at`,
		)
		.all(runId) as Record<string, unknown>[];
	return rows.map(toRecord);
}

/**
 * The rows that block a completion report.
 *
 * An open row blocks it. An unknown row blocks it. A settled row does not.
 */
export function outstandingExecutions(db: LifecycleDb, runId: string): ExecutionRecord[] {
	return executionsOfRun(db, runId).filter((row) => row.state !== "settled");
}

/** Read one row, or null when the id is unknown. */
export function readExecution(db: LifecycleDb, id: string): ExecutionRecord | null {
	const row = db.handle
		.prepare(
			`SELECT id, run_id, kind, tool_name, call_id, job_id, start_evidence, observation, settlement_evidence, state, created_at, updated_at
			 FROM executions WHERE id = ?`,
		)
		.get(id) as Record<string, unknown> | undefined;
	return row ? toRecord(row) : null;
}

/** Build a record from a database row. */
function toRecord(row: Record<string, unknown>): ExecutionRecord {
	return {
		id: String(row.id),
		runId: String(row.run_id),
		kind: String(row.kind) as "tool" | "background",
		toolName: row.tool_name === null ? null : String(row.tool_name),
		callId: row.call_id === null ? null : String(row.call_id),
		jobId: row.job_id === null ? null : String(row.job_id),
		startEvidence: String(row.start_evidence),
		observation: String(row.observation),
		settlementEvidence: row.settlement_evidence === null ? null : String(row.settlement_evidence),
		state: String(row.state) as ExecutionState,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}
