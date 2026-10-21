import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markIssued, reserveAttempt } from "../extensions/lib/attempts.ts";
import { jobIdOfCommandLine, workersOf } from "../extensions/lib/correlation.ts";
import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import { parseProcessRows } from "../extensions/lib/process-table.ts";
import { reconcileAttempts } from "../extensions/lib/recovery.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-recovery-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
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
		const outcomes = reconcileAttempts(db, [], 1002);
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
		reconcileAttempts(db, [], 1002);
		// A second recovery finds no open attempt, so it does nothing.
		const again = reconcileAttempts(db, [], 1100);
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
