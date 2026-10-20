import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_CONFIG } from "../extensions/lib/config.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { admitLaunch, isWorkerSession, launchRefusal, startRequest } from "../extensions/lib/limits.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";

const START = 1_000_000;

/** A running job that started at START. */
function job(overrides: Partial<Job> = {}): Job {
	return {
		id: "wz-test",
		label: "test",
		task: "task",
		cwd: "/work",
		model: null,
		tools: null,
		placement: "split",
		sessionDir: "/state/sessions/wz-test",
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(START),
		status: "running",
		startedAt: START,
		...overrides,
	};
}

function jobMap(...jobs: Job[]): Map<string, Job> {
	return new Map(jobs.map((j) => [j.id, j]));
}

const LIMITS = { maxActiveWorkers: 1, maxLaunchesPerRequest: 3 };

test("a worker transcript path is recognised on both path styles", () => {
	assert.equal(isWorkerSession("C:\\x\\sessions\\wz-mh2k1-3\\2026.jsonl"), true);
	assert.equal(isWorkerSession("/x/sessions/wz-a-b/s.jsonl"), true);
	assert.equal(isWorkerSession("C:\\Users\\u\\.omp\\agent\\sessions\\--D--repo--\\s.jsonl"), false);
	assert.equal(isWorkerSession(null), false);
	assert.equal(isWorkerSession(undefined), false);
});

test("an active worker blocks a launch at the default limit", () => {
	const refusal = launchRefusal(jobMap(job()), [], DEFAULT_CONFIG, null);
	assert.equal(refusal?.rule, "maxActiveWorkers");
	assert.match(refusal?.message ?? "", /maxActiveWorkers/);
});

test("a worker with an unconfirmed stop still counts as active", () => {
	const stopping = job({
		pendingStop: { status: "cancelled", error: "cancelled", failure: "pane still listed" },
	});
	assert.equal(launchRefusal(jobMap(stopping), [], LIMITS, null)?.rule, "maxActiveWorkers");
});

test("finished workers do not block a launch", () => {
	const done = jobMap(job({ id: "wz-a-1", status: "completed" }), job({ id: "wz-a-2", status: "failed" }));
	assert.equal(launchRefusal(done, [], LIMITS, null), null);
});

test("a limit of 0 disables the active worker limit", () => {
	const many = jobMap(...[1, 2, 3, 4, 5].map((n) => job({ id: `wz-a-${n}` })));
	assert.equal(launchRefusal(many, [], { ...LIMITS, maxActiveWorkers: 0 }, null), null);
});

test("the request limit counts launches that reached a pane", () => {
	const limits = { maxActiveWorkers: 0, maxLaunchesPerRequest: 2 };
	const jobs = jobMap(job({ id: "wz-a-1", status: "completed" }), job({ id: "wz-a-2", status: "completed" }));
	assert.equal(launchRefusal(jobs, ["wz-a-1", "wz-a-2"], limits, null)?.rule, "maxLaunchesPerRequest");
});

test("a launch that failed before its pane existed does not count", () => {
	const limits = { maxActiveWorkers: 0, maxLaunchesPerRequest: 2 };
	const jobs = jobMap(
		job({ id: "wz-a-1", status: "completed" }),
		job({ id: "wz-a-2", status: "failed", startedAt: null }),
	);
	assert.equal(launchRefusal(jobs, ["wz-a-1", "wz-a-2"], limits, null), null);
});

test("a reserved id with no job yet counts", () => {
	const limits = { maxActiveWorkers: 0, maxLaunchesPerRequest: 2 };
	const jobs = jobMap(job({ id: "wz-a-1", status: "completed" }));
	assert.equal(launchRefusal(jobs, ["wz-a-1", "wz-a-2"], limits, null)?.rule, "maxLaunchesPerRequest");
});

test("the nested worker rule wins over the other rules", () => {
	const refusal = launchRefusal(jobMap(job()), [], LIMITS, "/x/sessions/wz-a-b/s.jsonl");
	assert.equal(refusal?.rule, "nestedWorker");
	assert.match(refusal?.message ?? "", /cannot launch another worker/);
});

test("admitLaunch reserves ids and a refusal changes nothing", () => {
	const rt = createRuntime();
	rt.config = { ...DEFAULT_CONFIG, maxActiveWorkers: 0, maxLaunchesPerRequest: 2 };

	const first = admitLaunch(rt, null);
	const second = admitLaunch(rt, null);
	assert.ok("jobId" in first && "jobId" in second);
	assert.deepEqual(rt.requestLaunches, [
		(first as { jobId: string }).jobId,
		(second as { jobId: string }).jobId,
	]);

	const third = admitLaunch(rt, null);
	assert.ok("refusal" in third);
	assert.equal(rt.requestLaunches.length, 2);
});

test("a user prompt starts a new request", () => {
	const rt = createRuntime();
	rt.config = { ...DEFAULT_CONFIG, maxActiveWorkers: 0, maxLaunchesPerRequest: 1 };
	assert.ok("jobId" in admitLaunch(rt, null));
	assert.ok("refusal" in admitLaunch(rt, null));

	startRequest(rt);
	assert.deepEqual(rt.requestLaunches, []);
	assert.ok("jobId" in admitLaunch(rt, null));
});
