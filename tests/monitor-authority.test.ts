/**
 * The authority of a monitor.
 *
 * A session that released a task, or lost it to another session, must not
 * end the worker when the deadline passes. The monitor checks the authority
 * on every tick. The phase `releasing` is temporary, so the monitor waits in
 * that phase and does not stop.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorJob, monitorNativeJob } from "../extensions/lib/monitor.ts";
import { monitorVerdict } from "../extensions/lib/monitor-authority.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import {
	acquireOwnership,
	beginRelease,
	commitRelease,
	type Ownership,
} from "../extensions/lib/ownership.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { fakeWezterm, jobOf, runtimeFor } from "./group-holder-helpers.ts";

/** An ownership row of the given session and phase. */
function ownerOf(sessionId: string, phase: Ownership["phase"]): Ownership {
	return {
		taskKey: "task-wz-1",
		sessionId,
		processId: 1,
		processStartedAt: "t",
		generation: 1,
		phase,
		updatedAt: 1,
	};
}

/** A runtime whose polls the test runs by hand. */
function manualRuntime(t: Parameters<typeof runtimeFor>[0]): { rt: WorkerRuntime; ticks: (() => void)[] } {
	const { rt } = runtimeFor(t, fakeWezterm({ panes: [] }).exec);
	const ticks: (() => void)[] = [];
	rt.timers = {
		setInterval: (fn) => {
			ticks.push(fn);
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	rt.sessionId = "s1";
	return { rt, ticks };
}

/** A running worker whose total deadline has passed. */
function overdue(id: string): Job {
	return jobOf(id, {
		...freshRunState(Date.now() - 60_000),
		status: "running",
		paneId: 7,
		timeoutMs: 1000,
	});
}

test("the verdict follows the owner, the session and the phase", () => {
	assert.equal(monitorVerdict(null, "s1"), "act");
	assert.equal(monitorVerdict(ownerOf("s1", "active"), null), "act");
	assert.equal(monitorVerdict(ownerOf("s1", "active"), "s1"), "act");
	assert.equal(monitorVerdict(ownerOf("s1", "releasing"), "s1"), "wait");
	assert.equal(monitorVerdict(ownerOf("s1", "released"), "s1"), "stop");
	assert.equal(monitorVerdict(ownerOf("s2", "active"), "s1"), "stop");
});

test("the monitor of the owner ends an overdue worker", async (t) => {
	const { rt, ticks } = manualRuntime(t);
	const job = overdue("wz-1");
	rt.jobs.set(job.id, job);
	acquireOwnership(rt.openDb(), taskKey(job.id), "s1", 1, "t", 1000);
	monitorJob(rt, job, () => {});

	for (const tick of ticks) tick();

	assert.notEqual(job.pendingStop, null, "the owner must stop the overdue worker");
});

test("a released task stops its monitor and leaves the worker alone", async (t) => {
	const { rt, ticks } = manualRuntime(t);
	const job = overdue("wz-1");
	rt.jobs.set(job.id, job);
	const db = rt.openDb();
	acquireOwnership(db, taskKey(job.id), "s1", 1, "t", 1000);
	monitorJob(rt, job, () => {});
	commitRelease(db, taskKey(job.id), "s1", 1, 1100);

	for (const tick of ticks) tick();

	assert.equal(job.pendingStop, null);
	assert.equal(job.status, "running");
	assert.equal(rt.monitors.size, 0, "the monitor of a released task must stop");
});

test("a task that another session took stops the monitor of the old session", async (t) => {
	const { rt, ticks } = manualRuntime(t);
	const job = overdue("wz-1");
	rt.jobs.set(job.id, job);
	const db = rt.openDb();
	acquireOwnership(db, taskKey(job.id), "s1", 1, "t", 1000);
	monitorJob(rt, job, () => {});
	db.handle
		.prepare("UPDATE ownership SET session_id = 's2', generation = 2 WHERE task_key = ?")
		.run(taskKey(job.id));

	for (const tick of ticks) tick();

	assert.equal(job.pendingStop, null);
	assert.equal(rt.monitors.size, 0);
});

test("the releasing phase makes the monitor wait and does not stop it", async (t) => {
	const { rt, ticks } = manualRuntime(t);
	const job = overdue("wz-1");
	rt.jobs.set(job.id, job);
	const db = rt.openDb();
	acquireOwnership(db, taskKey(job.id), "s1", 1, "t", 1000);
	monitorJob(rt, job, () => {});
	beginRelease(db, taskKey(job.id), "s1", 1, 1100);

	for (const tick of ticks) tick();

	assert.equal(job.pendingStop, null, "no stop may start while the release runs");
	assert.equal(rt.monitors.size, 2, "the release can fail, so the monitor stays");
});

test("a native monitor stops when the task is released", async (t) => {
	const { rt, ticks } = manualRuntime(t);
	const job = overdue("wz-1");
	rt.jobs.set(job.id, job);
	const db = rt.openDb();
	acquireOwnership(db, taskKey(job.id), "s1", 1, "t", 1000);
	monitorNativeJob(rt, job, () => {});
	commitRelease(db, taskKey(job.id), "s1", 1, 1100);

	for (const tick of ticks) tick();

	assert.equal(job.pendingStop, null);
	assert.equal(rt.monitors.size, 0);
});
