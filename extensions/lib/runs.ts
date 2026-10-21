/**
 * The worker runs in the lifecycle database.
 *
 * The old registry file was a whole-file write. Two processes that wrote it
 * at the same time lost one of the records. The database holds one row per
 * run, so a write touches one row.
 */

import type { LifecycleDb } from "./db.ts";
import type { Job, JobStatus } from "./job.ts";

/** The runs that the database holds. */
export interface RunRows {
	/** The runs that were active when the process ended. */
	alive: Job[];
	/** The runs that had already finished. */
	finished: Job[];
}

/**
 * Write the runs of this process into the database.
 *
 * A run that the database holds already is not written again. The status of
 * a finished run stays, so a recovery cannot revive it.
 */
export function persistRuns(db: LifecycleDb, jobs: Iterable<Job>): void {
	db.write(() => {
		for (const job of jobs) {
			db.handle
				.prepare(
					`INSERT INTO runs (id, label, task, cwd, status, session_dir, session_file, pane_id, resource_group, created_at, started_at, finished_at, result, error, payload)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET
					   label = excluded.label,
					   status = excluded.status,
					   session_file = excluded.session_file,
					   pane_id = excluded.pane_id,
					   started_at = excluded.started_at,
					   finished_at = excluded.finished_at,
					   result = excluded.result,
					   error = excluded.error,
					   payload = excluded.payload`,
				)
				.run(
					job.id,
					job.label,
					job.task,
					job.cwd,
					job.status,
					job.sessionDir,
					job.sessionFile,
					job.paneId,
					groupOf(job),
					job.createdAt,
					job.startedAt,
					job.finishedAt,
					job.result,
					job.error,
					JSON.stringify(job),
				);
		}
	});
}

/**
 * Read the runs of the database.
 *
 * A run that was active when the previous process ended is alive only when
 * its pane exists. A run without a pane has nothing that could be picked up
 * again, so it is history.
 */
export function loadRuns(db: LifecycleDb): RunRows {
	const rows = db.handle.prepare("SELECT id, status, payload FROM runs ORDER BY created_at").all() as Array<{
		id: string;
		status: string;
		payload: string | null;
	}>;
	const alive: Job[] = [];
	const finished: Job[] = [];
	for (const row of rows) {
		const job = jobOf(row);
		if (!job) continue;
		const active = job.status === "running" || job.status === "queued";
		if (active && job.paneId !== null) alive.push(job);
		else finished.push(job);
	}
	return { alive, finished };
}

/**
 * The resource group of a run.
 *
 * The group id names the shared resources of the task. A run that has no
 * group has no shared resources.
 */
function groupOf(job: Job): string | null {
	const payload = job as Job & { resourceGroup?: string };
	return typeof payload.resourceGroup === "string" ? payload.resourceGroup : null;
}

/**
 * The job of a database row.
 *
 * The payload holds the whole job. A row without a payload or with a
 * malformed one is skipped.
 */
function jobOf(row: { id: string; status: string; payload: string | null }): Job | null {
	if (!row.payload) return null;
	try {
		const parsed = JSON.parse(row.payload) as Job;
		if (!parsed || typeof parsed !== "object") return null;
		if (parsed.id !== row.id) return null;
		// The column holds the status of the last write. The payload holds the
		// state of that write too, but the column is the authority.
		parsed.status = row.status as JobStatus;
		return parsed;
	} catch {
		return null;
	}
}
