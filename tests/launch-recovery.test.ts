import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	attachAttempt,
	markIssued,
	markUnresolved,
	markUnused,
	openAttempts,
	reserveAttempt,
} from "../extensions/lib/attempts.ts";
import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-attempt-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

test("a crash before the receipt leaves an attempt that the recovery can find", () => {
	const { db, dir } = freshDb();
	try {
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		const open = openAttempts(db);
		assert.equal(open.length, 1);
		assert.equal(open[0].state, "issued");
		assert.equal(open[0].jobId, "wz-1");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a receipt attaches the attempt to its pane", () => {
	const { db, dir } = freshDb();
	try {
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		attachAttempt(db, "att-1", 42, "C:/state/sessions/wz-1/a.jsonl", "session-abc", 1002);
		assert.equal(openAttempts(db).length, 0, "an attached attempt is not open");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failure before the worker started leaves no open attempt", () => {
	const { db, dir } = freshDb();
	try {
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		markUnused(db, "att-1", 1002);
		assert.equal(openAttempts(db).length, 0);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an attempt without a match stays unresolved and keeps its capacity", () => {
	const { db, dir } = freshDb();
	try {
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		markUnresolved(db, "att-1", 1002);
		const open = openAttempts(db);
		assert.equal(open.length, 0, "an unresolved attempt is not open for a new launch");
		const holders = db.handle.prepare("SELECT id FROM launch_attempts WHERE state = 'unresolved'").all();
		assert.equal(holders.length, 1, "an unresolved attempt keeps its capacity");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a second launch of one job never repeats the first attempt", () => {
	const { db, dir } = freshDb();
	try {
		reserveAttempt(db, "att-1", "wz-1", 1000);
		markIssued(db, "att-1", 1001);
		const again = reserveAttempt(db, "att-2", "wz-1", 1002);
		assert.equal(again.id, "att-2");
		const rows = db.handle.prepare("SELECT id FROM launch_attempts").all();
		assert.equal(rows.length, 2, "the attempts keep their own identity");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
