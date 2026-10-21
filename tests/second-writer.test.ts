import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import { createGroup, readGroup, reserveExecution } from "../extensions/lib/groups.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-writer-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

test("a completed old run keeps its group while its pane lives", () => {
	const { db, dir } = freshDb();
	try {
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "run-1", 1001);
		// The run declares completion. The group stays held, because the pane
		// of the run may still write into the transcript.
		const group = readGroup(db, "grp-1");
		assert.equal(group?.executionHolder, "run-1");
		assert.equal(group?.executionState, "held");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a second writer cannot start against a transcript that a live run holds", () => {
	const { db, dir } = freshDb();
	try {
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "run-1", 1001);
		const second = reserveExecution(db, "grp-1", "run-2", 1002);
		assert.equal(second.granted, false);
		assert.match(second.reason, /used by run run-1/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the group refuses a new run while its state is unknown", () => {
	const { db, dir } = freshDb();
	try {
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "run-1", 1001);
		// The pane list cannot be read. The state is unknown.
		db.handle.prepare("UPDATE resource_groups SET execution_state = 'unknown' WHERE id = ?").run("grp-1");
		const second = reserveExecution(db, "grp-1", "run-2", 1002);
		assert.equal(second.granted, false);
		assert.match(second.reason, /unknown/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
