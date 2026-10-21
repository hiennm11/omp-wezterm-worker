import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { finalizeJob } from "../extensions/lib/lifecycle.ts";
import { monitorJob } from "../extensions/lib/monitor.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";

function runningJob(): Job {
	return {
		id: "wz-1",
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir: "/s/wz-1",
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		status: "running",
		paneId: 7,
	};
}

async function finalizeWith(exec: RunFn, overrides: Partial<Job> = {}): Promise<Job> {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-lifecycle-"));
	const rt = createRuntime(exec);
	rt.config.stateDir = stateDir;
	try {
		const job = { ...runningJob(), ...overrides };
		rt.jobs.set(job.id, job);
		await finalizeJob(rt, job, "completed", null, "done");
		return job;
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
}

function recordingExec(code: number, calls: string[][]): RunFn {
	return async (_bin, args) => {
		calls.push(args);
		return { code, stdout: "", stderr: code === 0 ? "" : "pane not found" };
	};
}

const kills = (calls: string[][]) => calls.filter((args) => args.includes("kill-pane")).length;

test("a finished worker records its pane as closed when the kill succeeds", async () => {
	const job = await finalizeWith(async () => ({ code: 0, stdout: "", stderr: "" }));
	assert.equal(job.paneClosed, true);
});

test("a failed pane kill does not record the pane as closed", async () => {
	const job = await finalizeWith(async () => ({ code: 1, stdout: "", stderr: "pane not found" }));
	assert.equal(job.status, "completed");
	assert.equal(job.paneClosed, false);
});

test("a finished worker keeps its pane when closePaneOnFinish is false", async () => {
	const calls: string[][] = [];
	const job = await finalizeWith(recordingExec(0, calls), { closePaneOnFinish: false });
	assert.equal(kills(calls), 0);
	assert.equal(job.paneClosed, false);
});

test("the monitor kills the pane of a worker that passes its deadline when closePaneOnFinish is false", async () => {
	const calls: string[][] = [];
	const stateDir = mkdtempSync(join(tmpdir(), "wz-lifecycle-"));
	const exec: RunFn = async (_bin, args) => {
		calls.push(args);
		return { code: 0, stdout: args.includes("list") ? "[]" : "", stderr: "" };
	};
	const rt = createRuntime(exec);
	try {
		rt.stopConfirm = { attempts: 2, intervalMs: 1 };
		rt.config.stateDir = stateDir;
		let tick: () => void = () => {};
		rt.timers = {
			setInterval: (fn) => {
				tick = fn;
				return setTimeout(() => {}, 0);
			},
		};
		const job: Job = {
			...runningJob(),
			closePaneOnFinish: false,
			timeoutMs: 1000,
			startedAt: Date.now() - 60_000,
		};
		rt.jobs.set(job.id, job);
		const { promise: notified, resolve } = Promise.withResolvers<void>();
		monitorJob(rt, job, () => resolve());
		tick();
		await notified;
		assert.equal(job.status, "failed");
		assert.match(job.error ?? "", /timed out/);
		assert.equal(kills(calls), 1);
		assert.equal(job.paneClosed, true);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});
