/**
 * The proof that a worker took its task.
 *
 * The check of the evidence is a pure function of the session directory and
 * of the clock. The tests need no pane and no process.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import {
	awaitDelivery,
	DEFAULT_DELIVERY_BOUND,
	type DeliveryBound,
	deliveryAction,
	deliveryBaseline,
	deliveryEvidence,
} from "../extensions/lib/launch-delivery.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { writeSessionTranscript } from "./delivery-helpers.ts";
import { type HerdrFake, herdrFake } from "./herdr-fake.ts";

/** A bound that does not wait. */
const FAST: DeliveryBound = { intervalMs: 1, attempts: 3 };

/** A session directory in a fresh directory. */
function sessionDir(): { dir: string; sessionDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-delivery-"));
	const session = join(dir, "session");
	mkdirSync(session, { recursive: true });
	return { dir, sessionDir: session };
}

/** The job of a worker that runs in a pane. */
function worker(sessionDir: string): Job {
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
		...freshRunState(0),
		status: "running",
		paneId: "w4:p1",
		runtime: "herdr",
	};
}

/** A runtime whose Herdr answers with the given fake. */
function runtimeWith(fake: HerdrFake): WorkerRuntime {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.herdr = async (args) => fake.answer(args);
	rt.paneRuntime = "herdr";
	return rt;
}

test("the default bound waits 1000 ms and polls 30 times", () => {
	assert.deepEqual(DEFAULT_DELIVERY_BOUND, { intervalMs: 1000, attempts: 30 });
});

test("a session file that the send created is the evidence", () => {
	const { dir, sessionDir: session } = sessionDir();
	try {
		const baseline = deliveryBaseline(session);
		assert.equal(deliveryEvidence(session, baseline), false);
		writeFileSync(join(session, "new.jsonl"), "{}\n", "utf8");
		assert.equal(deliveryEvidence(session, baseline), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a transcript that grew past the size of the baseline is the evidence", () => {
	const { dir, sessionDir: session } = sessionDir();
	try {
		writeFileSync(join(session, "a.jsonl"), "{}\n", "utf8");
		const baseline = deliveryBaseline(session);
		assert.equal(deliveryEvidence(session, baseline), false);
		writeFileSync(join(session, "a.jsonl"), "{}\n{}\n", "utf8");
		assert.equal(deliveryEvidence(session, baseline), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a transcript of the size of the baseline is no evidence", () => {
	const { dir, sessionDir: session } = sessionDir();
	try {
		writeFileSync(join(session, "a.jsonl"), "{}\n", "utf8");
		const baseline = deliveryBaseline(session);
		writeFileSync(join(session, "a.jsonl"), "{}\n", "utf8");
		assert.equal(deliveryEvidence(session, baseline), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the action waits before the bound and sends one Enter at the bound", () => {
	assert.equal(deliveryAction(0, false, FAST), "wait");
	assert.equal(deliveryAction(2, false, FAST), "wait");
	assert.equal(deliveryAction(3, false, FAST), "enter");
});

test("the action fails after the Enter and the bound", () => {
	assert.equal(deliveryAction(0, true, FAST), "wait");
	assert.equal(deliveryAction(2, true, FAST), "wait");
	assert.equal(deliveryAction(3, true, FAST), "fail");
});

test("the wait sends one Enter and returns when the worker took the task", async () => {
	const { dir, sessionDir: session } = sessionDir();
	const fake = herdrFake();
	const rt = runtimeWith(fake);
	try {
		const job = worker(session);
		const baseline = deliveryBaseline(session);
		/* The worker writes its transcript when the Enter arrives. */
		const original = fake.answer;
		rt.herdr = async (args) => {
			const res = await original(args);
			if (args[0] === "pane" && args[1] === "send-keys") writeSessionTranscript(session);
			return res;
		};
		const result = await awaitDelivery(rt, job, baseline, FAST);
		assert.equal(result.delivered, true, result.error ?? "");
		assert.equal(result.error, null);
		const keys = fake.calls.filter((args) => args[0] === "pane" && args[1] === "send-keys");
		assert.equal(keys.length, 1, "the launch sent more than one Enter");
		assert.deepEqual(keys[0], ["pane", "send-keys", "w4:p1", "enter"]);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the wait fails when the worker never took the task", async () => {
	const { dir, sessionDir: session } = sessionDir();
	const fake = herdrFake();
	const rt = runtimeWith(fake);
	try {
		const job = worker(session);
		const baseline = deliveryBaseline(session);
		const result = await awaitDelivery(rt, job, baseline, FAST);
		assert.equal(result.delivered, false);
		assert.match(result.error ?? "", /not delivered/);
		const keys = fake.calls.filter((args) => args[0] === "pane" && args[1] === "send-keys");
		assert.equal(keys.length, 1, "the launch sent more than one Enter");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the wait sends no Enter when the worker took the task at once", async () => {
	const { dir, sessionDir: session } = sessionDir();
	const fake = herdrFake();
	const rt = runtimeWith(fake);
	try {
		const job = worker(session);
		/* The baseline is taken before the send. The send creates the
		   transcript, so the transcript is the evidence. */
		const baseline = deliveryBaseline(session);
		writeFileSync(join(session, "a.jsonl"), "{}\n", "utf8");
		const result = await awaitDelivery(rt, job, baseline, FAST);
		assert.equal(result.delivered, true, result.error ?? "");
		const keys = fake.calls.filter((args) => args[0] === "pane" && args[1] === "send-keys");
		assert.equal(keys.length, 0, "the launch sent an Enter that it did not need");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});
