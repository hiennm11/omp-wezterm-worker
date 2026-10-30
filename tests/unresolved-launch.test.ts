/**
 * The unresolved launch and its event.
 *
 * A crash leaves a launch attempt without a receipt. The recovery marks the
 * attempt unresolved and creates one actionable event. The owner finds the
 * event in the status and frees the attempt with a resolution.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pendingEvents, readEvent } from "../extensions/lib/events.ts";
import { reconcileAttempts } from "../extensions/lib/recovery.ts";
import { readResolution } from "../extensions/lib/resolution.ts";
import { registerResolveTool } from "../extensions/worker-tools/resolve.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";
import { finish, OLD_PID, ownedTask, takeOver } from "./takeover-helpers.ts";
import {
	closeDb,
	closeRuntime,
	fakeRuntime,
	freshDb,
	makeJob,
	OTHER,
	OWN,
	resolveParams,
	seedOpenAttempt,
	seedOwner,
	stateOf,
	toolOf,
} from "./unresolved-launch-helpers.ts";

test("an unresolved launch creates one actionable event", () => {
	const { db, dir } = freshDb();
	try {
		seedOpenAttempt(db, "wz-1", "att-1");
		reconcileAttempts(db, [], OWN, 1002);
		const events = pendingEvents(db);
		assert.equal(events.length, 1);
		const event = events[0];
		assert.ok(event);
		assert.equal(event.condition, "unresolved_launch");
		assert.equal(event.runId, "wz-1");
		assert.equal(event.actionable, true);
		assert.equal(stateOf(db, "att-1"), "unresolved");
	} finally {
		closeDb(db, dir);
	}
});

test("the event of an unresolved launch names the attempt and the job", () => {
	const { db, dir } = freshDb();
	try {
		seedOpenAttempt(db, "wz-1", "att-1");
		reconcileAttempts(db, [], OWN, 1002);
		const event = pendingEvents(db)[0];
		assert.ok(event);
		assert.ok(event.payload);
		const payload = JSON.parse(event.payload) as { attemptId?: string; jobId?: string };
		assert.equal(payload.attemptId, "att-1");
		assert.equal(payload.jobId, "wz-1");
	} finally {
		closeDb(db, dir);
	}
});

test("a second recovery creates no second event", () => {
	const { db, dir } = freshDb();
	try {
		seedOpenAttempt(db, "wz-1", "att-1");
		reconcileAttempts(db, [], OWN, 1002);
		reconcileAttempts(db, [], OWN, 1100);
		const events = pendingEvents(db);
		assert.equal(events.length, 1);
		const rows = db.handle.prepare("SELECT COUNT(*) AS n FROM events").all();
		const row = rows[0];
		assert.ok(row && typeof row === "object" && "n" in row);
		assert.equal(Number(row.n), 1, "no second event was created");
	} finally {
		closeDb(db, dir);
	}
});

test("the takeover path creates the event for a taken task", async () => {
	const { rt, dir, job } = ownedTask({ starts: { [OLD_PID]: "" }, code: 0, panes: [3] });
	try {
		seedOpenAttempt(rt.openDb(), job.id, "att-1");

		const result = await takeOver(rt, job.id);
		assert.equal(result.details.taken, true);
		const events = pendingEvents(rt.openDb());
		assert.equal(events.length, 1);
		const event = events[0];
		assert.ok(event);
		assert.equal(event.condition, "unresolved_launch");
		assert.equal(event.runId, job.id);
		assert.equal(event.actionable, true);
	} finally {
		finish(rt, dir, job.id);
	}
});

test("the status tool lists the event of an unresolved launch", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOpenAttempt(rt.openDb(), job.id, "att-1");
		reconcileAttempts(rt.openDb(), [], OWN, 1002);

		const tool = toolOf(rt, registerStatusTool, "status");
		const result = await tool.execute("t1", {});
		const events = (result.details.events ?? []) as { id: string; condition: string }[];
		assert.equal(events.length, 1);
		assert.equal(events[0]?.condition, "unresolved_launch");
		assert.match(result.content[0]?.text ?? "", /Events that wait for you/);
	} finally {
		closeRuntime(rt, dir);
	}
});

test("the abandoned resolution frees the attempt", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt.openDb(), "wz-1", OWN);
		seedOpenAttempt(rt.openDb(), "wz-1", "att-1");
		reconcileAttempts(rt.openDb(), [], OWN, 1002);
		const event = pendingEvents(rt.openDb())[0];
		assert.ok(event);

		const tool = toolOf(rt, registerResolveTool, "resolve");
		const result = await tool.execute("t1", resolveParams(event.id, "abandoned"));
		assert.notEqual(result.isError, true);
		assert.equal(result.details.resolved, true);
		assert.equal(stateOf(rt.openDb(), "att-1"), "unused");
		assert.equal(readResolution(rt.openDb(), event.id)?.resolution, "abandoned");
	} finally {
		closeRuntime(rt, dir);
	}
});

test("the incomplete resolution frees the attempt", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt.openDb(), "wz-1", OWN);
		seedOpenAttempt(rt.openDb(), "wz-1", "att-1");
		reconcileAttempts(rt.openDb(), [], OWN, 1002);
		const event = pendingEvents(rt.openDb())[0];
		assert.ok(event);

		const tool = toolOf(rt, registerResolveTool, "resolve");
		const result = await tool.execute("t1", resolveParams(event.id, "incomplete"));
		assert.notEqual(result.isError, true);
		assert.equal(result.details.resolved, true);
		assert.equal(stateOf(rt.openDb(), "att-1"), "unused");
	} finally {
		closeRuntime(rt, dir);
	}
});

test("the recorded_result resolution is refused and the attempt stays unresolved", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt.openDb(), "wz-1", OWN);
		seedOpenAttempt(rt.openDb(), "wz-1", "att-1");
		reconcileAttempts(rt.openDb(), [], OWN, 1002);
		const event = pendingEvents(rt.openDb())[0];
		assert.ok(event);

		const tool = toolOf(rt, registerResolveTool, "resolve");
		const result = await tool.execute("t1", resolveParams(event.id, "recorded_result"));
		assert.equal(result.isError, true);
		assert.equal(result.details.resolved, false);
		assert.match(result.content[0]?.text ?? "", /unresolved launch/i);
		assert.equal(stateOf(rt.openDb(), "att-1"), "unresolved");
		assert.equal(readResolution(rt.openDb(), event.id), null);
	} finally {
		closeRuntime(rt, dir);
	}
});

test("the recorded_result resolution is refused for an event without a payload", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt.openDb(), "wz-1", OWN);
		seedOpenAttempt(rt.openDb(), "wz-1", "att-1");
		reconcileAttempts(rt.openDb(), [], OWN, 1002);
		const event = pendingEvents(rt.openDb())[0];
		assert.ok(event);
		// An event whose payload names no attempt still refuses the result.
		rt.openDb().handle.prepare("UPDATE events SET payload = NULL WHERE id = ?").run(event.id);

		const tool = toolOf(rt, registerResolveTool, "resolve");
		const result = await tool.execute("t1", resolveParams(event.id, "recorded_result"));
		assert.equal(result.isError, true);
		assert.equal(result.details.resolved, false);
		assert.match(result.content[0]?.text ?? "", /unresolved launch/i);
		assert.equal(stateOf(rt.openDb(), "att-1"), "unresolved");
	} finally {
		closeRuntime(rt, dir);
	}
});

test("a session that does not own the task cannot resolve the event", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOpenAttempt(rt.openDb(), "wz-1", "att-1");
		reconcileAttempts(rt.openDb(), [], OWN, 1002);
		const event = pendingEvents(rt.openDb())[0];
		assert.ok(event);
		seedOwner(rt.openDb(), "wz-1", OTHER);

		const tool = toolOf(rt, registerResolveTool, "resolve");
		const result = await tool.execute("t1", resolveParams(event.id, "abandoned"));
		assert.equal(result.isError, true);
		assert.equal(result.details.resolved, false);
		assert.equal(stateOf(rt.openDb(), "att-1"), "unresolved");
		assert.equal(readResolution(rt.openDb(), event.id), null);
	} finally {
		closeRuntime(rt, dir);
	}
});

test("the event of an unresolved launch keeps its identity after the resolution", async () => {
	const { rt, dir } = fakeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt.openDb(), "wz-1", OWN);
		seedOpenAttempt(rt.openDb(), "wz-1", "att-1");
		reconcileAttempts(rt.openDb(), [], OWN, 1002);
		const event = pendingEvents(rt.openDb())[0];
		assert.ok(event);

		const tool = toolOf(rt, registerResolveTool, "resolve");
		await tool.execute("t1", resolveParams(event.id, "abandoned"));
		const stored = readEvent(rt.openDb(), event.id);
		assert.equal(stored?.condition, "unresolved_launch");
		assert.equal(pendingEvents(rt.openDb()).length, 0);
	} finally {
		closeRuntime(rt, dir);
	}
});
