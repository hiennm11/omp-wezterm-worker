/**
 * The worker model.
 *
 * A job is the record of one worker: where it runs, what it produced, and
 * what happened to it. The shape is plain data so it can be written to the
 * registry as JSON and read back by a later process.
 */

import type { Placement } from "./config.ts";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
	cancelled: boolean;
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
	| "cancelled"
	| "lastActivityAt"
	| "currentTool"
	| "turns"
	| "baselineTurns"
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
		cancelled: false,
		lastActivityAt: now,
		currentTool: null,
		turns: 0,
		baselineTurns: 0,
		steers: 0,
		lastTranscriptSize: 0,
		paneClosed: false,
	};
}
