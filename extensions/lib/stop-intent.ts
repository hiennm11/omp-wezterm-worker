/**
 * The stop intents of a run.
 *
 * A destructive pane command cannot be taken back. The intent is stored
 * before the command runs. A recovered owner reads the intent before it
 * steers, resumes, or cleans up.
 */

import type { LifecycleDb } from "./db.ts";

/**
 * The state of a stop intent.
 *
 * The pending state means that the command was not confirmed yet.
 * The confirmed state means that the pane is gone.
 * The failed state means that the command did not close the pane.
 */
export type StopIntentState = "pending" | "confirmed" | "failed";

/** One stop intent. */
export interface StopIntent {
	id: string;
	runId: string;
	status: string;
	error: string;
	state: StopIntentState;
	createdAt: number;
	updatedAt: number;
}

const INSERT =
	"INSERT INTO stop_intents (id, run_id, status, error, state, created_at, updated_at) " +
	"VALUES (?, ?, ?, ?, 'pending', ?, ?) " +
	"ON CONFLICT(id) DO UPDATE SET state = 'pending', updated_at = excluded.updated_at";

const SELECT = "SELECT id, run_id, status, error, state, created_at, updated_at FROM stop_intents";

/**
 * Store a stop intent before the destructive command runs.
 *
 * The write happens first. A crash after the command leaves a pending
 * intent, and the recovery reconciles it.
 */
export function recordStopIntent(
	db: LifecycleDb,
	id: string,
	runId: string,
	status: string,
	error: string,
	now: number,
): StopIntent {
	return db.write(() => {
		db.handle.prepare(INSERT).run(id, runId, status, error, now, now);
		return { id, runId, status, error, state: "pending" as const, createdAt: now, updatedAt: now };
	});
}

/** Move a stop intent to the confirmed state. */
export function confirmStopIntent(db: LifecycleDb, id: string, now: number): void {
	db.write(() => {
		db.handle
			.prepare("UPDATE stop_intents SET state = 'confirmed', updated_at = ? WHERE id = ?")
			.run(now, id);
	});
}

/** Move a stop intent to the failed state. */
export function failStopIntent(db: LifecycleDb, id: string, now: number): void {
	db.write(() => {
		db.handle.prepare("UPDATE stop_intents SET state = 'failed', updated_at = ? WHERE id = ?").run(now, id);
	});
}

/** Read one stop intent, or null when the id is unknown. */
export function readStopIntent(db: LifecycleDb, id: string): StopIntent | null {
	const row = db.handle.prepare(`${SELECT} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		id: String(row.id),
		runId: String(row.run_id),
		status: String(row.status),
		error: String(row.error),
		state: String(row.state) as StopIntentState,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

/**
 * The stop intents that a crash left pending.
 *
 * A recovered owner reconciles these before it steers, resumes, or cleans up.
 */
export function pendingStopIntents(db: LifecycleDb): StopIntent[] {
	const rows = db.handle.prepare(`${SELECT} WHERE state = 'pending' ORDER BY created_at`).all() as Record<
		string,
		unknown
	>[];
	return rows.map(toIntent);
}

/** The stop intents of one run. */
export function stopIntentsOfRun(db: LifecycleDb, runId: string): StopIntent[] {
	const rows = db.handle.prepare(`${SELECT} WHERE run_id = ? ORDER BY created_at`).all(runId) as Record<
		string,
		unknown
	>[];
	return rows.map(toIntent);
}

/** Build a stop intent from a database row. */
function toIntent(row: Record<string, unknown>): StopIntent {
	return {
		id: String(row.id),
		runId: String(row.run_id),
		status: String(row.status),
		error: String(row.error),
		state: String(row.state) as StopIntentState,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}
