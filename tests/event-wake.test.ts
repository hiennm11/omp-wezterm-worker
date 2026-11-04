/**
 * The wake of the main session for an actionable event.
 *
 * A monitor writes an event into the database. The main session must learn
 * of the event without calling the status tool. The wake happens once, and a
 * later poll never wakes the session again.
 *
 * A restart can lose the wake. The startup recovery wakes the session again
 * for every event that no owner handled and that never reached the session.
 *
 * The wake of an event uses the id of the event as the key of its delivery.
 * A run id would mark the result of the run as sent.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDeliver } from "../extensions/lib/deliver.ts";
import { deliveriesOfEvent } from "../extensions/lib/delivery.ts";
import { createEvent, pendingEvents } from "../extensions/lib/events.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorJob } from "../extensions/lib/monitor.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { runsToReplay } from "../extensions/lib/recover-task.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { writeTranscript } from "./execution-helpers.ts";
import { createHost, RUNTIME, sessionContext } from "./harness.ts";

/** The session that owns the task. */
const OWN = "session-new";

/** A user message that starts a cycle. */
const USER = {
	type: "message",
	id: "e0",
	message: { role: "user", content: [{ type: "text", text: "do it" }] },
};

/** An assistant message that holds no tool call. */
const TEXT = {
	type: "message",
	id: "m1",
	message: { role: "assistant", content: [{ type: "text", text: "The work is done." }] },
};

/**
 * A clock that the test moves.
 *
 * The monitor reads the clock on every poll. The test moves it, so the
 * settling time of a cycle passes without a wait.
 */
function fakeClock(start: number): { advance: (ms: number) => void; restore: () => void } {
	const real = Date.now;
	let current = start;
	Date.now = () => current;
	return {
		advance(ms: number) {
			current += ms;
		},
		restore() {
			Date.now = real;
		},
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
		...freshRunState(1_000_000),
		status: "running",
		paneId: 7,
	};
}

/** The owner of the task of a worker. */
function seedOwner(rt: WorkerRuntime, jobId: string, sessionId: string): void {
	acquireOwnership(rt.openDb(), taskKey(jobId), sessionId, 500, "2026-10-23T01:00:00.000Z", 1000);
}

test("the monitor wakes the main session once for a cycle without a report", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-wake-"));
	const clock = fakeClock(1_000_000);
	const { rt, tick } = fakeRuntime(stateDir);
	try {
		const sessionDir = join(stateDir, "sessions", "wz-1");
		const file = writeTranscript(sessionDir, "a.jsonl", [USER, TEXT]);
		rt.sessionId = OWN;
		const sent: string[] = [];
		rt.sendToMainSession = (text: string) => {
			sent.push(text);
			return "sendUserMessage";
		};
		const job = runningJob(sessionDir);
		job.sessionFile = file;
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);

		monitorJob(rt, job, () => undefined);
		tick();
		assert.equal(sent.length, 0, "a cycle that just closed wakes nobody");

		clock.advance(31_000);
		tick();
		assert.equal(sent.length, 1, "the settled cycle wakes the main session once");

		const event = pendingEvents(rt.openDb())[0];
		assert.ok(event, "the cycle left an event");
		assert.ok(sent[0]?.includes(event.id), "the wake names the event");
		assert.ok(sent[0]?.includes("wezterm_worker_peek"), "the wake names the tools of the owner");
		assert.ok(sent[0]?.includes("wezterm_worker_steer"), "the wake names the tools of the owner");
		assert.ok(sent[0]?.includes("wezterm_worker_ack"), "the wake names the tools of the owner");

		clock.advance(10_000);
		tick();
		tick();
		assert.equal(sent.length, 1, "a later poll wakes nobody again");
	} finally {
		clock.restore();
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("the wake of an event does not mark the result of its run as sent", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-wake-"));
	const clock = fakeClock(1_000_000);
	const { rt, tick } = fakeRuntime(stateDir);
	try {
		const sessionDir = join(stateDir, "sessions", "wz-1");
		const file = writeTranscript(sessionDir, "a.jsonl", [USER, TEXT]);
		rt.sessionId = OWN;
		const sent: string[] = [];
		rt.sendToMainSession = (text: string) => {
			sent.push(text);
			return "sendUserMessage";
		};
		const job = runningJob(sessionDir);
		job.sessionFile = file;
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);

		monitorJob(rt, job, () => undefined);
		tick();
		clock.advance(31_000);
		tick();
		assert.equal(sent.length, 1, "the settled cycle wakes the main session once");

		const event = pendingEvents(rt.openDb())[0];
		assert.ok(event, "the cycle left an event");
		const eventAttempts = deliveriesOfEvent(rt.openDb(), event.id);
		assert.equal(eventAttempts.length, 1, "the wake records one attempt under the event id");
		assert.equal(eventAttempts[0]?.state, "sent");
		assert.equal(
			deliveriesOfEvent(rt.openDb(), job.id).length,
			0,
			"the wake writes no delivery row for the run",
		);

		// The run ends and delivers its result. The result was never sent.
		const finished: Job = { ...job, status: "completed", finishedAt: 1_032_000, result: "THE-ANSWER" };
		const replay = runsToReplay([finished], new Set<string>(), null);
		assert.deepEqual(
			replay.map((entry) => entry.id),
			[job.id],
			"the result of the run is still replayed",
		);
	} finally {
		clock.restore();
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("the startup recovery wakes the session for an event that never reached it", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-wake-"));
	const cwd = mkdtempSync(join(tmpdir(), "wz-wake-cwd-"));
	const host = createHost({ stateDir, cwd, sessionId: OWN });
	try {
		const db = RUNTIME.openDb();
		acquireOwnership(db, taskKey("wz-1"), OWN, 500, "2026-10-23T01:00:00.000Z", 1000);
		createEvent(
			db,
			"ev-wz-1-evidence-missing_report",
			"wz-1|evidence|missing_report",
			"wz-1",
			"missing_report",
			"missing_report",
			null,
			true,
			1_000_000,
		);

		await host.fire("session_start", sessionContext(cwd, OWN));

		assert.equal(host.delivered.length, 1, "the recovery wakes the main session once");
		assert.ok(host.delivered[0]?.includes("ev-wz-1-evidence-missing_report"), "the wake names the event");

		// The event stays pending. The owner still has to handle it.
		const pending = pendingEvents(RUNTIME.openDb());
		assert.equal(pending.length, 1, "the event stays pending after the wake");
		assert.equal(pending[0]?.id, "ev-wz-1-evidence-missing_report");
	} finally {
		await host.cleanup();
		rmSync(stateDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("the delivery of a result still works after the wake of an event", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "wz-wake-"));
	const clock = fakeClock(1_000_000);
	const { rt, tick } = fakeRuntime(stateDir);
	try {
		const sessionDir = join(stateDir, "sessions", "wz-1");
		const file = writeTranscript(sessionDir, "a.jsonl", [USER, TEXT]);
		rt.sessionId = OWN;
		const sent: string[] = [];
		rt.sendToMainSession = (text: string) => {
			sent.push(text);
			return "sendUserMessage";
		};
		const job = runningJob(sessionDir);
		job.sessionFile = file;
		rt.jobs.set(job.id, job);
		seedOwner(rt, job.id, OWN);

		monitorJob(rt, job, () => undefined);
		tick();
		clock.advance(31_000);
		tick();
		assert.equal(sent.length, 1, "the settled cycle wakes the main session once");

		const event = pendingEvents(rt.openDb())[0];
		assert.ok(event, "the cycle left an event");
		assert.equal(
			deliveriesOfEvent(rt.openDb(), job.id).length,
			0,
			"the wake writes no delivery row for the run",
		);

		// The worker ends. The delivery of the result goes out after the wake.
		const finished: Job = { ...job, status: "completed", finishedAt: 1_032_000, result: "THE-ANSWER" };
		createDeliver({ sendUserMessage: (text: string) => sent.push(text) } as never, rt)(finished);

		assert.equal(sent.length, 2, "the result of the run reaches the main session too");
		const attempts = deliveriesOfEvent(rt.openDb(), job.id);
		assert.equal(attempts.length, 1, "the result has one delivery row");
		assert.equal(attempts[0]?.state, "sent");
	} finally {
		clock.restore();
		rt.closeDb();
		rmSync(stateDir, { recursive: true, force: true });
	}
});
