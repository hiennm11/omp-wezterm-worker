/**
 * The takeover of a task that another session owns.
 *
 * A new main session takes the supervision of a worker that another session
 * owned. The takeover needs a released task or a confirmed dead owner.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { taskKey } from "../extensions/lib/owner.ts";
import { beginRelease, commitRelease, takeOverOwnership } from "../extensions/lib/ownership.ts";
import {
	attemptState,
	type FakeTable,
	fakeRuntime,
	finish,
	makeJob,
	OLD_PID,
	OLD_START,
	OWN_PID,
	OWN_START,
	ownerOf,
	ownTakeover,
	ownedTask,
	seedAttempt,
	seedOwner,
	takeOver,
} from "./takeover-helpers.ts";

test("a released task of another session is taken over", async () => {
	const { rt, dir, job } = ownedTask({ starts: {}, code: 0, panes: [3] });
	try {
		beginRelease(rt.openDb(), taskKey(job.id), "session-old", 1, 1100);
		commitRelease(rt.openDb(), taskKey(job.id), "session-old", 1, 1200);

		const result = await takeOver(rt, job.id);
		assert.equal(result.isError, undefined);
		assert.equal(result.details.taken, true);
		assert.equal(result.details.generation, 2);
		assert.match(result.content[0]?.text ?? "", /now supervises worker wz-1/);
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-new");
		assert.equal(ownerOf(rt, job.id)?.generation, 2);
		assert.equal(ownerOf(rt, job.id)?.phase, "active");
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a task of another session with a dead owner is taken over", async () => {
	const { rt, dir, job } = ownedTask({ starts: { [OLD_PID]: "" }, code: 0, panes: [3] });
	try {
		const result = await takeOver(rt, job.id);
		assert.equal(result.details.taken, true);
		assert.equal(result.details.generation, 2);
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-new");
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a task of another session that is releasing is taken over when the owner is dead", async () => {
	const { rt, dir, job } = ownedTask({ starts: { [OLD_PID]: "" }, code: 0, panes: [3] });
	try {
		beginRelease(rt.openDb(), taskKey(job.id), "session-old", 1, 1100);

		const result = await takeOver(rt, job.id);
		assert.equal(result.details.taken, true);
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-new");
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a reused process id does not keep the task", async () => {
	const { rt, dir, job } = ownedTask({
		starts: { [OLD_PID]: "2026-10-23T05:00:00.000Z" },
		code: 0,
		panes: [3],
	});
	try {
		const result = await takeOver(rt, job.id);
		assert.equal(result.details.taken, true);
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-new");
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a live owner keeps the task", async () => {
	const { rt, dir, job } = ownedTask({ starts: { [OLD_PID]: OLD_START }, code: 0, panes: [3] });
	try {
		const result = await takeOver(rt, job.id);
		assert.equal(result.isError, true);
		assert.equal(result.details.taken, false);
		assert.equal(result.details.reason, "process-alive");
		assert.match(result.content[0]?.text ?? "", /900/);
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-old");
		assert.equal(ownerOf(rt, job.id)?.generation, 1);
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("an unreadable process table refuses the takeover", async () => {
	const { rt, dir, job } = ownedTask({ starts: {}, code: 1, panes: [3] });
	try {
		const result = await takeOver(rt, job.id);
		assert.equal(result.isError, true);
		assert.equal(result.details.reason, "process-unknown");
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-old");
		assert.equal(ownerOf(rt, job.id)?.generation, 1);
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a row without a process record refuses the takeover", async () => {
	const { rt, dir } = fakeRuntime({ starts: {}, code: 0, panes: [3] });
	try {
		rt.sessionId = "session-new";
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, null, null);

		const result = await takeOver(rt, job.id);
		assert.equal(result.isError, true);
		assert.equal(result.details.reason, "no-process-record");
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-old");
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a task without an owner refuses the takeover", async () => {
	const { rt, dir } = fakeRuntime({ starts: {}, code: 0, panes: [3] });
	try {
		rt.sessionId = "session-new";
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);

		const result = await takeOver(rt, job.id);
		assert.equal(result.isError, true);
		assert.equal(result.details.reason, "no-owner");
		assert.match(result.content[0]?.text ?? "", /has no owner/);
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a session without an identity refuses the takeover", async () => {
	const { rt, dir, job } = ownedTask({ starts: {}, code: 0, panes: [3] });
	try {
		rt.sessionId = null;
		const result = await takeOver(rt, job.id);
		assert.equal(result.isError, true);
		assert.equal(result.details.reason, "no-identity");
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-old");
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a session that owns an active task refuses the takeover", async (t) => {
	const { result, owner } = await ownTakeover(t, "active");

	assert.equal(result.isError, true);
	assert.equal(result.details.reason, "own");
	assert.match(result.content[0]?.text ?? "", /already owns worker wz-1/);
	assert.equal(owner?.generation, 1);
	assert.equal(owner?.phase, "active");
});

test("a session that owns a releasing task refuses the takeover", async (t) => {
	const { result, owner } = await ownTakeover(t, "releasing");

	assert.equal(result.isError, true);
	assert.equal(result.details.reason, "own");
	assert.match(result.content[0]?.text ?? "", /already owns worker wz-1/);
	assert.equal(owner?.phase, "releasing");
});

test("a session takes back a task that it released", async (t) => {
	const { result, owner } = await ownTakeover(t, "released");

	assert.equal(result.isError, undefined);
	assert.equal(result.details.taken, true);
	assert.equal(result.details.generation, 2);
	assert.match(result.content[0]?.text ?? "", /now supervises worker wz-1/);
	assert.equal(owner?.sessionId, "session-old");
	assert.equal(owner?.generation, 2);
	assert.equal(owner?.phase, "active");
});

test("a native worker is taken over and gets a bridge", async () => {
	const { rt, dir, job } = ownedTask({ starts: {}, code: 0, panes: [3] }, { backend: "claude" });
	try {
		const result = await takeOver(rt, job.id);
		assert.equal(result.isError, undefined);
		assert.equal(result.details.taken, true);
		assert.ok(rt.bridges.has(job.id), "the new owner has a bridge");
	} finally {
		await Promise.all([...rt.bridges.values()].map((bridge) => bridge.close()));
		rt.bridges.clear();
		finish(rt, dir, "wz-1");
	}
});

test("an ownership that changes during the check refuses the takeover", async () => {
	const table: FakeTable = { starts: { [OLD_PID]: "" }, code: 0, panes: [3] };
	const { rt, dir, job } = ownedTask(table);
	try {
		// Another owner takes the task while the process table is read.
		table.onProbe = () => {
			takeOverOwnership(rt.openDb(), taskKey(job.id), "session-third", OWN_PID, OWN_START, 1, 1300);
		};

		const result = await takeOver(rt, job.id);
		assert.equal(result.isError, true);
		assert.equal(result.details.reason, "changed");
		assert.match(result.content[0]?.text ?? "", /ownership changed/);
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-third");
		assert.equal(ownerOf(rt, job.id)?.generation, 2);
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a takeover of a live worker starts the monitor", async () => {
	const { rt, dir, job } = ownedTask({ starts: { [OLD_PID]: "" }, code: 0, panes: [3] });
	try {
		await takeOver(rt, job.id);
		assert.equal(rt.monitors.has(job.id), true);
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a takeover of a worker whose pane is gone ends the worker", async () => {
	const { rt, dir, job } = ownedTask({ starts: { [OLD_PID]: "" }, code: 0, panes: [] });
	try {
		await takeOver(rt, job.id);
		assert.equal(rt.monitors.has(job.id), false);
		assert.equal(job.status, "failed");
		assert.match(job.error ?? "", /pane was closed/);
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a session that takes back a released task of a worker whose pane is gone ends the worker", async (t) => {
	const { owner, job, rt } = await ownTakeover(t, "released", { starts: {}, code: 0, panes: [] });

	assert.equal(rt.monitors.has(job.id), false);
	assert.equal(job.status, "failed");
	assert.match(job.error ?? "", /pane was closed/);
	assert.equal(owner?.generation, 2);
	assert.equal(owner?.phase, "active");
});

test("a takeover of a completed worker keeps its status and starts no monitor", async () => {
	const { rt, dir, job } = ownedTask(
		{ starts: { [OLD_PID]: "" }, code: 0, panes: [] },
		{ status: "completed", result: "DONE" },
	);
	try {
		const result = await takeOver(rt, job.id);
		assert.equal(result.details.taken, true);
		assert.equal(result.details.generation, 2);
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-new");
		assert.equal(ownerOf(rt, job.id)?.generation, 2);
		assert.equal(job.status, "completed");
		assert.equal(job.result, "DONE");
		assert.equal(job.error, null);
		assert.equal(rt.monitors.has(job.id), false);
		assert.match(result.content[0]?.text ?? "", /already completed/);
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a takeover of a failed worker keeps its error and starts no monitor", async () => {
	const { rt, dir, job } = ownedTask(
		{ starts: { [OLD_PID]: "" }, code: 0, panes: [] },
		{ status: "failed", error: "the worker failed" },
	);
	try {
		const result = await takeOver(rt, job.id);
		assert.equal(result.details.taken, true);
		assert.equal(ownerOf(rt, job.id)?.sessionId, "session-new");
		assert.equal(job.status, "failed");
		assert.equal(job.error, "the worker failed");
		assert.equal(rt.monitors.has(job.id), false);
		assert.match(result.content[0]?.text ?? "", /already failed/);
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a takeover of a task with an open attempt attaches the attempt to its worker", async () => {
	const { rt, dir, job } = ownedTask({
		starts: { [OLD_PID]: "" },
		code: 0,
		panes: [3],
		workers: ["omp.exe --session-dir C:\\state\\sessions\\wz-1"],
	});
	try {
		seedAttempt(rt, job.id, "att-1");

		const result = await takeOver(rt, job.id);
		assert.equal(result.details.taken, true);
		assert.equal(attemptState(rt, "att-1"), "attached");
	} finally {
		finish(rt, dir, "wz-1");
	}
});

test("a takeover of a task with an open attempt leaves the attempt unresolved without a worker", async () => {
	const { rt, dir, job } = ownedTask({ starts: { [OLD_PID]: "" }, code: 0, panes: [3] });
	try {
		seedAttempt(rt, job.id, "att-1");

		const result = await takeOver(rt, job.id);
		assert.equal(result.details.taken, true);
		assert.equal(attemptState(rt, "att-1"), "unresolved");
	} finally {
		finish(rt, dir, "wz-1");
	}
});
