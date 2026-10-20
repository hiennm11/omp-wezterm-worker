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
