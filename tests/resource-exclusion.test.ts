import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import {
	createGroup,
	disposingGroups,
	markDisposing,
	markExecutionStopping,
	markExecutionUnknown,
	readGroup,
	releaseExecution,
	reserveExecution,
} from "../extensions/lib/groups.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-group-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

test("a second run cannot take a group that a first run holds", () => {
	const { db, dir } = freshDb();
	try {
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		const first = reserveExecution(db, "grp-1", "run-1", 1001);
		assert.equal(first.granted, true);
		const second = reserveExecution(db, "grp-1", "run-2", 1002);
		assert.equal(second.granted, false);
		assert.match(second.reason, /used by run run-1/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a group that is stopping refuses a new run", () => {
	const { db, dir } = freshDb();
	try {
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "run-1", 1001);
		markExecutionStopping(db, "grp-1", 1002);
		const second = reserveExecution(db, "grp-1", "run-2", 1003);
		assert.equal(second.granted, false);
		assert.match(second.reason, /stopping/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a group with an unknown state refuses a new run", () => {
	const { db, dir } = freshDb();
	try {
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "run-1", 1001);
		markExecutionUnknown(db, "grp-1", 1002);
		const second = reserveExecution(db, "grp-1", "run-2", 1003);
		assert.equal(second.granted, false);
		assert.match(second.reason, /unknown/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a disposing group refuses every new run", () => {
	const { db, dir } = freshDb();
	try {
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		markDisposing(db, "grp-1", 1001);
		const result = reserveExecution(db, "grp-1", "run-1", 1002);
		assert.equal(result.granted, false);
		assert.match(result.reason, /being deleted/);
		assert.equal(disposingGroups(db).length, 1);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a crash during the deletion leaves the group disposing", () => {
	const { db, dir } = freshDb();
	try {
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		markDisposing(db, "grp-1", 1001);
		// The process dies here. The marker stays.
		const group = readGroup(db, "grp-1");
		assert.equal(group?.disposing, true);
		assert.equal(disposingGroups(db).length, 1);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the run that releases the group lets the next run take it", () => {
	const { db, dir } = freshDb();
	try {
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "run-1", 1001);
		releaseExecution(db, "grp-1", "run-1", 1002);
		const second = reserveExecution(db, "grp-1", "run-2", 1003);
		assert.equal(second.granted, true);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
