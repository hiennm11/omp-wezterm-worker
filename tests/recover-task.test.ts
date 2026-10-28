/**
 * The replay of a result that the old owner never delivered.
 *
 * A finished run has one delivery row in the state `sent` when its result
 * reached the main session. A run without that row lost its result in a
 * restart. A cancelled run has no delivery by design, because the cancel
 * tool replies at once.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { beginDelivery, markSent } from "../extensions/lib/delivery.ts";
import type { Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { recoverTask, replayUndelivered, runsToReplay } from "../extensions/lib/recover-task.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { fakeWezterm, jobOf, runtimeFor } from "./group-holder-helpers.ts";

/** A run that ended at the given time. */
function ended(id: string, status: Job["status"], finishedAt: number): Job {
	return jobOf(id, { status, finishedAt });
}

/** Give the task of a run to a session. */
function own(rt: WorkerRuntime, job: Job, session: string): void {
	rt.jobs.set(job.id, job);
	acquireOwnership(rt.openDb(), taskKey(job.id), session, 1, "t", 1000);
}

test("a finished run without a sent delivery is selected", () => {
	const jobs = [
		ended("a", "completed", 2000),
		ended("b", "failed", 2000),
		ended("c", "cancelled", 2000),
		ended("d", "completed", 2000),
		ended("e", "completed", 500),
		jobOf("f", { status: "running", finishedAt: null }),
	];

	const selected = runsToReplay(jobs, new Set(["d"]), 1000);

	assert.deepEqual(
		selected.map((job) => job.id),
		["a", "b"],
	);
});

test("without a mark every finished run that lacks a delivery is selected", () => {
	const jobs = [ended("old", "completed", 500), ended("new", "failed", 2000)];

	const selected = runsToReplay(jobs, new Set(), null);

	assert.deepEqual(
		selected.map((job) => job.id),
		["old", "new"],
	);
});

test("the replay sends only the result that this session owns and never delivered", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	rt.sessionId = "s1";
	own(rt, ended("wz-lost", "completed", 2000), "s1");
	own(rt, ended("wz-sent", "completed", 2000), "s1");
	own(rt, ended("wz-foreign", "completed", 2000), "s2");
	const db = rt.openDb();
	beginDelivery(db, "del-1", "wz-sent", 1, 1500);
	markSent(db, "del-1", "sendUserMessage", 1501);
	const notified: string[] = [];

	const replayed = replayUndelivered(
		rt,
		[...rt.jobs.values()],
		(job) => {
			notified.push(job.id);
		},
		null,
	);

	assert.deepEqual(notified, ["wz-lost"]);
	assert.deepEqual(
		replayed.map((job) => job.id),
		["wz-lost"],
	);
});

test("a delivery that throws does not stop the replay of the next run", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	rt.sessionId = "s1";
	own(rt, ended("wz-a", "completed", 2000), "s1");
	own(rt, ended("wz-b", "completed", 2000), "s1");
	const notified: string[] = [];

	const replayed = replayUndelivered(
		rt,
		[...rt.jobs.values()],
		(job) => {
			if (job.id === "wz-a") throw new Error("the host refused the message");
			notified.push(job.id);
		},
		null,
	);

	assert.deepEqual(notified, ["wz-b"]);
	assert.deepEqual(
		replayed.map((job) => job.id),
		["wz-b"],
	);
	assert.equal(rt.errors.length, 1);
	assert.match(rt.errors[0], /wz-a/);
});

test("the first recovery marks the time and replays no run that ended before it", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	rt.sessionId = "s1";
	own(rt, ended("wz-old", "completed", 2000), "s1");
	const notified: string[] = [];
	const notify = (job: Job): void => {
		notified.push(job.id);
	};

	recoverTask(rt, [...rt.jobs.values()], notify, 5000);
	assert.deepEqual(notified, []);
	assert.equal(rt.openDb().meta("delivery_replay_since"), "5000");

	own(rt, ended("wz-new", "completed", 6000), "s1");
	recoverTask(rt, [...rt.jobs.values()], notify, 7000);

	assert.deepEqual(notified, ["wz-new"]);
	assert.equal(rt.openDb().meta("delivery_replay_since"), "5000");
});
