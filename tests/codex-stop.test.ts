/**
 * The stop of a Codex worker.
 *
 * A Codex worker owns an app server and a TUI. A stop must end the turn,
 * end the program of the app server and close both panes. The tests use the
 * fakes of the Codex spawn, so no real program runs.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { applyObservation } from "../extensions/lib/claude-run-state.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { cancelJob, finalizeJob } from "../extensions/lib/lifecycle.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { spawnCodexWorker } from "../extensions/lib/spawn-codex.ts";
import { type CodexFake, type CodexFakeOptions, codexFake } from "./codex-spawn-helpers.ts";

/**
 * The launch of one Codex worker.
 *
 * The helper runs the real spawn with the fake runtime. It returns the job
 * and the fake, so a test can read both.
 */
async function launch(options: CodexFakeOptions = {}): Promise<{ job: Job; fake: CodexFake }> {
	const fake = codexFake(options);
	const job = await spawnCodexWorker(
		fake.rt,
		{ jobId: "wz-codex-stop", task: "Reply with the single word OK.", cwd: fake.dir },
		{ connect: fake.connect, serverWaitMs: options.serverWaitMs ?? 100 },
	);
	return { job, fake };
}

/** Open a turn in the run state of a worker. */
function openTurn(fake: CodexFake, job: Job, turnId: string): void {
	const state = fake.rt.claudeStates.get(job.id);
	assert.ok(state, "the run holds no state");
	applyObservation(state, {
		backend: "codex",
		runId: job.id,
		sessionId: null,
		source: "turn.start",
		payload: { turnId },
	});
}

/** The requests that the client made for one method. */
function callsOf(fake: CodexFake, method: string): { method: string; params: Record<string, unknown> }[] {
	return fake.clientCalls.filter((call) => call.method === method);
}

/** A runtime that answers like a machine with one pane. */
function paneFake(): { rt: WorkerRuntime; calls: string[][]; cleanup: () => void } {
	const panes = new Set<number>([7]);
	const calls: string[][] = [];
	const exec: RunFn = async (bin, args) => {
		calls.push([bin, ...args]);
		if (args.includes("kill-pane")) {
			panes.delete(Number(args[args.indexOf("--pane-id") + 1]));
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args.includes("list")) {
			const listing = [...panes].map((pane_id) => ({ pane_id }));
			return { code: 0, stdout: JSON.stringify(listing), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const stateDir = `${process.cwd()}/.tmp-codex-stop-${process.pid}`;
	const rt = createRuntime(exec);
	rt.config.stateDir = stateDir;
	rt.stopConfirm = { attempts: 2, intervalMs: 1 };
	return {
		rt,
		calls,
		cleanup: () => {
			rt.closeDb();
			rmSync(stateDir, { recursive: true, force: true });
		},
	};
}

/** A worker of a backend that is not Codex. */
function plainJob(backend: "omp" | "claude"): Job {
	return {
		id: `wz-${backend}`,
		label: backend,
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir: "/s/wz-plain",
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
		backend,
	};
}

test("a cancel of a Codex worker ends the server program, closes both panes and closes the client", async () => {
	const { job, fake } = await launch();
	openTurn(fake, job, "turn-9");
	try {
		const outcome = await cancelJob(fake.rt, job);
		assert.equal(outcome.stopped, true);
		assert.equal(job.status, "cancelled");
		assert.equal(job.pendingStop, null);
		assert.equal(fake.taskkills.length, 1, "the program of the app server stayed alive");
		assert.equal(fake.killedPanes.includes(11), true, "the pane of the app server stayed open");
		assert.equal(fake.killedPanes.includes(12), true, "the pane of the TUI stayed open");
		assert.equal(fake.panes.size, 0, "a pane stayed open");
		assert.equal(fake.clientCloses, 1, "the client of the app server stayed open");
		assert.equal(fake.rt.codexClients.has(job.id), false, "the client stayed in the runtime");
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
	}
});

test("a cancel of a Codex worker interrupts the open turn", async () => {
	const { job, fake } = await launch();
	openTurn(fake, job, "turn-9");
	try {
		await cancelJob(fake.rt, job);
		const interrupts = callsOf(fake, "turn/interrupt");
		assert.equal(interrupts.length, 1, "the turn was not interrupted");
		assert.equal(interrupts[0].params.threadId, "thread-1");
		assert.equal(interrupts[0].params.turnId, "turn-9");
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
	}
});

test("a cancel while no turn is open sends no interrupt", async () => {
	const { job, fake } = await launch();
	try {
		await cancelJob(fake.rt, job);
		assert.equal(callsOf(fake, "turn/interrupt").length, 0);
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
	}
});

test("a cancel after the turn ended sends no interrupt", async () => {
	const { job, fake } = await launch();
	openTurn(fake, job, "turn-9");
	const state = fake.rt.claudeStates.get(job.id);
	assert.ok(state, "the run holds no state");
	applyObservation(state, {
		backend: "codex",
		runId: job.id,
		sessionId: null,
		source: "turn.complete",
		payload: { turnId: "turn-9" },
	});
	try {
		await cancelJob(fake.rt, job);
		assert.equal(callsOf(fake, "turn/interrupt").length, 0);
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
	}
});

test("a cancel that cannot end a step leaves the worker running, and a retry confirms it", async () => {
	const { job, fake } = await launch({ taskkillFailures: 1 });
	openTurn(fake, job, "turn-9");
	try {
		const first = await cancelJob(fake.rt, job);
		assert.equal(first.stopped, false);
		assert.equal(job.status, "running");
		assert.ok(job.pendingStop, "the stop is not pending");
		assert.match(job.pendingStop?.failure ?? "", /app server/);
		const second = await cancelJob(fake.rt, job);
		assert.equal(second.stopped, true);
		assert.equal(job.status, "cancelled");
		assert.equal(job.pendingStop, null);
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
	}
});

test("a run that completes closes its client", async () => {
	const { job, fake } = await launch();
	try {
		await finalizeJob(fake.rt, job, "completed", null, "OK");
		assert.equal(fake.clientCloses, 1, "the client of the app server stayed open");
		assert.equal(fake.rt.codexClients.has(job.id), false, "the client stayed in the runtime");
	} finally {
		await fake.closeBridges();
		fake.rt.closeDb();
	}
});

test("a cancel of an OMP worker and of a Claude worker ends no program of Codex", async () => {
	for (const backend of ["omp", "claude"] as const) {
		const f = paneFake();
		try {
			const job = plainJob(backend);
			const outcome = await cancelJob(f.rt, job);
			assert.equal(outcome.stopped, true, `${backend} did not stop`);
			assert.equal(job.status, "cancelled");
			const kills = f.calls.filter((args) => args.includes("taskkill"));
			assert.deepEqual(kills, [], `${backend} ended a program of Codex`);
		} finally {
			f.cleanup();
		}
	}
});
