/**
 * The monitor of a worker that runs a native backend.
 *
 * A native worker reports through its bridge. The report of the current cycle
 * ends the worker, and an outstanding execution row of the run blocks it.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyObservation, createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import { openExecution, settleByCallId } from "../extensions/lib/executions.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

/** A runtime whose polls run only when the test calls them. */
function fakeRuntime(stateDir: string): { rt: WorkerRuntime; tick: () => void } {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }) as never);
	rt.config.stateDir = stateDir;
	let tick: () => void = () => {};
	rt.timers = {
		setInterval: (fn) => {
			tick = fn;
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	return { rt, tick: () => tick() };
}

/** A running native worker with a session directory. */
function nativeJob(sessionDir: string): Job {
	return {
		id: "wz-1",
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
		backend: "claude",
	};
}

/** The state of a native run that reports its cycle as completed. */
function completedState(runId: string) {
	const state = createClaudeRunState(runId);
	applyObservation(state, {
		backend: "claude",
		runId,
		sessionId: null,
		source: "turn.start",
		payload: { turnId: "turn-1" },
	});
	applyObservation(state, {
		backend: "claude",
		runId,
		sessionId: null,
		source: "turn.complete",
		payload: { turnId: "turn-1", usage: null },
	});
	applyObservation(state, {
		backend: "claude",
		runId,
		sessionId: null,
		source: "report",
		payload: { cycleId: "turn-1", state: "completed", result: "THE-ANSWER" },
	});
	return state;
}

test("the native monitor keeps a worker that has an open execution row", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-monitor-native-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(stateDir);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		rt.claudeStates.set(job.id, completedState(job.id));
		const db = rt.openDb();
		openExecution(
			db,
			`ex-${job.id}-call-1`,
			job.id,
			"tool",
			"bash",
			"call-1",
			null,
			"tool.call.opened",
			"bridge",
			1000,
		);

		let ended = 0;
		monitorNativeJob(rt, job, () => {
			ended += 1;
		});
		tick();

		assert.equal(job.status, "running", "the open row keeps the worker alive");
		assert.equal(ended, 0);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("the native monitor ends a worker when its execution row settles", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-monitor-native-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(stateDir);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		rt.claudeStates.set(job.id, completedState(job.id));
		const db = rt.openDb();
		openExecution(
			db,
			`ex-${job.id}-call-1`,
			job.id,
			"tool",
			"bash",
			"call-1",
			null,
			"tool.call.opened",
			"bridge",
			1000,
		);

		const notified = Promise.withResolvers<void>();
		monitorNativeJob(rt, job, () => notified.resolve());
		tick();
		assert.equal(job.status, "running");

		settleByCallId(db, job.id, "call-1", "tool result", 1100);
		tick();
		await notified.promise;

		assert.equal(job.status, "completed", "the settled row lets the worker end");
		assert.equal(job.result, "THE-ANSWER");
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});
