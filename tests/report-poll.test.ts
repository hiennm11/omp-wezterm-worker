/**
 * The report poll of a watched worker.
 *
 * A completion report ends the worker only when no execution row of the run
 * is outstanding. A call that has no result keeps the worker alive.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorJob } from "../extensions/lib/monitor.ts";
import type { WorkerReport } from "../extensions/lib/report-model.ts";
import { appendReport } from "../extensions/lib/report-store.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { writeTranscript } from "./execution-helpers.ts";

/** A user message that starts a cycle. */
const USER = {
	type: "message",
	id: "e0",
	message: { role: "user", content: [{ type: "text", text: "do it" }] },
};

/** A tool call in an assistant message. */
function call(id: string, name: string): unknown {
	return {
		type: "message",
		id: `m-${id}`,
		message: { role: "assistant", content: [{ type: "toolCall", id, name }] },
	};
}

/** A tool result that settles the call with the same id. */
function result(id: string): unknown {
	return {
		type: "message",
		id: `r-${id}`,
		message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }] },
	};
}

/** The report that a worker sends when its task is done. */
function completedReport(runId: string): WorkerReport {
	return {
		runId,
		cycleId: null,
		state: "completed",
		result: "THE-ANSWER",
		dependency: null,
		resumeCondition: null,
		needs: null,
		detail: null,
	};
}

/** A runtime whose polls run only when the test calls them. */
function fakeRuntime(stateDir: string): { rt: WorkerRuntime; tick: () => void } {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }) as never);
	rt.config.stateDir = stateDir;
	let tick: () => void = () => {};
	rt.timers = {
		setInterval: (fn) => {
			tick = fn;
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	return { rt, tick: () => tick() };
}

/** A running worker with a session directory. */
function runningJob(sessionDir: string): Job {
	return {
		id: "wz-1",
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(Date.now()),
		status: "running",
		paneId: 7,
	};
}

test("the report poll keeps a worker that has an open call", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-reportpoll-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	const { rt, tick } = fakeRuntime(stateDir);
	try {
		const file = writeTranscript(sessionDir, "a.jsonl", [USER, call("call-1", "bash")]);
		const job = runningJob(sessionDir);
		job.sessionFile = file;
		rt.jobs.set(job.id, job);
		appendReport(sessionDir, completedReport(job.id));

		let ended = 0;
		monitorJob(rt, job, () => {
			ended += 1;
		});
		tick();

		assert.equal(job.status, "running", "the open call keeps the worker alive");
		assert.equal(ended, 0);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("the report poll ends a worker when the result of its call arrives", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-reportpoll-"));
	const sessionDir = join(stateDir, "sessions", "wz-1");
	const { rt, tick } = fakeRuntime(stateDir);
	try {
		const file = writeTranscript(sessionDir, "a.jsonl", [USER, call("call-1", "bash")]);
		const job = runningJob(sessionDir);
		job.sessionFile = file;
		rt.jobs.set(job.id, job);
		appendReport(sessionDir, completedReport(job.id));

		let ended = 0;
		const notified = Promise.withResolvers<void>();
		monitorJob(rt, job, () => {
			ended += 1;
			notified.resolve();
		});
		tick();
		assert.equal(job.status, "running");

		writeTranscript(sessionDir, "a.jsonl", [USER, call("call-1", "bash"), result("call-1")]);
		tick();
		await notified.promise;

		assert.equal(job.status, "completed", "the settled call lets the worker end");
		assert.equal(job.result, "THE-ANSWER");
		assert.equal(ended, 1);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});
