import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyObservation, createClaudeRunState } from "../extensions/lib/claude-run-state.ts";
import { eventsOfRun } from "../extensions/lib/events.ts";
import { executionsOfRun, openExecution } from "../extensions/lib/executions.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { finalizeJob } from "../extensions/lib/lifecycle.ts";
import { monitorJob } from "../extensions/lib/monitor.ts";
import { nativeJobUsageReport } from "../extensions/lib/native-usage-report.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime } from "../extensions/lib/runtime.ts";
import { writeTranscript } from "./execution-helpers.ts";

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

test("the measured usage of a native run stays readable after the run ends", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-lifecycle-usage-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		const job: Job = { ...runningJob(), backend: "claude" };
		rt.jobs.set(job.id, job);

		const state = createClaudeRunState(job.id);
		applyObservation(state, {
			backend: "claude",
			runId: job.id,
			sessionId: null,
			source: "turn.complete",
			payload: { usage: { input_tokens: 120, output_tokens: 30 } },
		});
		rt.claudeStates.set(job.id, state);

		await finalizeJob(rt, job, "completed", null, "done");

		assert.equal(rt.claudeStates.has(job.id), false);
		const report = nativeJobUsageReport(job, null);
		assert.equal(report.state, "measured");
		assert.equal(report.totals?.turns.input, 120);
		assert.equal(report.totals?.turns.output, 30);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("the cycle count of a native run stays readable after the run ends", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-lifecycle-cycles-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		const job: Job = { ...runningJob(), backend: "claude" };
		rt.jobs.set(job.id, job);

		const state = createClaudeRunState(job.id);
		applyObservation(state, {
			backend: "claude",
			runId: job.id,
			sessionId: null,
			source: "turn.start",
			payload: { turnId: "turn-1" },
		});
		applyObservation(state, {
			backend: "claude",
			runId: job.id,
			sessionId: null,
			source: "turn.start",
			payload: { turnId: "turn-2" },
		});
		rt.claudeStates.set(job.id, state);

		await finalizeJob(rt, job, "completed", null, "done");

		assert.equal(job.nativeCycles, 2);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a failed native worker marks its open execution rows unknown and creates the event", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-lifecycle-native-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		const sessionDir = join(stateDir, "sessions", "wz-1");
		mkdirSync(sessionDir, { recursive: true });
		const job: Job = { ...runningJob(), backend: "claude", sessionDir, sessionFile: null };
		rt.jobs.set(job.id, job);
		const db = rt.openDb();
		openExecution(
			db,
			`ex-${job.id}-call-1`,
			job.id,
			"tool",
			"bash",
			"call-1",
			null,
			"tool.call.opened",
			"bridge",
			1000,
		);

		await finalizeJob(rt, job, "failed", "the native worker crashed", null);

		const rows = executionsOfRun(db, job.id);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].state, "unknown");
		const events = eventsOfRun(db, job.id);
		assert.equal(events.length, 1);
		assert.equal(events[0].condition, "execution_loss");
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a failed native worker without execution rows creates no event", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-lifecycle-native-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		const sessionDir = join(stateDir, "sessions", "wz-1");
		mkdirSync(sessionDir, { recursive: true });
		const job: Job = { ...runningJob(), backend: "claude", sessionDir, sessionFile: null };
		rt.jobs.set(job.id, job);

		await finalizeJob(rt, job, "failed", "the native worker crashed", null);

		const events = eventsOfRun(rt.openDb(), job.id);
		assert.equal(events.length, 0);
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a failed worker marks its open execution rows unknown and creates the event", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-lifecycle-ledger-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = stateDir;
	try {
		const sessionDir = join(stateDir, "sessions", "wz-1");
		const file = writeTranscript(sessionDir, "a.jsonl", [
			{ type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
			{
				type: "message",
				id: "e1",
				message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash" }] },
			},
		]);
		const job: Job = { ...runningJob(), sessionDir, sessionFile: file };
		rt.jobs.set(job.id, job);

		await finalizeJob(rt, job, "failed", "the worker crashed", null);

		const db = rt.openDb();
		const rows = executionsOfRun(db, job.id);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].state, "unknown");
		const events = eventsOfRun(db, job.id);
		assert.equal(events.length, 1);
		assert.equal(events[0].condition, "execution_loss");
	} finally {
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});
