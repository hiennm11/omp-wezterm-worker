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
