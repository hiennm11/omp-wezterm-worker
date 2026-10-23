import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { formatDelivery } from "../extensions/lib/deliver.ts";
import { freshRunState, isActive, type Job } from "../extensions/lib/job.ts";
import { cancelJob, settleDetachedJob, stopJob } from "../extensions/lib/lifecycle.ts";
import { monitorJob } from "../extensions/lib/monitor.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import type { WorkerReport } from "../extensions/lib/report-model.ts";
import { appendReport } from "../extensions/lib/report-store.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { usageReport } from "../extensions/lib/usage.ts";

const GONE = "[]";
const PRESENT = '[{"pane_id":7}]';

function runningJob(overrides: Partial<Job> = {}): Job {
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
		...overrides,
	};
}

interface Fake {
	rt: WorkerRuntime;
	/** What `wezterm cli list` answers. A number is an exit code. */
	list: { reply: string | number };
	kill: { stderr: string };
	cleanup: () => void;
}

function fake(listReply: string | number): Fake {
	const list = { reply: listReply };
	const kill = { stderr: "" };
	const exec: RunFn = async (_bin, args) => {
		if (args.includes("kill-pane")) return { code: kill.stderr ? 1 : 0, stdout: "", stderr: kill.stderr };
		if (args.includes("list")) {
			return typeof list.reply === "number"
				? { code: list.reply, stdout: "", stderr: "" }
				: { code: 0, stdout: list.reply, stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const stateDir = mkdtempSync(join(tmpdir(), "wz-stop-"));
	const rt = createRuntime(exec);
	rt.config.stateDir = stateDir;
	rt.stopConfirm = { attempts: 2, intervalMs: 1 };
	return {
		rt,
		list,
		kill,
		cleanup: () => {
			rt.db?.close();
			rt.db = null;
			rt.closeDb();
			rmSync(stateDir, { recursive: true, force: true });
		},
	};
}

test("a cancel ends the worker when the pane list shows the pane gone", async () => {
	const f = fake(GONE);
	try {
		const job = runningJob();
		const outcome = await cancelJob(f.rt, job);
		assert.equal(outcome.stopped, true);
		assert.equal(job.status, "cancelled");
		assert.equal(job.pendingStop, null);
		assert.equal(job.paneClosed, true);
	} finally {
		f.cleanup();
	}
});

test("a cancel that cannot confirm the close leaves the worker running, and a retry confirms it", async () => {
	const f = fake(PRESENT);
	try {
		const job = runningJob();
		const first = await cancelJob(f.rt, job);
		assert.equal(first.stopped, false);
		assert.ok(isActive(job));
		assert.match(job.pendingStop?.failure ?? "", /still open/);
		f.list.reply = GONE;
		const second = await cancelJob(f.rt, job);
		assert.equal(second.stopped, true);
		assert.equal(job.status, "cancelled");
	} finally {
		f.cleanup();
	}
});

test("an unreadable pane list is not read as a closed pane", async () => {
	const f = fake(1);
	try {
		const job = runningJob();
		const outcome = await cancelJob(f.rt, job);
		assert.equal(outcome.stopped, false);
		assert.match(job.pendingStop?.failure ?? "", /cannot be read/);
		assert.equal(job.status, "running");
	} finally {
		f.cleanup();
	}
});

test("a failed kill still counts as stopped when the pane list shows the pane gone", async () => {
	const f = fake(GONE);
	f.kill.stderr = "pane not found";
	try {
		const outcome = await cancelJob(f.rt, runningJob());
		assert.equal(outcome.stopped, true);
	} finally {
		f.cleanup();
	}
});

test("the monitor keeps a timed-out worker running until the stop is confirmed", async () => {
	const f = fake(PRESENT);
	try {
		let tick: () => void = () => {};
		f.rt.timers = {
			setInterval: (fn) => {
				tick = fn;
				return {} as NodeJS.Timeout;
			},
		};
		const job = runningJob({ timeoutMs: 1000, startedAt: Date.now() - 60_000 });
		f.rt.jobs.set(job.id, job);
		let notifications = 0;
		let pending = Promise.withResolvers<void>();
		monitorJob(f.rt, job, () => {
			notifications += 1;
			pending.resolve();
		});

		tick();
		await pending.promise;
		assert.equal(notifications, 1);
		assert.equal(job.status, "running");
		assert.match(
			formatDelivery(job, { worker: usageReport(null, "x"), request: usageReport(null, "x") }),
			/is not stopped/,
		);

		f.list.reply = GONE;
		pending = Promise.withResolvers<void>();
		tick();
		await pending.promise;
		assert.equal(notifications, 2);
		assert.equal(job.status, "failed");
		assert.match(job.error ?? "", /timed out/);
	} finally {
		f.cleanup();
	}
});

test("a stop that is already in progress is refused and changes nothing", async () => {
	const f = fake(GONE);
	try {
		const job = runningJob();
		f.rt.stopping.add(job.id);
		const outcome = await stopJob(f.rt, job, "cancelled", "x");
		assert.equal(outcome.stopped, false);
		assert.match(outcome.error ?? "", /already in progress/);
		assert.equal(job.pendingStop, null);
		assert.equal(job.status, "running");
	} finally {
		f.cleanup();
	}
});

test("a restored worker with a pending stop ends with the pending status once its pane is gone", async () => {
	const f = fake(GONE);
	try {
		const job = runningJob({
			pendingStop: { status: "cancelled", error: "Cancelled by the main agent", failure: "y" },
		});
		await settleDetachedJob(f.rt, job);
		assert.equal(job.status, "cancelled");
		assert.equal(job.pendingStop, null);
	} finally {
		f.cleanup();
	}
});

/** A session directory of a job, with the given reports. */
function sessionDirOf(rt: WorkerRuntime, jobId: string, reports: WorkerReport[]): string {
	const dir = join(rt.config.stateDir, "sessions", jobId);
	mkdirSync(dir, { recursive: true });
	for (const report of reports) appendReport(dir, report);
	return dir;
}

test("a restored worker whose report says completed ends completed with the result", async () => {
	const f = fake(GONE);
	try {
		const job = runningJob();
		job.sessionDir = sessionDirOf(f.rt, job.id, [
			{
				runId: job.id,
				cycleId: null,
				state: "completed",
				result: "THE-ANSWER",
				dependency: null,
				resumeCondition: null,
				needs: null,
				detail: null,
			},
		]);
		await settleDetachedJob(f.rt, job);
		assert.equal(job.status, "completed");
		assert.equal(job.result, "THE-ANSWER");
		assert.equal(job.error, null);
	} finally {
		f.cleanup();
	}
});

test("a restored worker without a report still ends failed with the pane error", async () => {
	const f = fake(GONE);
	try {
		const job = runningJob();
		job.sessionDir = sessionDirOf(f.rt, job.id, []);
		await settleDetachedJob(f.rt, job);
		assert.equal(job.status, "failed");
		assert.equal(job.result, null);
		assert.equal(job.error, "Worker pane was closed before this session re-attached");
	} finally {
		f.cleanup();
	}
});
