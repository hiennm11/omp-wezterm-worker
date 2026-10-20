/**
 * The worker model.
 *
 * A job is the record of one worker: where it runs, what it produced, and
 * what happened to it. The shape is plain data so it can be written to the
 * registry as JSON and read back by a later process.
 */

import type { Placement } from "./config.ts";
import type { UsageTotals } from "./usage.ts";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/** A stop that was requested but that the pane list has not confirmed yet. */
export interface PendingStop {
	/** The status the worker gets once the stop is confirmed. */
	status: "failed" | "cancelled";
	/** The error the worker gets once the stop is confirmed. */
	error: string;
	/** Why the last stop attempt was not confirmed. Null until an attempt fails. */
	failure: string | null;
}

export interface Job {
	id: string;
	label: string;
	task: string;
	cwd: string;
	model: string | null;
	tools: string[] | null;
	status: JobStatus;
	paneId: number | null;
	tabId: number | null;
	windowId: number | null;
	placement: Placement;
	sessionDir: string;
	sessionFile: string | null;
	createdAt: number;
	startedAt: number | null;
	finishedAt: number | null;
	result: string | null;
	error: string | null;
	worktreePath: string | null;
	worktreeBranch: string | null;
	/** Repository the isolated worktree was created from. */
	worktreeOrigin: string | null;
	/** True when the worktree held uncommitted changes when it was last checked. */
	worktreeDirty: boolean | null;
	/** Set while a stop waits for confirmation. The worker stays active until the pane is gone. */
	pendingStop: PendingStop | null;
	/** Timestamp of the last observed transcript change. */
	lastActivityAt: number;
	/** Tool the worker was running at the last observation, if any. */
	currentTool: string | null;
	/** Number of assistant turns observed so far. */
	turns: number;
	/**
	 * Number of assistant turns the transcript already held when this worker
	 * started. A resumed worker must produce a turn beyond this count before
	 * it counts as finished, otherwise the previous answer is reported as the
	 * new result.
	 */
	baselineTurns: number;
	/**
	 * Usage that the session folder already held when this run started.
	 * A resumed worker reports only what came after it.
	 */
	usageBaseline: UsageTotals | null;
	/** Number of steering messages sent into this worker. */
	steers: number;
	/** Size of the transcript at the last observation, used to detect activity. */
	lastTranscriptSize: number;
	/** Deadline for this worker, in ms. 0 means no deadline. */
	timeoutMs: number;
	/** Idle deadline for this worker, in ms. 0 means no deadline. */
	idleTimeoutMs: number;
	/** Close the pane when the worker finishes. */
	closePaneOnFinish: boolean;
	/** Set once the pane has been closed by the extension. */
	paneClosed: boolean;
}

/** A worker that has not finished yet. */
export function isActive(job: Job): boolean {
	return job.status === "running" || job.status === "queued";
}

/**
 * The active workers, other than `job`, that use the same session directory.
 *
 * A resume copies the job, so the resumed worker shares the transcript and the
 * worktree of the old one. Release those only when this list is empty.
 */
export function activeSharers(jobs: Iterable<Job>, job: Job): Job[] {
	return [...jobs].filter(
		(other) => other.id !== job.id && isActive(other) && other.sessionDir === job.sessionDir,
	);
}

/** Mark a worker failed. The caller persists the registry. */
export function failJob(job: Job, reason: string): void {
	job.status = "failed";
	job.error = reason;
	job.finishedAt = Date.now();
}

/** The fields a worker run starts with. A spawn and a resume both begin from here. */
export type RunState = Pick<
	Job,
	| "status"
	| "paneId"
	| "tabId"
	| "windowId"
	| "createdAt"
	| "startedAt"
	| "finishedAt"
	| "result"
	| "error"
	| "worktreeDirty"
	| "pendingStop"
	| "lastActivityAt"
	| "currentTool"
	| "turns"
	| "baselineTurns"
	| "usageBaseline"
	| "steers"
	| "lastTranscriptSize"
	| "paneClosed"
>;

export function freshRunState(now: number): RunState {
	return {
		status: "queued",
		paneId: null,
		tabId: null,
		windowId: null,
		createdAt: now,
		startedAt: null,
		finishedAt: null,
		result: null,
		error: null,
		worktreeDirty: null,
		pendingStop: null,
		lastActivityAt: now,
		currentTool: null,
		turns: 0,
		baselineTurns: 0,
		usageBaseline: null,
		steers: 0,
		lastTranscriptSize: 0,
		paneClosed: false,
	};
}
