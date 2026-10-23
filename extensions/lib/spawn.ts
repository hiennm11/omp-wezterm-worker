/**
 * Starting a worker.
 *
 * `spawnWorker` starts a new worker. `resumeWorker` reopens a finished one
 * from its transcript. Both build one omp command line and hand it to
 * `launchPane`.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { attachAttempt, markIssued, markUnused, reserveAttempt } from "./attempts.ts";
import { bootstrapPromptFile, writeBootstrapPrompt } from "./bootstrap-prompt.ts";
import type { Placement } from "./config.ts";
import { createGroup, releaseExecutionByHolder, reserveExecution, setGroupWorktree } from "./groups.ts";
import { freshRunState, type Job } from "./job.ts";
import { finalizeJob } from "./lifecycle.ts";
import { launchPane } from "./pane.ts";
import { describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { listSessionFiles, summarizeSession } from "./transcript.ts";
import { readUsageTotals } from "./usage.ts";
import { writeRunContext } from "./worker-context.ts";
import { createWorktree } from "./worktree.ts";

export interface SpawnParams {
	/** Id reserved by `admitLaunch`. */
	jobId: string;
	task: string;
	cwd?: string;
	label?: string;
	model?: string;
	tools?: string[];
	placement?: Placement;
	isolated?: boolean;
	/** Overrides the configured timeout for this worker. 0 means no timeout. */
	timeoutMs?: number;
	/** Close the worker pane when the worker finishes. Defaults to the config. */
	closePaneOnFinish?: boolean;
}

/**
 * The omp argv. Every value is its own argv element.
 *
 * `trailing` is the task or the follow-up message. It is a single element:
 * no shell parses it, so there are no quoting hazards.
 */
function ompArgv(job: Job, resumeFile: string | null, trailing: string | undefined): string[] {
	const args = ["--no-title", "--cwd", job.cwd, "--session-dir", job.sessionDir];
	// The worker reports its task state. The prompt tells it how. Without the
	// prompt the worker never reports, and the supervisor cannot tell a
	// finished task from a silent one.
	const prompt = bootstrapPromptFile(job.sessionDir);
	if (existsSync(prompt)) args.push("--append-system-prompt", prompt);
	if (resumeFile) args.push("--resume", resumeFile);
	if (job.model) args.push("--model", job.model);
	if (job.tools?.length) args.push("--tools", job.tools.join(","));
	if (trailing) args.push(trailing);
	return args;
}

export async function spawnWorker(rt: WorkerRuntime, params: SpawnParams): Promise<Job> {
	const { config } = rt;
	const { jobId } = params;
	const job: Job = {
		id: jobId,
		label: params.label || jobId,
		task: params.task,
		cwd: resolve(params.cwd || config.defaultCwd),
		model: params.model ?? config.model,
		tools: params.tools ?? config.tools,
		placement: params.placement || config.placement,
		sessionDir: join(config.stateDir, "sessions", jobId),
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: params.timeoutMs ?? config.timeoutMs,
		idleTimeoutMs: config.idleTimeoutMs,
		closePaneOnFinish: params.closePaneOnFinish ?? config.closePaneOnFinish,
		...freshRunState(Date.now()),
	};
	rt.jobs.set(jobId, job);
	rt.persist();

	if (!existsSync(job.cwd)) {
		await finalizeJob(rt, job, "failed", `cwd does not exist: ${job.cwd}`, null);
		return job;
	}

	// Pre-flight the omp binary. A worker that cannot start leaves an empty
	// pane and never writes a transcript, so failing here reports the real
	// cause instead of a generic startup timeout.
	const ompCheck = await rt.exec(config.ompBin, ["--version"]);
	if (ompCheck.code !== 0) {
		const reason = `Cannot run the omp binary '${config.ompBin}': ${describeFailure(ompCheck)}`;
		await finalizeJob(rt, job, "failed", reason, null);
		return job;
	}

	mkdirSync(job.sessionDir, { recursive: true });

	// The run context binds the worker to its run. The worker bootstrap reads
	// this file, so a report from the worker names the run that produced it.
	const groupId = `grp-${jobId}`;
	writeRunContext(job.sessionDir, { runId: jobId, sourceRunId: null, resourceGroup: groupId });
	// The worker gets the reporting contract. The file stays as the evidence
	// of the contract that the worker received.
	writeBootstrapPrompt(job.sessionDir);

	// The launch attempt keeps the state of the window between the pane
	// creation and the receipt. A crash in that window leaves an attempt
	// without a receipt, and the recovery looks for the worker.
	const db = rt.openDb();
	createGroup(db, groupId, job.sessionDir, Date.now());
	const attemptId = `att-${jobId}`;
	reserveAttempt(db, attemptId, jobId, Date.now());

	// Optional git worktree isolation so parallel workers never share a checkout.
	if (params.isolated ?? config.isolated) {
		try {
			const wt = await createWorktree(rt, job.cwd, jobId);
			job.worktreePath = wt.path;
			job.worktreeBranch = wt.branch;
			job.worktreeOrigin = job.cwd;
			job.cwd = wt.path;
		} catch (e) {
			markUnused(db, attemptId, Date.now());
			await finalizeJob(rt, job, "failed", e instanceof Error ? e.message : String(e), null);
			return job;
		}
	}
	setGroupWorktree(db, groupId, job.worktreePath, job.worktreeOrigin, job.worktreeBranch, Date.now());

	// The attempt is issued before the command runs. A crash after the
	// command leaves an issued attempt, and the recovery finds the worker.
	markIssued(db, attemptId, Date.now());
	// The worker process needs to know that it is a worker. The environment
	// variable names its session directory, and the run context in that
	// directory names the run.
	const failure = await launchPane(rt, job, ompArgv(job, null, job.task), {
		OMP_WORKER_SESSION_DIR: job.sessionDir,
	});
	if (failure) {
		markUnused(db, attemptId, Date.now());
		await finalizeJob(rt, job, "failed", failure, null);
		return job;
	}
	attachAttempt(db, attemptId, job.paneId ?? -1, job.sessionFile, null, Date.now());

	// Persist again now that the pane id is known. The first write happened
	// before the pane existed, so without this the registry would record a
	// running worker with no pane, and a restart could not re-attach to it.
	// The isolated worktree stays: it is the worker's checkout and holds
	// whatever it produced; wezterm_worker_cleanup releases it later.
	rt.persist();
	return job;
}

/**
 * Reopen a finished worker from its transcript.
 *
 * `omp --resume <path>` continues the session file, so the worker comes back
 * with its full history: the previous task, the previous answers, and any
 * steering messages already sent. The new process writes into the same
 * session directory, so the monitor keeps reading the same transcript.
 *
 * This is the only way to continue a worker that already completed: a
 * finished worker has no live composer to type into, and steering requires a
 * running pane.
 */
export async function resumeWorker(
	rt: WorkerRuntime,
	source: Job,
	params: { jobId: string; message?: string; placement?: Placement },
): Promise<Job> {
	const { jobId } = params;
	const sessionFile = source.sessionFile;
	if (!sessionFile || !existsSync(sessionFile)) {
		const failed: Job = {
			...source,
			...freshRunState(Date.now()),
			id: jobId,
			status: "failed",
			error: `The worker has no transcript to resume: ${source.sessionFile ?? "(none)"}`,
			finishedAt: Date.now(),
		};
		rt.jobs.set(jobId, failed);
		return failed;
	}

	// The resumed worker works in the same checkout, so the dirty state of the
	// previous run says nothing about this one. freshRunState resets it.
	const job: Job = {
		...source,
		id: jobId,
		label: `${source.label} (resumed)`,
		placement: params.placement ?? source.placement,
		...freshRunState(Date.now()),
	};

	// The resumed run shares the transcript and the worktree of its source
	// run. It reserves the group before it reads the baseline and before it
	// starts a pane, so a cleanup cannot delete the resources under it.
	const db = rt.openDb();
	const groupId = `grp-${source.id}`;
	const reservation = reserveExecution(db, groupId, jobId, Date.now());
	if (!reservation.granted) {
		const failed: Job = {
			...job,
			status: "failed",
			error: reservation.reason,
			finishedAt: Date.now(),
		};
		rt.jobs.set(jobId, failed);
		return failed;
	}

	// The run context names the new run and keeps the group of the source.
	writeRunContext(job.sessionDir, {
		runId: jobId,
		sourceRunId: source.id,
		resourceGroup: groupId,
	});
	rt.jobs.set(jobId, job);

	// The transcript already holds the earlier turns. Record how many, so the
	// monitor only reports completion once the worker has produced a turn
	// beyond that count. Without this the previous answer is delivered as the
	// new result before the worker has done any work.
	const existing = listSessionFiles(job.sessionDir);
	if (existing.length > 0) {
		try {
			const summary = summarizeSession(existing[0]);
			job.baselineTurns = summary.turns;
			job.turns = summary.turns;
			job.lastTranscriptSize = statSync(existing[0]).size;
		} catch {
			/* an unreadable transcript just means no baseline */
		}
	}
	// The token baseline is read before the pane starts, so the turns of the
	// new run do not land in the baseline.
	job.usageBaseline = readUsageTotals(job.sessionDir);
	rt.persist();

	// The task is not repeated: the transcript already holds it. A follow-up
	// message restarts the turn; without one the worker opens on its
	// transcript and waits.
	const attemptId = `att-${jobId}`;
	reserveAttempt(db, attemptId, jobId, Date.now());
	markIssued(db, attemptId, Date.now());
	const failure = await launchPane(rt, job, ompArgv(job, sessionFile, params.message), {
		OMP_WORKER_SESSION_DIR: job.sessionDir,
	});
	if (failure) {
		markUnused(db, attemptId, Date.now());
		job.status = "failed";
		job.error = failure;
		job.finishedAt = Date.now();
		// The run never reached a pane, so it holds nothing. The group of the
		// source run becomes free again.
		releaseExecutionByHolder(db, jobId, Date.now());
	}
	attachAttempt(db, attemptId, job.paneId ?? -1, job.sessionFile, null, Date.now());
	rt.persist();
	return job;
}
