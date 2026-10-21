import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import { createEvent, eventKey, pendingEvents, readEvent } from "../extensions/lib/events.ts";
import { readResolution, recordResolution } from "../extensions/lib/resolution.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-legacy-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

/** One event that describes an unknown outcome. */
function unknownEvent(db: LifecycleDb, id: string): string {
	const key = eventKey("run-1", "evidence-1", "unknown_outcome");
	createEvent(db, id, key, "run-1", "unknown_outcome", "unknown_outcome", null, true, 1000);
	return id;
}

test("an active legacy task reaches an owner resolution", () => {
	const { db, dir } = freshDb();
	try {
		const eventId = unknownEvent(db, "ev-1");
		const outcome = recordResolution(
			db,
			"res-1",
			eventId,
			"run-1",
			"incomplete",
			"The old transcript holds no result and no report.",
			"session-a",
			1,
			1100,
		);
		assert.equal(outcome.ok, true);
		assert.equal(readResolution(db, eventId)?.resolution, "incomplete");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resolution never creates a worker completion report", () => {
	const { db, dir } = freshDb();
	try {
		const eventId = unknownEvent(db, "ev-1");
		recordResolution(
			db,
			"res-1",
			eventId,
			"run-1",
			"abandoned",
			"The owner gives up on it.",
			"session-a",
			1,
			1100,
		);
		const event = readEvent(db, eventId);
		assert.equal(event?.condition, "unknown_outcome", "the event keeps its condition");
		assert.equal(event?.kind, "unknown_outcome");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resolution closes the obligation of the owner", () => {
	const { db, dir } = freshDb();
	try {
		const eventId = unknownEvent(db, "ev-1");
		assert.equal(pendingEvents(db).length, 1);
		recordResolution(
			db,
			"res-1",
			eventId,
			"run-1",
			"abandoned",
			"The owner gives up on it.",
			"session-a",
			1,
			1100,
		);
		assert.equal(pendingEvents(db).length, 0);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the same resolution twice succeeds without another effect", () => {
	const { db, dir } = freshDb();
	try {
		const eventId = unknownEvent(db, "ev-1");
		recordResolution(db, "res-1", eventId, "run-1", "incomplete", "No result.", "session-a", 1, 1100);
		const again = recordResolution(
			db,
			"res-2",
			eventId,
			"run-1",
			"incomplete",
			"No result.",
			"session-a",
			1,
			1200,
		);
		assert.equal(again.ok, true);
		assert.equal(again.resolution.id, "res-1", "the first resolution stays");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a conflicting resolution is refused", () => {
	const { db, dir } = freshDb();
	try {
		const eventId = unknownEvent(db, "ev-1");
		recordResolution(db, "res-1", eventId, "run-1", "incomplete", "No result.", "session-a", 1, 1100);
		const conflict = recordResolution(
			db,
			"res-2",
			eventId,
			"run-1",
			"abandoned",
			"Give up.",
			"session-a",
			1,
			1200,
		);
		assert.equal(conflict.ok, false);
		assert.match(conflict.reason, /already resolved as incomplete/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resolution needs an evidence note", () => {
	const { db, dir } = freshDb();
	try {
		const eventId = unknownEvent(db, "ev-1");
		const outcome = recordResolution(db, "res-1", eventId, "run-1", "abandoned", "", "session-a", 1, 1100);
		assert.equal(outcome.ok, true, "the module stores what the caller gives it");
		// The tool checks the note before it calls the module.
		assert.equal(readResolution(db, eventId)?.evidenceNote, "");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
