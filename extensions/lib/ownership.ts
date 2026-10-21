/**
 * The ownership of a task.
 *
 * One main session owns a task. The owner holds a generation, so a write from
 * a previous owner is refused. The owner also holds a phase, so a release can
 * stop the external actions of the current owner before the authority moves.
 */

import type { LifecycleDb } from "./db.ts";

/** The phase of an ownership row. */
export type OwnerPhase = "active" | "releasing" | "released";

/** The ownership row of one task. */
export interface Ownership {
	taskKey: string;
	sessionId: string;
	processId: number | null;
	processStartedAt: string | null;
	generation: number;
	phase: OwnerPhase;
	updatedAt: number;
}

/** The result of a check that found no owner. */
export interface NoOwner {
	owner: null;
}

/** The result of a check that found an owner. */
export interface HasOwner {
	owner: Ownership;
}

/** The ownership row, or the fact that there is none. */
export type OwnershipLookup = NoOwner | HasOwner;

/**
 * Read the ownership row of a task.
 *
 * The key is the session identity of the main session. Two processes that
 * open the same session share the key.
 */
export function readOwnership(db: LifecycleDb, taskKey: string): OwnershipLookup {
	const row = db.handle
		.prepare(
			"SELECT task_key, session_id, process_id, process_started_at, generation, phase, updated_at FROM ownership WHERE task_key = ?",
		)
		.get(taskKey) as Record<string, unknown> | undefined;
	if (!row) return { owner: null };
	return {
		owner: {
			taskKey: String(row.task_key),
			sessionId: String(row.session_id),
			processId: row.process_id === null ? null : Number(row.process_id),
			processStartedAt: row.process_started_at === null ? null : String(row.process_started_at),
			generation: Number(row.generation),
			phase: String(row.phase) as OwnerPhase,
			updatedAt: Number(row.updated_at),
		},
	};
}

/**
 * Take the ownership of a task, or report why the caller cannot take it.
 *
 * The check and the write run in one transaction. Two processes cannot both
 * take the same task.
 */
export function acquireOwnership(
	db: LifecycleDb,
	taskKey: string,
	sessionId: string,
	processId: number | null,
	processStartedAt: string | null,
	now: number,
): { acquired: true; owner: Ownership } | { acquired: false; reason: string; owner: Ownership } {
	return db.write(() => {
		const current = readOwnership(db, taskKey);
		if (current.owner && current.owner.phase !== "released") {
			const sameSession = current.owner.sessionId === sessionId;
			const sameProcess =
				current.owner.processId !== null &&
				processId !== null &&
				current.owner.processId === processId &&
				current.owner.processStartedAt === processStartedAt;
			if (!sameSession && !sameProcess) {
				return {
					acquired: false as const,
					reason: `The task is owned by session ${current.owner.sessionId}. Take over explicitly.`,
					owner: current.owner,
				};
			}
		}
		const generation = (current.owner?.generation ?? 0) + 1;
		db.handle
			.prepare(
				`INSERT INTO ownership (task_key, session_id, process_id, process_started_at, generation, phase, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'active', ?)
				 ON CONFLICT(task_key) DO UPDATE SET
				   session_id = excluded.session_id,
				   process_id = excluded.process_id,
				   process_started_at = excluded.process_started_at,
				   generation = excluded.generation,
				   phase = 'active',
				   updated_at = excluded.updated_at`,
			)
			.run(taskKey, sessionId, processId, processStartedAt, generation, now);
		return {
			acquired: true as const,
			owner: {
				taskKey,
				sessionId,
				processId,
				processStartedAt,
				generation,
				phase: "active" as const,
				updatedAt: now,
			},
		};
	});
}

/**
 * The reason a write was refused, or null when the write may go on.
 */
export type AuthorityFailure = { ok: true; generation: number } | { ok: false; reason: string };

/**
 * Check that the caller still holds the authority of a task.
 *
 * The caller must call this inside the same transaction as the write. A
 * generation number rejects a write from a previous owner. It cannot stop an
 * external action that already started.
 */
export function checkAuthority(
	db: LifecycleDb,
	taskKey: string,
	sessionId: string,
	generation: number,
): AuthorityFailure {
	const current = readOwnership(db, taskKey);
	if (!current.owner) return { ok: false, reason: "The task has no owner." };
	if (current.owner.phase === "released") {
		return { ok: false, reason: "The owner released the task." };
	}
	if (current.owner.phase === "releasing") {
		return { ok: false, reason: "The owner is releasing the task." };
	}
	if (current.owner.sessionId !== sessionId) {
		return { ok: false, reason: "The task belongs to another session." };
	}
	if (current.owner.generation !== generation) {
		return { ok: false, reason: "The ownership moved to a new generation." };
	}
	return { ok: true, generation: current.owner.generation };
}

/**
 * Move the ownership to the releasing phase.
 *
 * The phase change and the check run in one transaction. A caller that acts
 * after this point is refused by `checkAuthority`.
 */
export function beginRelease(
	db: LifecycleDb,
	taskKey: string,
	sessionId: string,
	generation: number,
	now: number,
): AuthorityFailure {
	return db.write(() => {
		const authority = checkAuthority(db, taskKey, sessionId, generation);
		if (!authority.ok) return authority;
		db.handle
			.prepare("UPDATE ownership SET phase = 'releasing', updated_at = ? WHERE task_key = ?")
			.run(now, taskKey);
		return { ok: true as const, generation };
	});
}

/**
 * Move the ownership to the released phase.
 *
 * The caller must confirm that every external action has settled. The
 * function does not check the actions. The caller owns that check.
 */
export function commitRelease(
	db: LifecycleDb,
	taskKey: string,
	sessionId: string,
	generation: number,
	now: number,
): AuthorityFailure {
	return db.write(() => {
		const current = readOwnership(db, taskKey);
		if (!current.owner) return { ok: false, reason: "The task has no owner." };
		if (current.owner.sessionId !== sessionId || current.owner.generation !== generation) {
			return { ok: false, reason: "The ownership moved before the release finished." };
		}
		db.handle
			.prepare("UPDATE ownership SET phase = 'released', updated_at = ? WHERE task_key = ?")
			.run(now, taskKey);
		return { ok: true as const, generation };
	});
}
