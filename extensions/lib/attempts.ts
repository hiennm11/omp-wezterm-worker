/**
 * The launch attempts and the capacity they hold.
 *
 * A launch can fail in a window that leaves no receipt. The pane exists but
 * the record of it is lost. The attempt keeps the state of that window, so a
 * crash does not leave a live worker without a record and does not start a
 * second worker.
 */

import type { LifecycleDb } from "./db.ts";

/**
 * The state of a launch attempt.
 *
 * The reserved state means that no command has run yet.
 * The issued state means that the command was sent and that the pane may or
 * may not exist.
 * The attached state means that the pane id and the worker identity are known.
 * The unused state means that the command failed before any worker started.
 * The unresolved state means that a crash left the attempt without a receipt.
 */
export type AttemptState = "reserved" | "issued" | "attached" | "unused" | "unresolved";

/** One launch attempt. */
export interface LaunchAttempt {
	id: string;
	jobId: string;
	state: AttemptState;
	sessionFile: string | null;
	sessionId: string | null;
	paneId: number | null;
	createdAt: number;
	updatedAt: number;
}

/**
 * Record a new attempt in the reserved state.
 *
 * The row exists before the command runs. A crash after this call leaves a
 * reserved attempt. The recovery turns it into an unused attempt.
 */
export function reserveAttempt(db: LifecycleDb, id: string, jobId: string, now: number): LaunchAttempt {
	return db.write(() => {
		db.handle
			.prepare(
				`INSERT INTO launch_attempts (id, job_id, state, created_at, updated_at)
				 VALUES (?, ?, 'reserved', ?, ?)`,
			)
			.run(id, jobId, now, now);
		return {
			id,
			jobId,
			state: "reserved" as const,
			sessionFile: null,
			sessionId: null,
			paneId: null,
			createdAt: now,
			updatedAt: now,
		};
	});
}

/**
 * Move an attempt to the issued state.
 *
 * The write happens before the command runs. A crash after the command left
 * an issued attempt, and the recovery looks for the worker.
 */
export function markIssued(db: LifecycleDb, id: string, now: number): void {
	db.write(() => {
		db.handle
			.prepare("UPDATE launch_attempts SET state = 'issued', updated_at = ? WHERE id = ?")
			.run(now, id);
	});
}

/**
 * Attach a pane receipt to an attempt.
 *
 * The receipt holds the pane id and the worker identity. The worker identity
 * is the id of the session header of the worker transcript.
 */
export function attachAttempt(
	db: LifecycleDb,
	id: string,
	paneId: number,
	sessionFile: string | null,
	sessionId: string | null,
	now: number,
): void {
	db.write(() => {
		db.handle
			.prepare(
				`UPDATE launch_attempts
				 SET state = 'attached', pane_id = ?, session_file = ?, session_id = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(paneId, sessionFile, sessionId, now, id);
	});
}

/**
 * Move an attempt to the unused state.
 *
 * The command failed before any worker started. The capacity becomes free.
 */
export function markUnused(db: LifecycleDb, id: string, now: number): void {
	db.write(() => {
		db.handle
			.prepare("UPDATE launch_attempts SET state = 'unused', updated_at = ? WHERE id = ?")
			.run(now, id);
	});
}

/**
 * Move an attempt to the unresolved state.
 *
 * The capacity stays held. The owner resolves the attempt.
 */
export function markUnresolved(db: LifecycleDb, id: string, now: number): void {
	db.write(() => {
		db.handle
			.prepare("UPDATE launch_attempts SET state = 'unresolved', updated_at = ? WHERE id = ?")
			.run(now, id);
	});
}

/** Read one attempt, or null when the id is unknown. */
export function readAttempt(db: LifecycleDb, id: string): LaunchAttempt | null {
	const row = db.handle
		.prepare(
			"SELECT id, job_id, state, session_file, session_id, pane_id, created_at, updated_at FROM launch_attempts WHERE id = ?",
		)
		.get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		id: String(row.id),
		jobId: String(row.job_id),
		state: String(row.state) as AttemptState,
		sessionFile: row.session_file === null ? null : String(row.session_file),
		sessionId: row.session_id === null ? null : String(row.session_id),
		paneId: row.pane_id === null ? null : Number(row.pane_id),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

/** Read every attempt of one job. */
export function attemptsOfJob(db: LifecycleDb, jobId: string): LaunchAttempt[] {
	const rows = db.handle
		.prepare(
			"SELECT id, job_id, state, session_file, session_id, pane_id, created_at, updated_at FROM launch_attempts WHERE job_id = ? ORDER BY created_at",
		)
		.all(jobId) as Record<string, unknown>[];
	return rows.map((row) => ({
		id: String(row.id),
		jobId: String(row.job_id),
		state: String(row.state) as AttemptState,
		sessionFile: row.session_file === null ? null : String(row.session_file),
		sessionId: row.session_id === null ? null : String(row.session_id),
		paneId: row.pane_id === null ? null : Number(row.pane_id),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	}));
}

/** The attempts that a crash left without a receipt. */
export function openAttempts(db: LifecycleDb): LaunchAttempt[] {
	const rows = db.handle
		.prepare(
			"SELECT id, job_id, state, session_file, session_id, pane_id, created_at, updated_at FROM launch_attempts WHERE state IN ('reserved', 'issued') ORDER BY created_at",
		)
		.all() as Record<string, unknown>[];
	return rows.map((row) => ({
		id: String(row.id),
		jobId: String(row.job_id),
		state: String(row.state) as AttemptState,
		sessionFile: row.session_file === null ? null : String(row.session_file),
		sessionId: row.session_id === null ? null : String(row.session_id),
		paneId: row.pane_id === null ? null : Number(row.pane_id),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	}));
}

/**
 * The attempts that still hold the shared capacity.
 *
 * A reserved attempt holds the capacity. An issued attempt holds it, because
 * the worker may exist. An unresolved attempt holds it, because the owner has
 * not decided yet. An attached attempt holds the capacity of a live worker.
 */
export function capacityHolders(db: LifecycleDb): LaunchAttempt[] {
	const rows = db.handle
		.prepare(
			"SELECT id, job_id, state, session_file, session_id, pane_id, created_at, updated_at FROM launch_attempts WHERE state IN ('reserved', 'issued', 'unresolved', 'attached') ORDER BY created_at",
		)
		.all() as Record<string, unknown>[];
	return rows.map((row) => ({
		id: String(row.id),
		jobId: String(row.job_id),
		state: String(row.state) as AttemptState,
		sessionFile: row.session_file === null ? null : String(row.session_file),
		sessionId: row.session_id === null ? null : String(row.session_id),
		paneId: row.pane_id === null ? null : Number(row.pane_id),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	}));
}
