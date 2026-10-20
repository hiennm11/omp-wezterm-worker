import assert from "node:assert/strict";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { deadlineMessage, finishedResult } from "../extensions/lib/monitor.ts";
import { emptySummary, type SessionSummary } from "../extensions/lib/transcript.ts";

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

/** A summary whose newest turn is a finished text answer. */
function answered(finalTextIndex: number): SessionSummary {
	return {
		...emptySummary(),
		finalText: "the answer",
		turns: finalTextIndex,
		turnsSinceLastUser: 1,
		finalTextIndex,
	};
}

test("a worker with no deadline never times out", () => {
	assert.equal(deadlineMessage(job(), START + 10 * 24 * 3600 * 1000), null);
});

test("a worker times out when the total deadline passes, even while it is active", () => {
	const active = job({ timeoutMs: 60_000, lastActivityAt: START + 59_000 });
	assert.equal(deadlineMessage(active, START + 59_000), null);
	assert.match(deadlineMessage(active, START + 61_000) ?? "", /timed out after 60s/);
});

test("a worker is stopped for idleness only when the idle deadline passes", () => {
	const quiet = job({ idleTimeoutMs: 30_000, lastActivityAt: START });
	assert.equal(deadlineMessage(quiet, START + 29_000), null);
	assert.match(deadlineMessage(quiet, START + 31_000) ?? "", /no activity for 30s/);
});

test("a worker that keeps writing is not stopped by the idle deadline", () => {
	const busy = job({ idleTimeoutMs: 30_000, lastActivityAt: START + 100_000 });
	assert.equal(deadlineMessage(busy, START + 120_000), null);
});

test("a turn that is still working has no result", () => {
	assert.equal(finishedResult(job(), emptySummary()), null);
});

test("a finished turn is the result", () => {
	assert.equal(finishedResult(job(), answered(1)), "the answer");
});

test("a resumed worker does not report the answer it already held", () => {
	const resumed = job({ baselineTurns: 3 });
	assert.equal(finishedResult(resumed, answered(3)), null);
	assert.equal(finishedResult(resumed, answered(4)), "the answer");
});
