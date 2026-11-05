/**
 * The decision that a closing session releases its running tasks.
 *
 * A main session that closes must give up the tasks that it still supervises.
 * The next process of the same session then adopts the running worker through
 * the existing path of a released row. See
 * docs/adr/0019-a-closing-session-releases-its-running-tasks.md.
 *
 * The decision is a pure function of the ownership row, the job list, the
 * session id, the process id and the process start time. It reads no
 * database and starts no program, so a test can prove it without a pane.
 */

import { taskKey } from "./owner.ts";
import { beginRelease, commitRelease, readOwnership } from "./ownership.ts";
import { releaseRunState } from "./release-state.ts";
import type { WorkerRuntime } from "./runtime.ts";

/** The longest wait for the external actions that already started. */
export const RELEASE_WAIT_MS = 1000;

/** The state of a worker that the runtime holds. */
export interface ReleaseJob {
	/** The id of the worker. */
	id: string;
	/** The status of the worker. */
	status: string;
}

/** The ownership row of one task. */
export interface ReleaseOwner {
	/** The session that owns the task. */
	sessionId: string;
	/** The process that owns the task. */
	processId: number | null;
	/** The start time of the process that owns the task. */
	processStartedAt: string | null;
	/** The phase of the row. */
	phase: string;
}

/** The ownership rows of the tasks, indexed by the id of the worker. */
export type ReleaseOwners = Record<string, ReleaseOwner>;

/**
 * Whether the ownership row names this process and this session.
 *
 * A row of another process stays as it is. A row of another session stays as
 * it is. A row that is not active holds no authority to give away.
 */
export function belongsToThisProcess(
	owner: ReleaseOwner,
	sessionId: string | null,
	processId: number,
	processStartedAt: string | null,
): boolean {
	if (sessionId === null) return false;
	if (owner.phase !== "active") return false;
	if (owner.sessionId !== sessionId) return false;
	if (owner.processId !== processId) return false;
	return owner.processStartedAt === processStartedAt;
}

/**
 * The ids of the tasks that the closing session releases.
 *
 * A row is released only when all three conditions hold. The session id
 * matches. The process id and the process start time match this process. The
 * job is still active.
 *
 * A row of a run that ended stays as it is. A row of another process stays as
 * it is. The row of another session stays as it is.
 */
export function releaseableJobIds(
	owners: ReleaseOwners,
	jobs: readonly ReleaseJob[],
	sessionId: string | null,
	processId: number,
	processStartedAt: string | null,
): string[] {
	const released: string[] = [];
	for (const job of jobs) {
		if (job.status !== "running" && job.status !== "queued") continue;
		if (!Object.hasOwn(owners, job.id)) continue;
		const owner = owners[job.id];
		if (!belongsToThisProcess(owner, sessionId, processId, processStartedAt)) continue;
		released.push(job.id);
	}
	return released;
}

/**
 * Wait for the external actions that already started.
 *
 * The wait ends when every action settled or when the limit passed. The
 * names of the actions that did not settle are returned, so the caller can
 * report them.
 */
export async function awaitSettledActions(rt: WorkerRuntime, limitMs: number): Promise<string[]> {
	const deadline = Date.now() + limitMs;
	while (rt.pendingActions.size > 0 && Date.now() < deadline) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 25);
		await promise;
	}
	return [...rt.pendingActions];
}

/**
 * Release the running tasks of this session.
 *
 * The rows of the workers that this session still supervises move to the
 * released phase. The next process of the same session adopts them through
 * the existing path of a released row.
 *
 * A row of a run that ended stays as it is. A row of another process stays as
 * it is. The row of another session stays as it is.
 */
export async function releaseSessionTasks(rt: WorkerRuntime): Promise<string[]> {
	const db = rt.openDb();
	const jobs = [...rt.jobs.values()];
	const owners: ReleaseOwners = {};
	for (const job of jobs) {
		const owner = readOwnership(db, taskKey(job.id)).owner;
		if (!owner) continue;
		owners[job.id] = {
			sessionId: owner.sessionId,
			processId: owner.processId,
			processStartedAt: owner.processStartedAt,
			phase: owner.phase,
		};
	}
	const ids = releaseableJobIds(owners, jobs, rt.sessionId, rt.processId, rt.processStartedAt);
	if (ids.length === 0) return [];

	// The external actions that started before the release must settle, or
	// the new owner would meet a half finished action.
	const unsettled = await awaitSettledActions(rt, RELEASE_WAIT_MS);
	if (unsettled.length > 0) {
		rt.errors.push(
			`The release of ${ids.length} task(s) went on with ${unsettled.length} action(s) that did not settle: ${unsettled.join(", ")}.`,
		);
	}

	const released: string[] = [];
	for (const id of ids) {
		const owner = readOwnership(db, taskKey(id)).owner;
		if (!owner) continue;
		const key = taskKey(id);
		const begin = beginRelease(db, key, owner.sessionId, owner.generation, Date.now());
		if (!begin.ok) {
			rt.errors.push(`The release of worker ${id} failed: ${begin.reason}`);
			continue;
		}
		const commit = commitRelease(db, key, owner.sessionId, owner.generation, Date.now());
		if (!commit.ok) {
			rt.errors.push(`The release of worker ${id} failed: ${commit.reason}`);
			continue;
		}
		const job = rt.jobs.get(id);
		if (job) await releaseRunState(rt, job);
		released.push(id);
	}
	return released;
}
