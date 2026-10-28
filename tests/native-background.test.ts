/**
 * The background tasks of a native run.
 *
 * A background call opens a row of kind background. The return of the call
 * does not settle that row. The notification of the task settles it, and so
 * does a stop of the task. A row that the supervisor cannot link keeps its
 * state, and an open row blocks the completion of the run.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyObservation, createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import type { LifecycleDb } from "../extensions/lib/db.ts";
import { executionsOfRun } from "../extensions/lib/executions.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { recordNativeCall } from "../extensions/lib/native-ledger.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { freshDb } from "./execution-helpers.ts";

/** The call id of the background call of most tests. */
const CALL = "call-1";

/** The task id of the background call of most tests. */
const TASK = "task-1";

/** One observation of a native program. */
function observation(source: string, payload: unknown) {
	return { backend: "claude", runId: "run-1", sessionId: "session-1", source, payload };
}

/** Write one observation into the ledger of a run. */
function record(db: LifecycleDb, source: string, payload: unknown, now = 1000): void {
	recordNativeCall(db, "run-1", observation(source, payload), now);
}

/** The rows of the run of the tests. */
function rowsOf(db: LifecycleDb) {
	return executionsOfRun(db, "run-1");
}

/** Open the row of a background call. */
function openBackground(db: LifecycleDb): void {
	record(db, "tool.call.opened", { callId: CALL, tool: "Bash", background: true });
}

/**
 * Run one check against a fresh database.
 *
 * The helper closes the database and removes its directory after the check.
 */
function withRun(check: (db: LifecycleDb) => void): void {
	const { db, dir } = freshDb();
	try {
		check(db);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

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

/** A state that reports its cycle as completed. */
function completedState(runId: string) {
	const state = createClaudeRunState(runId);
	applyObservation(state, { ...observation("turn.start", { turnId: "turn-1" }), runId });
	applyObservation(state, { ...observation("turn.complete", { turnId: "turn-1", usage: null }), runId });
	applyObservation(state, {
		...observation("report", { cycleId: "turn-1", state: "completed", result: "THE-ANSWER" }),
		runId,
	});
	return state;
}

test("a background call opens a row of kind background", () => {
	withRun((db) => {
		openBackground(db);
		const rows = rowsOf(db);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].kind, "background");
		assert.equal(rows[0].state, "open");
	});
});

test("a foreground call opens a row of kind tool", () => {
	withRun((db) => {
		record(db, "tool.call.opened", { callId: CALL, tool: "Bash" });
		assert.equal(rowsOf(db)[0].kind, "tool");
	});
});

test("the return of a background call leaves its row open", () => {
	withRun((db) => {
		openBackground(db);
		record(db, "tool.call.settled", { callId: CALL }, 1100);
		const rows = rowsOf(db);
		assert.equal(rows[0].state, "open", "the task of the call still runs");
		assert.equal(rows[0].settlementEvidence, null);
	});
});

test("the return of a foreground call settles its row", () => {
	withRun((db) => {
		record(db, "tool.call.opened", { callId: CALL, tool: "Bash" });
		record(db, "tool.call.settled", { callId: CALL }, 1100);
		const rows = rowsOf(db);
		assert.equal(rows[0].state, "settled");
		assert.equal(rows[0].settlementEvidence, "tool result");
	});
});

test("a failed background call settles its row", () => {
	withRun((db) => {
		openBackground(db);
		record(db, "tool.call.failed", { callId: CALL }, 1100);
		const rows = rowsOf(db);
		assert.equal(rows[0].state, "settled");
		assert.equal(rows[0].settlementEvidence, "tool call failed");
	});
});

test("a started background task stores its task id", () => {
	withRun((db) => {
		openBackground(db);
		record(db, "background.started", { callId: CALL, taskId: TASK }, 1100);
		const rows = rowsOf(db);
		assert.equal(rows[0].jobId, TASK);
		assert.equal(rows[0].state, "open");
	});
});

test("a notification settles the row of its call", () => {
	withRun((db) => {
		openBackground(db);
		record(db, "background.settled", { callId: CALL, taskId: TASK, status: "completed" }, 1100);
		const rows = rowsOf(db);
		assert.equal(rows[0].state, "settled");
		assert.equal(rows[0].settlementEvidence, "background task completed");
	});
});

test("a failed task settles the row of its call", () => {
	withRun((db) => {
		openBackground(db);
		record(db, "background.settled", { callId: CALL, taskId: TASK, status: "failed" }, 1100);
		const rows = rowsOf(db);
		assert.equal(rows[0].state, "settled");
		assert.equal(rows[0].settlementEvidence, "background task failed");
	});
});

test("a notification without a call id leaves the row open", () => {
	withRun((db) => {
		openBackground(db);
		record(db, "background.settled", { taskId: TASK, status: "completed" }, 1100);
		assert.equal(rowsOf(db)[0].state, "open");
	});
});

test("a notification without a status leaves the row open", () => {
	withRun((db) => {
		openBackground(db);
		record(db, "background.settled", { callId: CALL, taskId: TASK }, 1100);
		assert.equal(rowsOf(db)[0].state, "open");
	});
});

test("a second notification of the same call changes nothing", () => {
	withRun((db) => {
		openBackground(db);
		record(db, "background.settled", { callId: CALL, taskId: TASK, status: "completed" }, 1100);
		record(db, "background.settled", { callId: CALL, taskId: TASK, status: "failed" }, 1200);
		assert.equal(rowsOf(db)[0].settlementEvidence, "background task completed");
	});
});

test("two background tasks settle their own rows", () => {
	withRun((db) => {
		openBackground(db);
		record(db, "tool.call.opened", { callId: "call-2", tool: "Bash", background: true });
		record(db, "background.settled", { callId: "call-2", taskId: "task-2", status: "completed" }, 1100);
		const rows = rowsOf(db);
		const first = rows.find((row) => row.callId === CALL);
		const second = rows.find((row) => row.callId === "call-2");
		assert.equal(first?.state, "open", "the other task still runs");
		assert.equal(second?.state, "settled");
	});
});

test("a stopped task settles the row of its task id", () => {
	withRun((db) => {
		openBackground(db);
		record(db, "background.started", { callId: CALL, taskId: TASK }, 1100);
		record(db, "background.stopped", { taskId: TASK }, 1200);
		const rows = rowsOf(db);
		assert.equal(rows[0].state, "settled");
		assert.equal(rows[0].settlementEvidence, "background task stopped");
	});
});

test("a stop of an unknown task changes nothing", () => {
	withRun((db) => {
		openBackground(db);
		record(db, "background.stopped", { taskId: "task-9" }, 1200);
		const rows = rowsOf(db);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].state, "open");
	});
});

test("a settled background task leaves the open calls", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("tool.call.opened", { callId: CALL, tool: "Bash" }));
	applyObservation(state, observation("background.started", { callId: CALL, taskId: TASK }));
	assert.equal(state.openCalls.size, 1);
	applyObservation(
		state,
		observation("background.settled", { callId: CALL, taskId: TASK, status: "completed" }),
	);
	assert.equal(state.openCalls.size, 0);
	assert.equal(state.backgroundSettlements, 1);
});

test("a stopped background task leaves the open calls", () => {
	const state = createClaudeRunState("run-1");
	applyObservation(state, observation("tool.call.opened", { callId: CALL, tool: "Bash" }));
	applyObservation(state, observation("background.started", { callId: CALL, taskId: TASK }));
	applyObservation(state, observation("background.stopped", { callId: CALL, taskId: TASK }));
	assert.equal(state.openCalls.size, 0);
	assert.equal(state.backgroundSettlements, 0);
});

test("a completion report waits for the row of a background task", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-bg-monitor-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	const { rt, tick } = fakeRuntime(stateDir);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		const state = completedState(job.id);
		rt.claudeStates.set(job.id, state);
		const db = rt.openDb();
		recordNativeCall(
			db,
			job.id,
			{ ...observation("tool.call.opened", { callId: CALL, tool: "Bash", background: true }), runId: job.id },
			1000,
		);
		recordNativeCall(
			db,
			job.id,
			{ ...observation("tool.call.settled", { callId: CALL }), runId: job.id },
			1100,
		);

		const notified = Promise.withResolvers<void>();
		monitorNativeJob(rt, job, () => notified.resolve());
		tick();
		assert.equal(job.status, "running", "the open row of the task keeps the worker alive");

		const settled = observation("background.settled", { callId: CALL, taskId: TASK, status: "completed" });
		recordNativeCall(db, job.id, { ...settled, runId: job.id }, 1200);
		applyObservation(state, { ...settled, runId: job.id });
		tick();
		await notified.promise;

		assert.equal(job.status, "completed", "the settled row lets the worker end");
		assert.equal(job.result, "THE-ANSWER");
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});
