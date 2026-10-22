/**
 * The timers of a watched worker.
 *
 * A worker that ends must leave no poll behind. A poll that stays alive
 * keeps a handle on the state of a run that no longer exists.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { finalizeJob } from "../extensions/lib/lifecycle.ts";
import { monitorJob } from "../extensions/lib/monitor.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

/** A running worker that waits in its session directory. */
function runningJob(sessionDir: string): Job {
	return {
		id: "wz-timer",
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(Date.now()),
		status: "running",
		paneId: 7,
	};
}

/**
 * A runtime whose polls never run.
 *
 * The test only checks which polls exist. The handle stands for a timer
 * that never fires, so the test needs no wall-clock time.
 */
function idleRuntime(stateDir: string): WorkerRuntime {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	rt.timers = {
		setInterval: () => ({ fake: true }) as unknown as NodeJS.Timeout,
	};
	return rt;
}

test("a worker that ends leaves no poll behind", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-timer-"));
	const rt = idleRuntime(stateDir);
	try {
		const job = runningJob(join(stateDir, "sessions", "wz-timer"));
		rt.jobs.set(job.id, job);
		monitorJob(rt, job, () => {});
		assert.equal(rt.monitors.size, 2, "the worker has a transcript poll and a report poll");

		await finalizeJob(rt, job, "completed", null, "done");

		assert.equal(rt.monitors.size, 0, "the finished worker left a poll behind");
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});
