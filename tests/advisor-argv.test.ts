/**
 * The advisor flag in the argv of an OMP worker.
 *
 * OMP has the flag `--advisor`. The extension asks for the advisor that the
 * user chose. A job without the flag asks for nothing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Job } from "../extensions/lib/job.ts";
import { ompArgv } from "../extensions/lib/omp-argv.ts";

/** A job that holds the advisor flag. */
function jobWith(advisor: boolean | null): Job {
	return {
		id: "wz-1",
		label: "worker",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		advisor,
		status: "queued",
		paneId: null,
		tabId: null,
		windowId: null,
		placement: "split",
		sessionDir: "/s/wz-1",
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: false,
		createdAt: 0,
		startedAt: null,
		finishedAt: null,
		result: null,
		error: null,
		worktreeDirty: null,
		pendingStop: null,
		lastActivityAt: 0,
		currentTool: null,
		turns: 0,
		baselineTurns: 0,
		usageBaseline: null,
		steers: 0,
		lastTranscriptSize: 0,
		paneClosed: false,
		nativeUsage: null,
		nativeCycles: 0,
	} as Job;
}

test("a job with the advisor asks OMP for the advisor", () => {
	const args = ompArgv(jobWith(true), null);
	assert.equal(args.includes("--advisor"), true, args.join(" "));
});

test("a job without the advisor asks OMP for nothing", () => {
	const args = ompArgv(jobWith(false), null);
	assert.equal(args.includes("--advisor"), false, args.join(" "));
});

test("a job from before the advisor field asks OMP for nothing", () => {
	const job = jobWith(false);
	delete job.advisor;
	const args = ompArgv(job, null);
	assert.equal(args.includes("--advisor"), false, args.join(" "));
});

test("a resumed job keeps the advisor of the source run", () => {
	const args = ompArgv(jobWith(true), "/s/wz-1/a.jsonl");
	assert.equal(args.includes("--advisor"), true, args.join(" "));
});
