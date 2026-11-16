/**
 * The replay of a delivery that did not settle.
 *
 * A host that refuses a message leaves the attempt in the state `uncertain`.
 * The message never reached the main session. A restart must send the
 * message again, and it must send it once. A later restart sends nothing,
 * because the attempt is now `sent`.
 *
 * The proof uses a real runtime and a fake host. The fake host refuses the
 * first send. The restart opens a new runtime on the same state directory.
 * The runtime reads the rows of the run from the database, so the restart
 * holds the same run as the first start.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDeliver } from "../extensions/lib/deliver.ts";
import { deliveriesOfEvent } from "../extensions/lib/delivery.ts";
import { raiseEvent, replayEvents } from "../extensions/lib/event-wake.ts";
import { findEventByKey, resultEventKey } from "../extensions/lib/events.ts";
import type { Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { recoverTask } from "../extensions/lib/recover-task.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { jobOf } from "./group-holder-helpers.ts";
import { fakeClock, START } from "./report-reminder-helpers.ts";

/** The session that owns the task of the worker. */
const SESSION = "session-uncertain";

/** The time at which the run ends. */
const ENDED = START + 1_000;

/** The time of the restart. */
const RESTART = ENDED + 1_000;

/** The id of the event of a run without a report. */
const EVENT_ID = "ev-wz-1-evidence-missing_report";

/** A runtime that keeps its rows in the given directory. */
function runtimeIn(dir: string): WorkerRuntime {
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }) as never);
	rt.config.stateDir = dir;
	rt.sessionId = SESSION;
	return rt;
}

/** The owner of the task of the worker. */
function ownTask(rt: WorkerRuntime, job: Job): void {
	rt.jobs.set(job.id, job);
	acquireOwnership(rt.openDb(), taskKey(job.id), SESSION, 500, "2026-10-23T01:00:00.000Z", START);
}

/** The states of the delivery attempts of one key. */
function statesOf(rt: WorkerRuntime, key: string): string[] {
	return deliveriesOfEvent(rt.openDb(), key).map((attempt) => attempt.state);
}

/** The runs that the database holds after the first start. */
function restoredRuns(rt: WorkerRuntime): Job[] {
	const restored = rt.readRegistry();
	return [...restored.finished, ...restored.alive];
}

test("the restart sends the result of an uncertain delivery again, once", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-uncertain-"));
	const clock = fakeClock();
	const first = runtimeIn(dir);
	try {
		const running = jobOf("wz-1", { status: "running" });
		ownTask(first, running);

		let refuse = true;
		const sent: string[] = [];
		first.sendToMainSession = (text) => {
			if (refuse) throw new Error("the host refused the message");
			sent.push(text);
			return "sendUserMessage";
		};
		const deliver = createDeliver(first);

		// The first start of the session writes the mark of the replay. The
		// run is still active, so the recovery sends nothing.
		recoverTask(first, [...first.jobs.values()], deliver, START);
		assert.equal(sent.length, 0, "the first start sent no message");

		// The run ends. The delivery of its result fails. The host refuses
		// the message, so the attempt stays uncertain.
		const finished: Job = { ...running, status: "completed", finishedAt: ENDED, result: "THE-ANSWER" };
		first.jobs.set(finished.id, finished);
		first.persist();
		assert.throws(() => deliver(finished), /the host refused the message/);
		assert.ok(
			findEventByKey(first.openDb(), resultEventKey(finished.id)),
			"the run ended with a result event",
		);
		assert.deepEqual(
			statesOf(first, `ev-${finished.id}-result`),
			["uncertain"],
			"the failed delivery left one uncertain attempt",
		);

		// The process of the first start ends. The restart opens a new
		// runtime on the same state directory.
		first.closeDb();
		const second = runtimeIn(dir);
		second.sendToMainSession = (text) => {
			sent.push(text);
			return "sendUserMessage";
		};
		const jobs = restoredRuns(second);
		assert.deepEqual(
			jobs.map((run) => run.id),
			[finished.id],
			"the restart reads the run from the database",
		);

		// The recovery of the restart sends the result again. The host
		// accepts the message now.
		refuse = false;
		clock.advance(RESTART - START);
		const replayed = recoverTask(second, jobs, createDeliver(second), RESTART);
		assert.deepEqual(
			replayed.map((run) => run.id),
			[finished.id],
			"the restart replayed the result",
		);
		assert.equal(sent.length, 1, "the restart sent the result once");
		assert.ok(sent[0]?.includes("THE-ANSWER"), "the message carries the result");
		assert.deepEqual(
			statesOf(second, `ev-${finished.id}-result`).sort(),
			["sent", "uncertain"],
			"the replay settled a new attempt",
		);

		// A later restart sends nothing. The delivery is now sent.
		clock.advance(1_000);
		const again = recoverTask(second, jobs, createDeliver(second), RESTART + 1_000);
		assert.deepEqual(again, [], "a later restart replayed the result again");
		assert.equal(sent.length, 1, "a later restart sent the result again");
		second.closeDb();
	} finally {
		clock.restore();
		first.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the restart wakes the session for an uncertain event once", () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-uncertain-"));
	const clock = fakeClock();
	const first = runtimeIn(dir);
	try {
		const job = jobOf("wz-1", { status: "completed", finishedAt: ENDED });
		ownTask(first, job);

		let refuse = true;
		const sent: string[] = [];
		first.sendToMainSession = (text) => {
			if (refuse) throw new Error("the host refused the message");
			sent.push(text);
			return "sendUserMessage";
		};

		// The wake of the event fails. The host refuses the message, so the
		// attempt stays uncertain.
		raiseEvent(
			first,
			{
				id: EVENT_ID,
				key: "wz-1|evidence|missing_report",
				runId: job.id,
				kind: "missing_report",
				condition: "missing_report",
				payload: null,
				actionable: true,
			},
			START,
		);
		assert.equal(sent.length, 0, "the failed wake sent no message");
		assert.deepEqual(statesOf(first, EVENT_ID), ["uncertain"], "the failed wake left one uncertain attempt");
		first.persist();

		// The process of the first start ends. The restart opens a new
		// runtime on the same state directory.
		first.closeDb();
		const second = runtimeIn(dir);
		second.sendToMainSession = (text) => {
			sent.push(text);
			return "sendUserMessage";
		};
		for (const run of restoredRuns(second)) second.jobs.set(run.id, run);

		// The recovery of the restart wakes the session again. The host
		// accepts the message now.
		refuse = false;
		clock.advance(RESTART - START);
		const woken = replayEvents(second, RESTART);
		assert.deepEqual(
			woken.map((event) => event.id),
			[EVENT_ID],
			"the restart woke the session for the event",
		);
		assert.equal(sent.length, 1, "the restart sent the wake once");
		assert.ok(sent[0]?.includes(EVENT_ID), "the wake names the event");
		assert.deepEqual(statesOf(second, EVENT_ID), ["sent"], "the replay settled the attempt");

		// A later restart sends nothing. The delivery is now sent.
		clock.advance(1_000);
		const again = replayEvents(second, RESTART + 1_000);
		assert.deepEqual(again, [], "a later restart woke the session again");
		assert.equal(sent.length, 1, "a later restart sent the wake again");
		second.closeDb();
	} finally {
		clock.restore();
		first.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});
