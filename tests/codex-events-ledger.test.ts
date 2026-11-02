/**
 * The events of a Codex worker and the ledger of its runs.
 *
 * A Codex worker raises an event when the owner must act. The event keeps
 * its id through every restart, so a recovery finds the event that exists
 * and creates no second one. The owner acknowledges the event with the ack
 * tool.
 *
 * The tests use the real translator of the app server, the real monitor and
 * the real tools. No real program runs.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { eventsOfRun, pendingEvents, readEvent } from "../extensions/lib/events.ts";
import { closeLedger } from "../extensions/lib/ledger-sync.ts";
import { cancelJob } from "../extensions/lib/lifecycle.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import {
	ackTool,
	approvalCallId,
	codexRun,
	eventsWithCondition,
	messageOf,
	OWN,
	openRow,
} from "./codex-events-helpers.ts";

test("a Codex worker that stops with an open row raises one event of an execution loss", async () => {
	const run = await codexRun();
	try {
		openRow(run.rt, run.job.id, "call-1");

		await cancelJob(run.rt, run.job);

		const loss = eventsOfRun(run.rt.openDb(), run.job.id).filter(
			(event) => event.condition === "execution_loss",
		);
		assert.equal(loss.length, 1, "the stop raised no single event of the execution loss");
		assert.equal(loss[0].runId, run.job.id);
		assert.equal(loss[0].actionable, true);
	} finally {
		await run.close();
	}
});

test("a second stop of a Codex worker raises no second event of an execution loss", async () => {
	const run = await codexRun();
	try {
		openRow(run.rt, run.job.id, "call-1");

		await cancelJob(run.rt, run.job);
		assert.equal(eventsWithCondition(run.rt, run.job.id, "execution_loss"), 1);

		/* The worker started another call before it stopped. The row of
		   that call is open, so the second stop of the monitor closes it.
		   The key of the event finds the event that exists, so the second
		   stop raises no second event. */
		openRow(run.rt, run.job.id, "call-2");
		await cancelJob(run.rt, run.job);

		assert.equal(eventsWithCondition(run.rt, run.job.id, "execution_loss"), 1);
	} finally {
		await run.close();
	}
});

test("a second restart of the owner of a Codex worker raises no second event", async () => {
	const run = await codexRun();
	try {
		openRow(run.rt, run.job.id, "call-1");
		await cancelJob(run.rt, run.job);
		assert.equal(eventsWithCondition(run.rt, run.job.id, "execution_loss"), 1);

		/* A restart of the host reads the run from the database. The row of
		   the lost execution is unknown, so the close of the ledger finds
		   no open row and raises no second event. */
		closeLedger(
			run.rt.openDb(),
			{ id: run.job.id, sessionDir: run.job.sessionDir, sessionFile: null, baselineTurns: 0 },
			2000,
		);

		assert.equal(eventsWithCondition(run.rt, run.job.id, "execution_loss"), 1);

		/* The worker started another call before it stopped. The row of
		   that call is open, so the close of the ledger finds it again.
		   The key of the event finds the event that exists, so the second
		   close raises no second event. */
		openRow(run.rt, run.job.id, "call-2");
		closeLedger(
			run.rt.openDb(),
			{ id: run.job.id, sessionDir: run.job.sessionDir, sessionFile: null, baselineTurns: 0 },
			3000,
		);

		assert.equal(eventsWithCondition(run.rt, run.job.id, "execution_loss"), 1);
	} finally {
		await run.close();
	}
});

test("a second poll of a Codex worker keeps the id of its event", async () => {
	const run = await codexRun();
	try {
		run.send(messageOf("approvalRequest"));
		monitorNativeJob(run.rt, run.job, () => undefined);
		run.tick();

		const first = eventsOfRun(run.rt.openDb(), run.job.id);
		assert.equal(first.length, 1, "the run holds no event of the request");
		const eventId = first[0].id;

		/* The owner acknowledges the event by its id, so the id must name
		   the run, the evidence and the condition. */
		assert.equal(
			eventId,
			`ev-${run.job.id}-approval-${approvalCallId()}-permission_request`,
			"the id of the event names another set of parts",
		);

		/* The monitor polls again. The request still waits for the
		   person, so the poll must find the event that exists. */
		run.tick();
		run.tick();

		const second = eventsOfRun(run.rt.openDb(), run.job.id);
		assert.equal(second.length, 1, "the poll created a second event of the request");
		assert.equal(second[0].id, eventId, "the poll changed the id of the event");
	} finally {
		await run.close();
	}
});

test("the event of a Codex worker waits for the owner and leaves the list after the ack", async () => {
	const run = await codexRun();
	try {
		run.rt.sessionId = OWN;
		acquireOwnership(run.rt.openDb(), taskKey(run.job.id), OWN, 500, "2026-10-29T08:00:00.000Z", Date.now());

		/* The real message of the proof asks the person for the approval. */
		run.send(messageOf("approvalRequest"));
		monitorNativeJob(run.rt, run.job, () => undefined);
		run.tick();

		const pending = pendingEvents(run.rt.openDb());
		assert.equal(pending.length, 1, "the event does not wait for the owner");
		assert.equal(pending[0].runId, run.job.id);
		const eventId = pending[0].id;

		const first = await ackTool(run.rt).execute("t1", {
			workerId: run.job.id,
			eventId,
			disposition: "accepted",
		});
		assert.notEqual(first.isError, true, first.content[0]?.text);
		assert.equal(first.details.acknowledged, true);
		assert.deepEqual(pendingEvents(run.rt.openDb()), [], "the event stays pending after the ack");
	} finally {
		await run.close();
	}
});

test("a second ack with the same disposition changes nothing and another disposition is refused", async () => {
	const run = await codexRun();
	try {
		run.rt.sessionId = OWN;
		acquireOwnership(run.rt.openDb(), taskKey(run.job.id), OWN, 500, "2026-10-29T08:00:00.000Z", Date.now());

		run.send(messageOf("approvalRequest"));
		monitorNativeJob(run.rt, run.job, () => undefined);
		run.tick();

		const eventId = pendingEvents(run.rt.openDb())[0].id;
		const ack = ackTool(run.rt);

		const first = await ack.execute("t1", { workerId: run.job.id, eventId, disposition: "accepted" });
		assert.notEqual(first.isError, true, first.content[0]?.text);

		const second = await ack.execute("t2", { workerId: run.job.id, eventId, disposition: "accepted" });
		assert.notEqual(second.isError, true, second.content[0]?.text);
		assert.equal(second.details.acknowledged, true);

		const other = await ack.execute("t3", { workerId: run.job.id, eventId, disposition: "discarded" });
		assert.equal(other.isError, true);
		assert.equal(other.content[0]?.text, "The event was already handled as accepted.");
		assert.equal(other.details.acknowledged, false);

		const rows = run.rt
			.openDb()
			.handle.prepare("SELECT COUNT(*) AS n FROM event_handling WHERE event_id = ?")
			.get(eventId) as { n: number };
		assert.equal(Number(rows.n), 1, "the handling holds more than one row");
	} finally {
		await run.close();
	}
});

test("the event of a Codex worker keeps its id after a restart of the host", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-restart-"));
	const first = await codexRun({ stateDir: dir });
	let second = null;
	try {
		first.rt.sessionId = OWN;
		acquireOwnership(
			first.rt.openDb(),
			taskKey(first.job.id),
			OWN,
			500,
			"2026-10-29T08:00:00.000Z",
			Date.now(),
		);
		first.send(messageOf("approvalRequest"));
		monitorNativeJob(first.rt, first.job, () => undefined);
		first.tick();

		const before = eventsOfRun(first.rt.openDb(), first.job.id);
		assert.equal(before.length, 1, "the run holds no event of the request");
		const eventId = before[0].id;

		/* The key of the event joins the run, the evidence and the
		   condition. A recovery finds the event with that key. */
		const key = first.rt
			.openDb()
			.handle.prepare("SELECT key FROM meta WHERE key LIKE 'event_key:%'")
			.get() as { key: string };
		assert.equal(
			key.key,
			`event_key:${first.job.id}|approval-${approvalCallId()}|permission_request`,
			"the key of the event joins another set of parts",
		);

		/* The host restarts. The new session opens the same database and
		   reads the events of the run. */
		second = await codexRun({ stateDir: dir });
		const after = eventsOfRun(second.rt.openDb(), first.job.id);
		assert.equal(after.length, 1, "the restart changed the number of events");
		assert.equal(after[0].id, eventId, "the restart changed the id of the event");
		assert.ok(readEvent(second.rt.openDb(), eventId), "the event of the run is gone");

		/* The new owner sees the same evidence and polls the monitor
		   again. The key of the event finds the event that exists, so the
		   poll creates no second event. */
		second.send(messageOf("approvalRequest"));
		monitorNativeJob(second.rt, second.job, () => undefined);
		second.tick();

		const final = eventsOfRun(second.rt.openDb(), first.job.id);
		assert.equal(final.length, 1, "the restart raised a second event of the same evidence");
		assert.equal(final[0].id, eventId, "the restart changed the id of the event");
	} finally {
		await first.close();
		if (second) await second.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
