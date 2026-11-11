/**
 * The launch proves that the worker took its task.
 *
 * A launch that reports a running worker must hold the evidence that the
 * worker received the task. The OMP TUI renders a long multi-line task as a
 * pasted block, and the Enter of the agent prompt does not submit that block.
 *
 * The tests use the fake of the Herdr CLI. No pane is needed.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { launchProgram } from "../extensions/lib/pane-launch.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { type HerdrFake, herdrFake } from "./herdr-fake.ts";

/**
 * A bound that keeps the test short.
 *
 * The window before the Enter must hold the delay of the delivery, so the
 * launch finds the evidence before it sends the Enter key.
 */
const FAST = { intervalMs: 20, attempts: 5 };

/** The delay of a worker that needs a moment before it writes its transcript. */
const DELIVERY_DELAY_MS = 30;

/** The task of a worker. It has many lines, like a real task. */
const TASK = "# Goal\nDo the work.\n\n- a line\n- another line";

/** A session directory in a fresh directory. */
function sessionDir(): { dir: string; sessionDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-launch-delivery-"));
	const session = join(dir, "session");
	mkdirSync(session, { recursive: true });
	return { dir, sessionDir: session };
}

/** The job of a worker that runs in a pane. */
function worker(sessionDir: string): Job {
	return {
		id: "wz-1",
		label: "test",
		task: TASK,
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
		...freshRunState(0),
		status: "queued",
		paneId: null,
		runtime: "herdr",
	};
}

/** A runtime whose Herdr answers with the given fake. */
function runtimeWith(fake: HerdrFake): WorkerRuntime {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.herdr = async (args) => fake.answer(args);
	rt.paneRuntime = "herdr";
	rt.deliveryBound = FAST;
	return rt;
}

/** The key presses that the fake received. */
function keysOf(fake: HerdrFake): string[][] {
	return fake.calls.filter((args) => args[0] === "pane" && args[1] === "send-keys");
}

/** The prompts that the fake received. */
function promptsOf(fake: HerdrFake): string[][] {
	return fake.calls.filter((args) => args[0] === "agent" && args[1] === "prompt");
}

test("a task that arrives at once needs no Enter and keeps the pane", async () => {
	const { dir, sessionDir: session } = sessionDir();
	/* The worker needs a moment before it writes its transcript. The launch
	   must wait for that moment, and it must not send an Enter. */
	const fake = herdrFake({
		delivery: "at-once",
		sessionDir: session,
		deliveryDelayMs: DELIVERY_DELAY_MS,
	});
	const rt = runtimeWith(fake);
	try {
		const job = worker(session);
		const started = Date.now();
		const failure = await launchProgram(rt, job, "omp", ["--no-title"], undefined, TASK);
		const waited = Date.now() - started;
		assert.equal(failure, null, `the launch failed: ${failure}`);
		assert.equal(job.status, "running");
		assert.ok(job.paneId, "the launch left the job without a pane");
		assert.ok(waited >= DELIVERY_DELAY_MS, `the launch did not wait for the evidence: ${waited}ms`);
		assert.deepEqual(keysOf(fake), [], "the launch sent an Enter that it did not need");
		assert.equal(promptsOf(fake).length, 1, "the launch sent the task more than once");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a task that arrives only after the Enter gets exactly one Enter", async () => {
	const { dir, sessionDir: session } = sessionDir();
	const fake = herdrFake({ delivery: "after-enter", sessionDir: session });
	const rt = runtimeWith(fake);
	try {
		const job = worker(session);
		const failure = await launchProgram(rt, job, "omp", ["--no-title"], undefined, TASK);
		assert.equal(failure, null, `the launch failed: ${failure}`);
		assert.equal(job.status, "running");
		assert.ok(job.paneId, "the launch left the job without a pane");
		const keys = keysOf(fake);
		assert.equal(keys.length, 1, "the launch sent more than one Enter");
		assert.deepEqual(keys[0], ["pane", "send-keys", job.paneId, "enter"]);
		assert.equal(promptsOf(fake).length, 1, "the launch sent the task more than once");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a task that never arrives fails the launch and closes the pane", async () => {
	const { dir, sessionDir: session } = sessionDir();
	const fake = herdrFake({ delivery: "never", sessionDir: session });
	const rt = runtimeWith(fake);
	try {
		const job = worker(session);
		const failure = await launchProgram(rt, job, "omp", ["--no-title"], undefined, TASK);
		assert.ok(failure, "the launch reported a running worker without the evidence");
		assert.match(failure ?? "", /not delivered/);
		assert.equal(job.paneId, null, "the launch left the pane of the worker behind");
		assert.equal(fake.closed.length, 1, "the launch closed no pane");
		const keys = keysOf(fake);
		assert.equal(keys.length, 1, "the launch sent more than one Enter");
		assert.equal(promptsOf(fake).length, 1, "the launch sent the task more than once");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a launch without a task sends no prompt and no Enter", async () => {
	const { dir, sessionDir: session } = sessionDir();
	const fake = herdrFake({ delivery: "never", sessionDir: session });
	const rt = runtimeWith(fake);
	try {
		const job = worker(session);
		const failure = await launchProgram(rt, job, "omp", ["--no-title"]);
		assert.equal(failure, null, `the launch failed: ${failure}`);
		assert.equal(job.status, "running");
		assert.deepEqual(promptsOf(fake), []);
		assert.deepEqual(keysOf(fake), []);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});
