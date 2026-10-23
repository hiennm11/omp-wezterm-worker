/**
 * The group of a run.
 *
 * A run has no stored group id. It finds its group through its session
 * directory, because every run of a task shares that directory.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import { createGroup, groupOfRun } from "../extensions/lib/groups.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-group-lookup-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

test("a run finds its group through its session directory", () => {
	const { db, dir } = freshDb();
	try {
		createGroup(db, "grp-wz-1", "C:/state/sessions/wz-1", 1000);
		createGroup(db, "grp-wz-2", "C:/state/sessions/wz-2", 1001);

		const group = groupOfRun(db, { sessionDir: "C:/state/sessions/wz-2" });

		assert.equal(group?.id, "grp-wz-2");
		assert.equal(group?.sessionDir, "C:/state/sessions/wz-2");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run without a group has no group", () => {
	const { db, dir } = freshDb();
	try {
		createGroup(db, "grp-wz-1", "C:/state/sessions/wz-1", 1000);

		const group = groupOfRun(db, { sessionDir: "C:/state/sessions/wz-9" });

		assert.equal(group, null);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
