/**
 * The steering of a running OMP worker.
 *
 * The tests protect one rule: one steer call sends one instruction, and the
 * transcript confirms it. A send that the transcript does not confirm stays
 * unconfirmed, and the extension never sends the instruction again.
 *
 * The fake WezTerm records the transcript at the moment of the send, so the
 * tests need no timer and no wait.
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn, RunResult } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { steerWorker } from "../extensions/lib/steer.ts";

const INSTRUCTION = "Stop surveying and focus on the parser only";

/** A running worker whose transcript lives in the given directory. */
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
		worktreeOrigin: null,
		worktreeBranch: null,
		worktreePath: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		status: "running",
		paneId: 7,
	};
}

/** A user message entry of a transcript. */
function userMessage(text: string): string {
	return JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
}

/** Write a transcript that holds the given user messages. */
function writeTranscript(sessionDir: string, messages: string[]): void {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "session.jsonl"), messages.map(userMessage).join("\n"));
}

/** Append a user message to the transcript of a worker. */
function appendUserMessage(sessionDir: string, text: string): void {
	appendFileSync(join(sessionDir, "session.jsonl"), `\n${userMessage(text)}\n`);
}

interface Fake {
	rt: WorkerRuntime;
	/** The texts that the fake WezTerm received. */
	sends: string[];
	cleanup: () => void;
}

/**
 * A runtime whose WezTerm accepts every send.
 *
 * `onSend` runs at the moment of the send. It models the worker that takes
 * the instruction and records it in the transcript.
 */
function fake(onSend?: (text: string) => void): Fake {
	const sends: string[] = [];
	const exec: RunFn = async (_bin, args): Promise<RunResult> => {
		if (args.includes("send-text")) {
			const text = args[args.length - 1] ?? "";
			sends.push(text);
			onSend?.(text);
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	return { rt, sends, cleanup: () => rt.closeDb() };
}

/** A fresh session directory for one test. */
function sessionDir(): string {
	return mkdtempSync(join(tmpdir(), "wt-steer-"));
}

test("a steer call sends the instruction once", async () => {
	const dir = sessionDir();
	const f = fake();
	try {
		const outcome = await steerWorker(f.rt, worker(dir), 7, INSTRUCTION, { confirmDelayMs: 1 });
		assert.equal(f.sends.length, 1, "the extension sent the instruction more than once");
		assert.ok(f.sends[0]?.startsWith(INSTRUCTION), "the pane did not receive the instruction");
		assert.equal(outcome.attempts, 1);
	} finally {
		f.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the transcript confirms the delivery when it records the instruction", async () => {
	const dir = sessionDir();
	const f = fake(() => appendUserMessage(dir, INSTRUCTION));
	try {
		const outcome = await steerWorker(f.rt, worker(dir), 7, INSTRUCTION, { confirmDelayMs: 1 });
		assert.equal(outcome.ok, true, `the delivery was not confirmed: ${outcome.error}`);
		assert.equal(outcome.error, null);
		assert.equal(f.sends.length, 1, "the extension sent the instruction more than once");
	} finally {
		f.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a message with other text does not confirm the delivery", async () => {
	const dir = sessionDir();
	const f = fake(() => appendUserMessage(dir, "an unrelated message"));
	try {
		const outcome = await steerWorker(f.rt, worker(dir), 7, INSTRUCTION, { confirmDelayMs: 1 });
		assert.equal(outcome.ok, false, "an unrelated message confirmed the delivery");
		assert.match(outcome.error ?? "", /unconfirmed/);
		assert.equal(f.sends.length, 1, "the extension resent the instruction");
	} finally {
		f.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an instruction from before the send does not confirm the delivery", async () => {
	const dir = sessionDir();
	writeTranscript(dir, [INSTRUCTION]);
	const f = fake();
	try {
		const outcome = await steerWorker(f.rt, worker(dir), 7, INSTRUCTION, { confirmDelayMs: 1 });
		assert.equal(outcome.ok, false, "an old message with the same text confirmed the delivery");
		assert.match(outcome.error ?? "", /unconfirmed/);
		assert.equal(f.sends.length, 1, "the extension resent the instruction");
	} finally {
		f.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the instruction is confirmed next to an unrelated message", async () => {
	const dir = sessionDir();
	writeTranscript(dir, ["an earlier message"]);
	const f = fake(() => appendUserMessage(dir, INSTRUCTION));
	try {
		const outcome = await steerWorker(f.rt, worker(dir), 7, INSTRUCTION, { confirmDelayMs: 1 });
		assert.equal(outcome.ok, true, `the delivery was not confirmed: ${outcome.error}`);
	} finally {
		f.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a delivery that no message confirms stays unconfirmed and is not sent again", async () => {
	const dir = sessionDir();
	const f = fake();
	try {
		const outcome = await steerWorker(f.rt, worker(dir), 7, INSTRUCTION, { confirmDelayMs: 1 });
		assert.equal(outcome.ok, false, "the delivery was confirmed without a message");
		assert.match(outcome.error ?? "", /unconfirmed/);
		assert.equal(f.sends.length, 1, "the extension resent the instruction");
		assert.equal(outcome.attempts, 1);
	} finally {
		f.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a refused send is not a delivery", async () => {
	const dir = sessionDir();
	const exec: RunFn = async () => ({ code: 1, stdout: "", stderr: "pane not found" });
	const rt = createRuntime(exec);
	try {
		const outcome = await steerWorker(rt, worker(dir), 7, INSTRUCTION, { confirmDelayMs: 1 });
		assert.equal(outcome.ok, false);
		assert.match(outcome.error ?? "", /refused/);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});
