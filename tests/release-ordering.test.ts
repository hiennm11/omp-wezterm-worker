import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import {
	acquireOwnership,
	beginRelease,
	checkAuthority,
	commitRelease,
	readOwnership,
} from "../extensions/lib/ownership.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-release-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

test("one session takes the ownership of a task", () => {
	const { db, dir } = freshDb();
	try {
		const result = acquireOwnership(db, "task-1", "session-a", 100, "start", 1000);
		assert.equal(result.acquired, true);
		assert.equal(result.owner.generation, 1);
		assert.equal(result.owner.phase, "active");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("another session cannot take the ownership of a task", () => {
	const { db, dir } = freshDb();
	try {
		acquireOwnership(db, "task-1", "session-a", 100, "start", 1000);
		const second = acquireOwnership(db, "task-1", "session-b", 200, "start", 1100);
		assert.equal(second.acquired, false);
		assert.match(second.reason, /owned by session session-a/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an action that starts after the releasing phase is refused", () => {
	const { db, dir } = freshDb();
	try {
		acquireOwnership(db, "task-1", "session-a", 100, "start", 1000);
		beginRelease(db, "task-1", "session-a", 1, 1100);
		const authority = checkAuthority(db, "task-1", "session-a", 1);
		assert.equal(authority.ok, false);
		assert.match(authority.reason, /releasing/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the released phase refuses every action", () => {
	const { db, dir } = freshDb();
	try {
		acquireOwnership(db, "task-1", "session-a", 100, "start", 1000);
		beginRelease(db, "task-1", "session-a", 1, 1100);
		commitRelease(db, "task-1", "session-a", 1, 1200);
		const authority = checkAuthority(db, "task-1", "session-a", 1);
		assert.equal(authority.ok, false);
		assert.match(authority.reason, /released/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a takeover cannot come before the drain ends", () => {
	const { db, dir } = freshDb();
	try {
		acquireOwnership(db, "task-1", "session-a", 100, "start", 1000);
		beginRelease(db, "task-1", "session-a", 1, 1100);
		// The drain did not finish. The ownership stays with the old owner.
		const takeover = acquireOwnership(db, "task-1", "session-b", 200, "start", 1200);
		assert.equal(takeover.acquired, false);
		const owner = readOwnership(db, "task-1");
		assert.equal(owner.owner?.phase, "releasing");
		assert.equal(owner.owner?.sessionId, "session-a");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an old generation cannot write", () => {
	const { db, dir } = freshDb();
	try {
		acquireOwnership(db, "task-1", "session-a", 100, "start", 1000);
		// The same session takes the task again. The generation moves on.
		acquireOwnership(db, "task-1", "session-a", 100, "start", 1100);
		const old = checkAuthority(db, "task-1", "session-a", 1);
		assert.equal(old.ok, false);
		assert.match(old.reason, /new generation/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the release that waits for a running action commits after the drain", () => {
	const { db, dir } = freshDb();
	try {
		acquireOwnership(db, "task-1", "session-a", 100, "start", 1000);
		beginRelease(db, "task-1", "session-a", 1, 1100);
		// The action settles. Only now does the release commit.
		const commit = commitRelease(db, "task-1", "session-a", 1, 1200);
		assert.equal(commit.ok, true);
		const owner = readOwnership(db, "task-1");
		assert.equal(owner.owner?.phase, "released");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
