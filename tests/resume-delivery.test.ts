/**
 * The launch of a resume.
 *
 * A resume shares the transcript of its source run. The memory plugin
 * appends an entry at the start of every session, so the size of that
 * transcript proves nothing about the delivery of the message.
 *
 * The fake of Herdr models the two cases of issue 249. The fake appends
 * only a bootstrap entry, and the message stays in the composer. The fake
 * records the message, and the resume succeeds.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createGroup } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { resumeWorker } from "../extensions/lib/spawn.ts";
import { writeSourceTranscript } from "./delivery-helpers.ts";
import type { HerdrFake } from "./herdr-fake.ts";
import { resumeFake } from "./resume-delivery-helpers.ts";

/** The message of a resume. */
const MESSAGE = "Continue with the parser only";

/** A bound that keeps the test short. */
const FAST = { intervalMs: 10, attempts: 3 };

/** A session directory in a fresh directory. */
function sessionDir(): { dir: string; sessionDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-resume-delivery-"));
	const session = join(dir, "session");
	mkdirSync(session, { recursive: true });
	return { dir, sessionDir: session };
}

/** The source run of a resume. */
function sourceJob(session: string): Job {
	return {
		id: "wz-source-1",
		label: "source",
		task: "Read the parser.",
		cwd: process.cwd(),
		model: null,
		tools: null,
		placement: "split",
		sessionDir: session,
		sessionFile: join(session, "session.jsonl"),
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(Date.now()),
		status: "completed",
		paneId: null,
		runtime: "herdr",
	};
}

/** A runtime whose Herdr answers with the given fake. */
function runtimeWith(fake: HerdrFake, dir: string): WorkerRuntime {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.herdr = async (args) => fake.answer(args);
	rt.paneRuntime = "herdr";
	rt.deliveryBound = FAST;
	rt.config.stateDir = join(dir, "state");
	rt.config.runtime = "herdr";
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

test("a resume whose message stays in the composer fails after the bound", async () => {
	const { dir, sessionDir: session } = sessionDir();
	const fake = resumeFake("bootstrap-only", session);
	const rt = runtimeWith(fake, dir);
	try {
		writeSourceTranscript(session);
		const source = sourceJob(session);
		createGroup(rt.openDb(), "grp-wz-source-1", session, Date.now());

		const resumed = await resumeWorker(rt, source, { jobId: "wz-resume-1", message: MESSAGE });

		assert.equal(resumed.status, "failed", "the resume reported a running worker without the proof");
		assert.match(resumed.error ?? "", /not delivered/);
		assert.equal(resumed.paneId, null, "the resume left the pane of the worker behind");
		assert.equal(fake.closed.length, 1, "the resume closed no pane");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume whose message reaches the transcript succeeds", async () => {
	const { dir, sessionDir: session } = sessionDir();
	const fake = resumeFake("message", session);
	const rt = runtimeWith(fake, dir);
	try {
		writeSourceTranscript(session);
		const source = sourceJob(session);
		createGroup(rt.openDb(), "grp-wz-source-1", session, Date.now());

		const resumed = await resumeWorker(rt, source, { jobId: "wz-resume-1", message: MESSAGE });

		assert.equal(resumed.status, "running", resumed.error ?? "the resume failed");
		assert.ok(resumed.paneId, "the resume left the job without a pane");
		assert.equal(promptsOf(fake).length, 1, "the resume sent the message more than once");
		assert.deepEqual(keysOf(fake), [], "the resume sent an Enter that it did not need");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume sends one Enter after the bound and never sends the message twice", async () => {
	const { dir, sessionDir: session } = sessionDir();
	const fake = resumeFake("bootstrap-only", session);
	const rt = runtimeWith(fake, dir);
	try {
		writeSourceTranscript(session);
		const source = sourceJob(session);
		createGroup(rt.openDb(), "grp-wz-source-1", session, Date.now());

		await resumeWorker(rt, source, { jobId: "wz-resume-1", message: MESSAGE });

		const keys = keysOf(fake);
		assert.equal(keys.length, 1, "the resume sent more than one Enter");
		assert.deepEqual(keys[0], ["pane", "send-keys", "w1:p101", "enter"]);
		assert.equal(promptsOf(fake).length, 1, "the resume sent the message more than once");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});
