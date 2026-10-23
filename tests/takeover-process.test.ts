/**
 * The process record of the new owner of a task.
 *
 * A session starts without the start time of its process. A takeover needs
 * that time, because a row without it names no owner and locks the task.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import {
	fakeRuntime,
	makeJob,
	OLD_PID,
	OLD_START,
	OWN_PID,
	OWN_START,
	ownerOf,
	seedOwner,
	THIRD_PID,
	THIRD_START,
	takeOver,
} from "./takeover-helpers.ts";

test("a takeover of a session without a start time stores the start time of its process", async () => {
	const { rt, dir } = fakeRuntime(
		{ starts: { [OWN_PID]: OWN_START, [OLD_PID]: "" }, code: 0, panes: [3] },
		{ withoutOwnStart: true },
	);
	try {
		rt.sessionId = "session-new";
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OLD_PID, OLD_START);

		const result = await takeOver(rt, job.id);
		assert.equal(result.details.taken, true);
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-new");
		assert.equal(ownerOf(rt, job.id)?.processStartedAt, OWN_START);
		assert.notEqual(ownerOf(rt, job.id)?.processStartedAt, null);
	} finally {
		rt.stopMonitor("wz-1");
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a takeover refuses when the session cannot read the start time of its process", async () => {
	const { rt, dir } = fakeRuntime(
		{ starts: { [OLD_PID]: "" }, code: 0, panes: [3], failFor: [OWN_PID] },
		{ withoutOwnStart: true },
	);
	try {
		rt.sessionId = "session-new";
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OLD_PID, OLD_START);

		const result = await takeOver(rt, job.id);
		assert.equal(result.isError, true);
		assert.equal(result.details.taken, false);
		assert.equal(result.details.reason, "own-process-unknown");
		assert.match(result.content[0]?.text ?? "", /start time of this process/);
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-old");
		assert.equal(ownerOf(rt, job.id)?.generation, 1);
	} finally {
		rt.stopMonitor("wz-1");
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a task taken over with a start time is not a lock", async () => {
	const first = fakeRuntime(
		{ starts: { [OWN_PID]: OWN_START, [OLD_PID]: "" }, code: 0, panes: [3] },
		{ withoutOwnStart: true },
	);
	try {
		first.rt.sessionId = "session-new";
		const job = makeJob(first.dir, "wz-1");
		first.rt.jobs.set(job.id, job);
		seedOwner(first.rt, job.id, OLD_PID, OLD_START);
		await takeOver(first.rt, job.id);
		first.rt.stopMonitor(job.id);
		assert.equal(ownerOf(first.rt, job.id)?.generation, 2);
	} finally {
		first.rt.closeDb();
	}

	// The second session finds the first process gone and takes the task over.
	const second = fakeRuntime(
		{ starts: { [THIRD_PID]: THIRD_START, [OWN_PID]: "" }, code: 0, panes: [3] },
		{ stateDir: first.dir, ownProcess: { id: THIRD_PID, startedAt: THIRD_START } },
	);
	try {
		second.rt.sessionId = "session-third";
		const job = makeJob(second.dir, "wz-1");
		second.rt.jobs.set(job.id, job);

		const result = await takeOver(second.rt, job.id);
		assert.equal(result.details.taken, true);
		assert.equal(ownerOf(second.rt, job.id)?.sessionId, "session-third");
		assert.equal(ownerOf(second.rt, job.id)?.generation, 3);
	} finally {
		second.rt.stopMonitor("wz-1");
		second.rt.closeDb();
		rmSync(first.dir, { recursive: true, force: true });
		rmSync(second.dir, { recursive: true, force: true });
	}
});
