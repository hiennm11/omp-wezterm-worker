import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import {
	confirmStopIntent,
	failStopIntent,
	pendingStopIntents,
	readStopIntent,
	recordStopIntent,
	stopIntentsOfRun,
} from "../extensions/lib/stop-intent.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-stop-intent-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

test("a pending destructive intent survives the death of its owner", () => {
	const { db, dir } = freshDb();
	try {
		recordStopIntent(db, "stop-1", "run-1", "cancelled", "Cancelled by the main agent", 1000);
		// The process dies before the pane closes.
		const pending = pendingStopIntents(db);
		assert.equal(pending.length, 1);
		assert.equal(pending[0].runId, "run-1");
		assert.equal(pending[0].state, "pending");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a confirmed intent leaves nothing pending", () => {
	const { db, dir } = freshDb();
	try {
		recordStopIntent(db, "stop-1", "run-1", "cancelled", "Cancelled", 1000);
		confirmStopIntent(db, "stop-1", 1100);
		assert.equal(pendingStopIntents(db).length, 0);
		assert.equal(readStopIntent(db, "stop-1")?.state, "confirmed");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed intent stays observable", () => {
	const { db, dir } = freshDb();
	try {
		recordStopIntent(db, "stop-1", "run-1", "cancelled", "Cancelled", 1000);
		failStopIntent(db, "stop-1", 1100);
		const intent = readStopIntent(db, "stop-1");
		assert.equal(intent?.state, "failed");
		assert.equal(intent?.error, "Cancelled");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the intents of one run are listed in order", () => {
	const { db, dir } = freshDb();
	try {
		recordStopIntent(db, "stop-1", "run-1", "cancelled", "First", 1000);
		recordStopIntent(db, "stop-2", "run-2", "failed", "Second", 1100);
		recordStopIntent(db, "stop-3", "run-1", "failed", "Third", 1200);
		const intents = stopIntentsOfRun(db, "run-1");
		assert.equal(intents.length, 2);
		assert.equal(intents[0].id, "stop-1");
		assert.equal(intents[1].id, "stop-3");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
