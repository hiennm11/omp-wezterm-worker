/**
 * The Claude Code session on both pane runtimes.
 *
 * The pane calls of the Claude session go through the runtime of the job. A
 * follow-up sends the text, sends the Enter and reads the tail of the pane.
 * The tests use the fake of each runtime, so no pane and no process are
 * needed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { typeFollowUp } from "../extensions/lib/claude-session.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { sendEnter, unknownRuntimeRefusal } from "../extensions/lib/pane.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { type HerdrFake, herdrFake } from "./herdr-fake.ts";
import { type WeztermFake, weztermFake } from "./wezterm-fake.ts";

/** The job of a Claude worker that runs in a pane. */
function claudeWorker(runtime: "herdr" | "wezterm", paneId: string): Job {
	return {
		id: "wz-claude-1",
		label: "claude",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir: "/state/sessions/wz-claude-1",
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		backend: "claude",
		nativeSessionId: null,
		...freshRunState(0),
		status: "running",
		paneId,
		runtime,
	};
}

/** A runtime whose WezTerm answers with the given fake. */
function weztermRuntime(fake: WeztermFake): WorkerRuntime {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.wezterm = async (args) => fake.answer(args);
	rt.paneRuntime = "wezterm";
	return rt;
}

/** A runtime whose Herdr answers with the given fake. */
function herdrRuntime(fake: HerdrFake): WorkerRuntime {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.herdr = async (args) => fake.answer(args);
	rt.paneRuntime = "herdr";
	return rt;
}

test("a Claude follow-up sends the text, the Enter and the tail on WezTerm", async () => {
	const fake = weztermFake();
	const rt = weztermRuntime(fake);
	try {
		const job = claudeWorker("wezterm", "7");
		const failure = await typeFollowUp(rt, job, "look at the parser");
		assert.equal(failure, null, failure ?? "");
		const sends = fake.calls.filter((args) => args[0] === "send-text");
		assert.equal(sends.length, 2, "the follow-up did not send the text and the Enter");
		assert.deepEqual(sends[0], ["send-text", "--no-paste", "--pane-id", "7", "look at the parser\r"]);
		assert.deepEqual(sends[1], ["send-text", "--no-paste", "--pane-id", "7", "\r"]);
		const reads = fake.calls.filter((args) => args[0] === "get-text");
		assert.equal(reads.length, 1, "the follow-up did not read the tail");
		assert.deepEqual(reads[0], ["get-text", "--pane-id", "7"]);
	} finally {
		rt.closeDb();
	}
});

test("a Claude follow-up sends the text, the Enter and the tail on Herdr", async () => {
	const fake = herdrFake();
	const rt = herdrRuntime(fake);
	try {
		const job = claudeWorker("herdr", "w1:p7");
		const failure = await typeFollowUp(rt, job, "look at the parser");
		assert.equal(failure, null, failure ?? "");
		const prompts = fake.calls.filter((args) => args[0] === "agent" && args[1] === "prompt");
		assert.equal(prompts.length, 1, "the follow-up did not send the text");
		assert.deepEqual(prompts[0], ["agent", "prompt", "w1:p7", "look at the parser"]);
		const keys = fake.calls.filter((args) => args[0] === "pane" && args[1] === "send-keys");
		assert.equal(keys.length, 1, "the follow-up did not send the Enter");
		assert.deepEqual(keys[0], ["pane", "send-keys", "w1:p7", "enter"]);
		const reads = fake.calls.filter((args) => args[0] === "pane" && args[1] === "read");
		assert.equal(reads.length, 1, "the follow-up did not read the tail");
	} finally {
		rt.closeDb();
	}
});

test("a job without a runtime still gets the unknown-runtime refusal", async () => {
	const fake = herdrFake();
	const rt = herdrRuntime(fake);
	try {
		const job = { ...claudeWorker("herdr", "w1:p7"), runtime: undefined };
		const refusal = unknownRuntimeRefusal(job);
		assert.ok(refusal, "the unknown runtime was not reported");
		assert.match(refusal, /unknown/);
		const failure = await sendEnter(rt, job);
		assert.ok(failure, "the Enter went to a job without a runtime");
		assert.match(failure, /unknown/);
		assert.deepEqual(fake.calls, [], "a pane runtime received a call for a job without a runtime");
	} finally {
		rt.closeDb();
	}
});
