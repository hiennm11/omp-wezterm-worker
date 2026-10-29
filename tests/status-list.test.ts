/**
 * The list of workers that the status tool shows.
 *
 * The registry holds more than a hundred workers. The tool shows the active
 * ones, the ones with an event that waits for the owner, and the newest of
 * the finished ones. The rest stay hidden, and the tool names the count.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type Job, freshRunState } from "../extensions/lib/job.ts";
import { selectStatusJobs } from "../extensions/lib/status-list.ts";

/** A worker with the given id, age and state. */
function job(id: string, createdAt: number, status: Job["status"]): Job {
	return {
		id,
		label: id,
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir: `/repo/${id}`,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(createdAt),
		status,
		createdAt,
	};
}

/** The ids of the workers of a result. */
function ids(jobs: Job[]): string[] {
	return jobs.map((entry) => entry.id);
}

test("12 finished workers show 10 and hide 2", () => {
	const jobs = Array.from({ length: 12 }, (_, index) => job(`wz-${index}`, index, "completed"));

	const result = selectStatusJobs(jobs, new Set(), 10);

	assert.equal(result.shown.length, 10);
	assert.equal(result.hidden, 2);
});

test("an active worker always shows", () => {
	const jobs = [
		job("wz-active", 1, "running"),
		...Array.from({ length: 12 }, (_, index) => job(`wz-${index}`, index + 2, "completed")),
	];

	const result = selectStatusJobs(jobs, new Set(), 10);

	assert.equal(result.shown.length, 11);
	assert.equal(result.hidden, 2);
	assert.ok(ids(result.shown).includes("wz-active"));
});

test("a finished worker with a pending event always shows", () => {
	const jobs = Array.from({ length: 12 }, (_, index) => job(`wz-${index}`, index, "completed"));

	const result = selectStatusJobs(jobs, new Set(["wz-0"]), 10);

	assert.equal(result.shown.length, 11);
	assert.equal(result.hidden, 1);
	assert.ok(ids(result.shown).includes("wz-0"));
});

test("no hidden worker gives hidden 0", () => {
	const jobs = [job("wz-0", 1, "running"), job("wz-1", 2, "completed")];

	const result = selectStatusJobs(jobs, new Set(), 10);

	assert.equal(result.shown.length, 2);
	assert.equal(result.hidden, 0);
});

test("the order is newest first inside each group", () => {
	const jobs = [
		job("wz-old-active", 1, "running"),
		job("wz-new-active", 5, "running"),
		job("wz-event", 2, "completed"),
		job("wz-finished-1", 9, "completed"),
		job("wz-finished-2", 7, "completed"),
	];

	const result = selectStatusJobs(jobs, new Set(["wz-event"]), 10);

	assert.deepEqual(ids(result.shown), ["wz-new-active", "wz-old-active", "wz-event", "wz-finished-1", "wz-finished-2"]);
});

test("no worker appears twice", () => {
	const jobs = [
		job("wz-active", 3, "running"),
		job("wz-finished", 1, "completed"),
	];

	const result = selectStatusJobs(jobs, new Set(["wz-active", "wz-finished"]), 10);

	assert.deepEqual(ids(result.shown), ["wz-active", "wz-finished"]);
	assert.equal(new Set(ids(result.shown)).size, result.shown.length);
});
