/**
 * The resources that two runs of one task share.
 *
 * A resumed worker uses the transcript directory and the worktree of its
 * source run. A cleanup deletes them. Both actions must not run at the same
 * time. The group holds the reservation that keeps them apart.
 */

import type { LifecycleDb } from "./db.ts";

/**
 * The state of the execution reservation of a group.
 *
 * The free state means that no run holds the group.
 * The held state means that a run holds the group and may write.
 * The stopping state means that the run that holds it is stopping.
 * The unknown state means that a crash left the state in doubt.
 */
export type ExecutionState = "free" | "held" | "stopping" | "unknown";

/** One resource group. */
export interface ResourceGroup {
	id: string;
	sessionDir: string;
	worktreePath: string | null;
	worktreeOrigin: string | null;
	worktreeBranch: string | null;
	executionHolder: string | null;
	executionState: ExecutionState;
	disposing: boolean;
	updatedAt: number;
}

/**
 * Create a group for a spawn.
 *
 * A spawn creates the group. A resume keeps the group of its source run.
 */
export function createGroup(db: LifecycleDb, id: string, sessionDir: string, now: number): ResourceGroup {
	return db.write(() => {
		db.handle
			.prepare(
				`INSERT INTO resource_groups (id, session_dir, execution_state, disposing, updated_at)
				 VALUES (?, ?, 'free', 0, ?)
				 ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
			)
			.run(id, sessionDir, now);
		return {
			id,
			sessionDir,
			worktreePath: null,
			worktreeOrigin: null,
			worktreeBranch: null,
			executionHolder: null,
			executionState: "free" as const,
			disposing: false,
			updatedAt: now,
		};
	});
}

/** The columns of one group row. */
const GROUP_COLUMNS =
	"id, session_dir, worktree_path, worktree_origin, worktree_branch, execution_holder, execution_state, disposing, updated_at";

/** The group of one database row. */
function groupOf(row: Record<string, unknown>): ResourceGroup {
	return {
		id: String(row.id),
		sessionDir: String(row.session_dir),
		worktreePath: row.worktree_path === null ? null : String(row.worktree_path),
		worktreeOrigin: row.worktree_origin === null ? null : String(row.worktree_origin),
		worktreeBranch: row.worktree_branch === null ? null : String(row.worktree_branch),
		executionHolder: row.execution_holder === null ? null : String(row.execution_holder),
		executionState: String(row.execution_state) as ExecutionState,
		disposing: Number(row.disposing) !== 0,
		updatedAt: Number(row.updated_at),
	};
}

/** Read one group, or null when the id is unknown. */
export function readGroup(db: LifecycleDb, id: string): ResourceGroup | null {
	const row = db.handle
		.prepare(`SELECT ${GROUP_COLUMNS} FROM resource_groups WHERE id = ?`)
		.get(id) as Record<string, unknown> | undefined;
	if (!row) return null;
	return groupOf(row);
}

/** Store the worktree of a group. */
export function setGroupWorktree(
	db: LifecycleDb,
	id: string,
	worktreePath: string | null,
	worktreeOrigin: string | null,
	worktreeBranch: string | null,
	now: number,
): void {
	db.write(() => {
		db.handle
			.prepare(
				`UPDATE resource_groups
				 SET worktree_path = ?, worktree_origin = ?, worktree_branch = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(worktreePath, worktreeOrigin, worktreeBranch, now, id);
	});
}

/**
 * The reason a reservation was refused, or null when it was granted.
 */
export type ReservationResult =
	| { granted: true; group: ResourceGroup }
	| { granted: false; reason: string; group: ResourceGroup | null };

/**
 * Reserve the execution of a group for one run.
 *
 * The check and the write run in one transaction. A second run cannot take a
 * group that a first run holds.
 */
export function reserveExecution(
	db: LifecycleDb,
	groupId: string,
	runId: string,
	now: number,
): ReservationResult {
	return db.write(() => {
		const group = readGroup(db, groupId);
		if (!group) {
			return {
				granted: false as const,
				reason: "The resource group does not exist.",
				group: null,
			};
		}
		if (group.disposing) {
			return {
				granted: false as const,
				reason: "The resources of this task are being deleted. A new run cannot start.",
				group,
			};
		}
		if (group.executionState === "unknown") {
			return {
				granted: false as const,
				reason: "The state of these resources is unknown. The owner must resolve it.",
				group,
			};
		}
		if (group.executionState === "stopping") {
			return {
				granted: false as const,
				reason: "The run that holds these resources is stopping.",
				group,
			};
		}
		if (group.executionHolder !== null && group.executionHolder !== runId) {
			return {
				granted: false as const,
				reason: `The resources of this task are used by run ${group.executionHolder}.`,
				group,
			};
		}
		db.handle
			.prepare(
				"UPDATE resource_groups SET execution_holder = ?, execution_state = 'held', updated_at = ? WHERE id = ?",
			)
			.run(runId, now, groupId);
		return {
			granted: true as const,
			group: {
				...group,
				executionHolder: runId,
				executionState: "held" as const,
				updatedAt: now,
			},
		};
	});
}

/**
 * Release every group that a run holds.
 *
 * A run does not store its group id, so the release works on the holder. The
 * group of a run is the group of its source run, and the holder of the group
 * is the id of the run that reserved it.
 */
export function releaseExecutionByHolder(db: LifecycleDb, runId: string, now: number): void {
	db.write(() => {
		db.handle
			.prepare(
				`UPDATE resource_groups
				 SET execution_holder = NULL, execution_state = 'free', updated_at = ?
				 WHERE execution_holder = ?`,
			)
			.run(now, runId);
	});
}

/** The groups that a run holds. */
export function heldGroups(db: LifecycleDb): ResourceGroup[] {
	const rows = db.handle
		.prepare(`SELECT ${GROUP_COLUMNS} FROM resource_groups WHERE execution_holder IS NOT NULL`)
		.all() as Record<string, unknown>[];
	return rows.map(groupOf);
}

/** Mark the execution of a group as stopping. */
export function markExecutionStopping(db: LifecycleDb, groupId: string, now: number): void {
	db.write(() => {
		db.handle
			.prepare("UPDATE resource_groups SET execution_state = 'stopping', updated_at = ? WHERE id = ?")
			.run(now, groupId);
	});
}

/** Mark the execution of a group as unknown. */
export function markExecutionUnknown(db: LifecycleDb, groupId: string, now: number): void {
	db.write(() => {
		db.handle
			.prepare("UPDATE resource_groups SET execution_state = 'unknown', updated_at = ? WHERE id = ?")
			.run(now, groupId);
	});
}

/**
 * Mark a group as disposing.
 *
 * The caller must check that no run holds the execution and that no linked
 * event is unhandled. The marker refuses every new run against the group.
 */
export function markDisposing(db: LifecycleDb, groupId: string, now: number): void {
	db.write(() => {
		db.handle
			.prepare("UPDATE resource_groups SET disposing = 1, updated_at = ? WHERE id = ?")
			.run(now, groupId);
	});
}

/** Clear the disposal marker of a group. */
export function clearDisposing(db: LifecycleDb, groupId: string, now: number): void {
	db.write(() => {
		db.handle
			.prepare("UPDATE resource_groups SET disposing = 0, updated_at = ? WHERE id = ?")
			.run(now, groupId);
	});
}

/** The groups that a deletion left in the disposing state. */
export function disposingGroups(db: LifecycleDb): ResourceGroup[] {
	const rows = db.handle
		.prepare(`SELECT ${GROUP_COLUMNS} FROM resource_groups WHERE disposing = 1`)
		.all() as Record<string, unknown>[];
	return rows.map(groupOf);
}
