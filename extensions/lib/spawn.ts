/**
 * Starting a worker.
 *
 * `spawnWorker` starts a new worker. `resumeWorker` reopens a finished one
 * from its transcript. Both build one omp command line and hand it to
 * `launchPane`.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Placement } from "./config.ts";
import { freshRunState, type Job } from "./job.ts";
import { finalizeJob } from "./lifecycle.ts";
import { launchPane } from "./pane.ts";
import { describeFailure } from "./process.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { listSessionFiles, summarizeSession } from "./transcript.ts";
import { readUsageTotals } from "./usage.ts";
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

	// Optional git worktree isolation so parallel workers never share a checkout.
	if (params.isolated ?? config.isolated) {
		try {
			const wt = await createWorktree(rt, job.cwd, jobId);
			job.worktreePath = wt.path;
			job.worktreeBranch = wt.branch;
			job.worktreeOrigin = job.cwd;
			job.cwd = wt.path;
		} catch (e) {
			await finalizeJob(rt, job, "failed", e instanceof Error ? e.message : String(e), null);
			return job;
		}
	}

	const failure = await launchPane(rt, job, ompArgv(job, null, job.task));
	if (failure) {
		await finalizeJob(rt, job, "failed", failure, null);
		return job;
	}

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

	// The resumed worker works in the same checkout, so the dirty state of
	// the previous run says nothing about this one. freshRunState resets it.
	const job: Job = {
		...source,
		id: jobId,
		label: `${source.label} (resumed)`,
		placement: params.placement ?? source.placement,
		...freshRunState(Date.now()),
	};
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
	const failure = await launchPane(rt, job, ompArgv(job, sessionFile, params.message));
	if (failure) {
		job.status = "failed";
		job.error = failure;
		job.finishedAt = Date.now();
	}
	rt.persist();
	return job;
}
