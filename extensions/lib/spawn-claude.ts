/**
 * Starting a Claude Code worker.
 *
 * A Claude worker runs a real interactive Claude Code session in a WezTerm
 * pane. The session loads a session-scoped mod. The mod carries the report
 * tool and the command bridge.
 *
 * The launch keeps the configuration of the user. It never changes a global
 * setting and never writes into the home directory of Claude Code.
 */

import { mkdirSync } from "node:fs";

import { attachAttempt, markIssued, markUnused, reserveAttempt } from "./attempts.ts";
import { handoverFile, writeHandover } from "./bridge-handover.ts";
import { startBridge } from "./claude-bridge.ts";
import { applyObservation, createClaudeRunState } from "./claude-run-state.ts";
import { checkClaude, claudeArgv, preparePlugin } from "./claude-session.ts";
import { createGroup, setGroupWorktree } from "./groups.ts";
import { freshRunState, type Job } from "./job.ts";
import { finalizeJob } from "./lifecycle.ts";
import { launchProgram } from "./pane.ts";
import type { WorkerRuntime } from "./runtime.ts";
import { writeRunContext } from "./worker-context.ts";
import { createWorktree } from "./worktree.ts";

/** The parameters of a Claude launch. */
export interface ClaudeSpawnParams {
	/** Id reserved by `admitLaunch`. */
	jobId: string;
	task: string;
	cwd: string;
	label?: string;
	model?: string | null;
	/** The id of the native session that this run uses. */
	sessionId: string;
	/** Run in an isolated git worktree. Defaults to the config. */
	isolated?: boolean;
	/** The total deadline of the run, in ms. 0 means no deadline. */
	timeoutMs?: number;
	/** Close the pane when the worker finishes. */
	closePaneOnFinish?: boolean;
}

/**
 * Start a Claude Code worker.
 *
 * The function returns the job of the run. A launch that fails leaves the
 * job failed with the reason, so the tool can report it.
 */
export async function spawnClaudeWorker(rt: WorkerRuntime, params: ClaudeSpawnParams): Promise<Job> {
	const { config } = rt;
	const { jobId } = params;
	const job: Job = {
		id: jobId,
		label: params.label || jobId,
		task: params.task,
		cwd: params.cwd,
		model: params.model ?? null,
		tools: null,
		placement: config.placement,
		sessionDir: `${config.stateDir}/sessions/${jobId}`,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: params.timeoutMs ?? config.timeoutMs,
		idleTimeoutMs: config.idleTimeoutMs,
		closePaneOnFinish: params.closePaneOnFinish ?? config.closePaneOnFinish,
		backend: "claude",
		nativeSessionId: params.sessionId,
		...freshRunState(Date.now()),
	};
	rt.jobs.set(jobId, job);
	rt.persist();

	const missing = await checkClaude(rt, config.claudeBin);
	if (missing) {
		await finalizeJob(rt, job, "failed", missing, null);
		return job;
	}

	mkdirSync(job.sessionDir, { recursive: true });
	const pluginDir = preparePlugin(job.sessionDir);

	/* The bridge holds the observations of the run and the commands of the
	   owner. It binds to the loopback interface with a random token. */
	const state = createClaudeRunState(jobId);
	rt.claudeStates.set(jobId, state);
	const bridge = await startBridge(jobId, (observation) => {
		applyObservation(state, observation);
	});
	rt.bridges.set(jobId, bridge);
	/* The worker finds its bridge through the handover file, so a new owner
	   can take over a worker that keeps running. */
	writeHandover(job.sessionDir, { url: bridge.baseUrl, token: bridge.token });

	const groupId = `grp-${jobId}`;
	writeRunContext(job.sessionDir, { runId: jobId, sourceRunId: null, resourceGroup: groupId });
	const db = rt.openDb();
	createGroup(db, groupId, job.sessionDir, Date.now());
	const attemptId = `att-${jobId}`;
	reserveAttempt(db, attemptId, jobId, Date.now());

	/* Optional git worktree isolation, so parallel workers never share a
	   checkout. A native worker writes files like any other worker, so it
	   needs the same protection. */
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
			await bridge.close();
			rt.bridges.delete(jobId);
			rt.claudeStates.delete(jobId);
			return job;
		}
	}
	setGroupWorktree(db, groupId, job.worktreePath, job.worktreeOrigin, job.worktreeBranch, Date.now());

	markIssued(db, attemptId, Date.now());
	const failure = await launchProgram(
		rt,
		job,
		rt.config.claudeBin,
		claudeArgv({
			sessionId: params.sessionId,
			pluginDir,
			model: job.model,
			cwd: job.cwd,
			task: job.task,
		}),
		{
			WEZTERM_WORKER_RUN_ID: jobId,
			WEZTERM_WORKER_URL: bridge.baseUrl,
			WEZTERM_WORKER_TOKEN: bridge.token,
			WEZTERM_WORKER_HANDOVER: handoverFile(job.sessionDir),
		},
	);
	if (failure) {
		markUnused(db, attemptId, Date.now());
		await finalizeJob(rt, job, "failed", failure, null);
		await bridge.close();
		rt.bridges.delete(jobId);
		rt.claudeStates.delete(jobId);
		return job;
	}
	attachAttempt(db, attemptId, job.paneId ?? -1, job.sessionFile, null, Date.now());
	setGroupWorktree(db, groupId, job.worktreePath, job.worktreeOrigin, job.worktreeBranch, Date.now());
	rt.persist();
	return job;
}
