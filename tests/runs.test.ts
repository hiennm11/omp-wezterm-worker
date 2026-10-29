import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { loadRuns, persistRuns } from "../extensions/lib/runs.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-runs-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

/** Build a job with the fields a test needs. */
function job(overrides: Partial<Job> = {}): Job {
	return {
		...freshRunState(1000),
		id: "wz-1",
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		status: "completed",
		paneId: null,
		tabId: null,
		windowId: null,
		placement: "split",
		sessionDir: "/state/sessions/wz-1",
		sessionFile: null,
		createdAt: 1000,
		startedAt: 1001,
		finishedAt: 1002,
		result: "the answer",
		error: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		worktreeDirty: null,
		pendingStop: null,
		lastActivityAt: 1003,
		currentTool: null,
		turns: 2,
		baselineTurns: 0,
		usageBaseline: null,
		steers: 0,
		lastTranscriptSize: 10,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		paneClosed: false,
		...overrides,
	};
}

test("a finished run comes back as history", () => {
	const { db, dir } = freshDb();
	try {
		persistRuns(db, [job()]);
		const { finished, alive } = loadRuns(db);
		assert.equal(finished.length, 1);
		assert.equal(alive.length, 0);
		assert.equal(finished[0].id, "wz-1");
		assert.equal(finished[0].result, "the answer");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run that was active comes back as alive", () => {
	const { db, dir } = freshDb();
	try {
		persistRuns(db, [job({ id: "wz-live", status: "running", paneId: 3 })]);
		const { finished, alive } = loadRuns(db);
		assert.equal(finished.length, 0);
		assert.equal(alive.length, 1);
		assert.equal(alive[0].id, "wz-live");
		assert.equal(alive[0].paneId, 3);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a pending stop survives the round trip", () => {
	const { db, dir } = freshDb();
	try {
		const pendingStop = { status: "failed" as const, error: "x", failure: "y" };
		persistRuns(db, [job({ id: "wz-pending", status: "running", paneId: 3, pendingStop })]);
		const { alive } = loadRuns(db);
		assert.deepEqual(alive.find((j) => j.id === "wz-pending")?.pendingStop, pendingStop);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run without a pane comes back as history", () => {
	const { db, dir } = freshDb();
	try {
		persistRuns(db, [job({ id: "wz-orphan", status: "running", paneId: null })]);
		const { finished, alive } = loadRuns(db);
		assert.equal(alive.length, 0);
		assert.equal(finished.length, 1);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an empty database holds no runs", () => {
	const { db, dir } = freshDb();
	try {
		const { finished, alive } = loadRuns(db);
		assert.deepEqual(finished, []);
		assert.deepEqual(alive, []);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a row without a payload is skipped", () => {
	const { db, dir } = freshDb();
	try {
		db.handle
			.prepare(
				"INSERT INTO runs (id, label, task, cwd, status, session_dir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("wz-bad", "b", "t", "/c", "completed", "/s", 1);
		const { finished, alive } = loadRuns(db);
		assert.deepEqual(finished, []);
		assert.deepEqual(alive, []);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a payload of the wrong shape is skipped", () => {
	const { db, dir } = freshDb();
	try {
		db.handle
			.prepare(
				"INSERT INTO runs (id, label, task, cwd, status, session_dir, created_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run("wz-bad", "b", "t", "/c", "completed", "/s", 1, "{not json");
		const { finished } = loadRuns(db);
		assert.deepEqual(finished, []);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run that the database holds already is not written twice", () => {
	const { db, dir } = freshDb();
	try {
		persistRuns(db, [job()]);
		persistRuns(db, [job()]);
		const { finished } = loadRuns(db);
		assert.equal(finished.length, 1);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the status of a run follows the last write", () => {
	const { db, dir } = freshDb();
	try {
		persistRuns(db, [job({ status: "running" })]);
		persistRuns(db, [job({ status: "completed" })]);
		const { finished, alive } = loadRuns(db);
		assert.equal(alive.length, 0);
		assert.equal(finished.length, 1);
		assert.equal(finished[0].status, "completed");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stale running copy does not revive a finished run", () => {
	const { db, dir } = freshDb();
	try {
		persistRuns(db, [job({ status: "completed", result: "done", finishedAt: 9, paneClosed: false })]);
		// A read-only session keeps a stale copy of the run. Its write must
		// not bring the finished run back to life.
		persistRuns(db, [job({ status: "running", result: null, finishedAt: null, paneClosed: false })]);
		const { finished, alive } = loadRuns(db);
		assert.equal(alive.length, 0, "a finished run must not return to an active status");
		assert.equal(finished.length, 1);
		assert.equal(finished[0].status, "completed");
		assert.equal(finished[0].result, "done");
		assert.equal(finished[0].finishedAt, 9);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a finished run still accepts a new pane flag", () => {
	const { db, dir } = freshDb();
	try {
		persistRuns(db, [job({ status: "completed", paneClosed: false })]);
		persistRuns(db, [job({ status: "completed", paneClosed: true })]);
		const { finished } = loadRuns(db);
		assert.equal(finished.length, 1);
		assert.equal(finished[0].status, "completed");
		assert.equal(finished[0].paneClosed, true, "the new flag must be stored");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
