import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markIssued, readAttempt, reserveAttempt } from "../extensions/lib/attempts.ts";
import { jobIdOfCommandLine, workersOf } from "../extensions/lib/correlation.ts";
import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { parseProcessRows } from "../extensions/lib/process-table.ts";
import { mayReconcileAttempt, reconcileAttempts } from "../extensions/lib/recovery.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-recovery-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

/** The ownership row of a task that a session owns. */
function seedOwner(db: LifecycleDb, jobId: string, sessionId: string): void {
	acquireOwnership(db, taskKey(jobId), sessionId, 500, "2026-10-23T01:00:00.000Z", 1000);
}

/** The state of an attempt, or null when the id is unknown. */
function stateOf(db: LifecycleDb, id: string): string | null {
	return readAttempt(db, id)?.state ?? null;
}

test("the job id comes from the session directory of the command line", () => {
	const line = "omp.exe --no-title --cwd C:\\repo --session-dir C:\\state\\sessions\\wz-abc123";
	assert.equal(jobIdOfCommandLine(line), "wz-abc123");
});

test("a command line without a worker session directory gives no job", () => {
	assert.equal(jobIdOfCommandLine("omp.exe --no-title --cwd C:\\repo"), null);
});

test("the process table gives the workers and ignores the other processes", () => {
	const rows = parseProcessRows(
		JSON.stringify([
			{ ProcessId: 1, CommandLine: "omp.exe --session-dir C:\\state\\sessions\\wz-a1" },
			{ ProcessId: 2, CommandLine: "omp.exe __omp_worker_daemon_broker" },
			{ ProcessId: 3, CommandLine: "pwsh.exe" },
		]),
	);
	const workers = workersOf(rows);
	assert.equal(workers.length, 1);
	assert.equal(workers[0].jobId, "wz-a1");
});

test("a crash after the pane creation recovers the worker without a duplicate", () => {
	const { db, dir } = freshDb();
	try {
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		const outcomes = reconcileAttempts(
			db,
			[{ jobId: "wz-1", paneId: 42, sessionId: "s-1", sessionFile: "C:/state/wz-1.jsonl" }],
			"session-new",
			1002,
		);
		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0].kind, "attached");
		assert.equal(outcomes[0].paneId, 42);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an attempt that finds no worker stays unresolved", () => {
	const { db, dir } = freshDb();
	try {
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		const outcomes = reconcileAttempts(db, [], "session-new", 1002);
		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0].kind, "unresolved");
		const rows = db.handle.prepare("SELECT state FROM launch_attempts").all();
		assert.equal(rows.length, 1);
		const row = rows[0];
		assert.ok(row && typeof row === "object" && "state" in row);
		assert.equal(row.state, "unresolved");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the recovery never sends the command again", () => {
	const { db, dir } = freshDb();
	try {
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		reconcileAttempts(db, [], "session-new", 1002);
		// A second recovery finds no open attempt, so it does nothing.
		const again = reconcileAttempts(db, [], "session-new", 1100);
		assert.equal(again.length, 0);
		const rows = db.handle.prepare("SELECT COUNT(*) AS n FROM launch_attempts").all();
		const row = rows[0];
		assert.ok(row && typeof row === "object" && "n" in row);
		assert.equal(Number(row.n), 1, "no second attempt was created");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the attempt of a task of another session stays issued", () => {
	const { db, dir } = freshDb();
	try {
		seedOwner(db, "wz-1", "session-old");
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		const outcomes = reconcileAttempts(
			db,
			[{ jobId: "wz-1", paneId: 42, sessionId: "s-1", sessionFile: "C:/state/wz-1.jsonl" }],
			"session-new",
			1002,
		);
		assert.equal(outcomes.length, 0, "the session of another task gets no outcome");
		assert.equal(stateOf(db, "att-1"), "issued");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the attempt of a task of another session with no worker stays issued", () => {
	const { db, dir } = freshDb();
	try {
		seedOwner(db, "wz-1", "session-old");
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		const outcomes = reconcileAttempts(db, [], "session-new", 1002);
		assert.equal(outcomes.length, 0, "the session of another task gets no outcome");
		assert.equal(stateOf(db, "att-1"), "issued");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the attempt of a task of this session becomes unresolved", () => {
	const { db, dir } = freshDb();
	try {
		seedOwner(db, "wz-1", "session-new");
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		const outcomes = reconcileAttempts(db, [], "session-new", 1002);
		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0].kind, "unresolved");
		assert.equal(stateOf(db, "att-1"), "unresolved");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a session without an identity skips the attempt of an owned task", () => {
	const { db, dir } = freshDb();
	try {
		seedOwner(db, "wz-1", "session-old");
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		const outcomes = reconcileAttempts(db, [], null, 1002);
		assert.equal(outcomes.length, 0, "a session without an identity owns no task");
		assert.equal(stateOf(db, "att-1"), "issued");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the job id limit skips the attempts of the other tasks", () => {
	const { db, dir } = freshDb();
	try {
		seedOwner(db, "wz-1", "session-new");
		seedOwner(db, "wz-2", "session-new");
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		reserveAttempt(db, "att-2", "wz-2", 1000);
		markIssued(db, "att-2", 1001);
		const outcomes = reconcileAttempts(db, [], "session-new", 1002, "wz-1");
		assert.equal(outcomes.length, 1);
		assert.equal(outcomes[0].jobId, "wz-1");
		assert.equal(stateOf(db, "att-1"), "unresolved");
		assert.equal(stateOf(db, "att-2"), "issued", "the attempt of the other task stays open");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the decision of the recovery follows the owner of the task", () => {
	const attempt = { jobId: "wz-1" };
	const owner = {
		taskKey: taskKey("wz-1"),
		sessionId: "session-old",
		processId: 500,
		processStartedAt: "2026-10-23T01:00:00.000Z",
		generation: 1,
		phase: "active" as const,
		updatedAt: 1000,
	};
	assert.equal(
		mayReconcileAttempt(attempt, null, null),
		true,
		"an attempt without an owner belongs to every session",
	);
	assert.equal(mayReconcileAttempt(attempt, null, "session-new"), true);
	assert.equal(
		mayReconcileAttempt(attempt, owner, "session-old"),
		true,
		"the owner settles the attempt of its own task",
	);
	assert.equal(
		mayReconcileAttempt(attempt, owner, "session-new"),
		false,
		"another session leaves the attempt alone",
	);
	assert.equal(
		mayReconcileAttempt(attempt, owner, null),
		false,
		"a session without an identity owns no task",
	);
});
