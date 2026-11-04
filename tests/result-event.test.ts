import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliver, formatDelivery } from "../extensions/lib/deliver.ts";
import { deliveriesOfEvent } from "../extensions/lib/delivery.ts";
import { createEvent, eventKey, eventsOfRun } from "../extensions/lib/events.ts";
import { finalizeJob } from "../extensions/lib/lifecycle.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { replayUndelivered } from "../extensions/lib/recover-task.ts";
import { registerAckTool } from "../extensions/worker-tools/ack.ts";
import { cleanupTool, fakeWezterm, jobOf, runtimeFor, sessionDirOf } from "./group-holder-helpers.ts";
import { fakeZod } from "./native-run-helpers.ts";

test("finalizing a completed run creates one actionable result event", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	const job = jobOf("result-completed", { status: "running", paneId: null });
	rt.jobs.set(job.id, job);
	await finalizeJob(rt, job, "completed", null, "done");
	await finalizeJob(rt, job, "completed", null, "done");
	assert.deepEqual(
		eventsOfRun(rt.openDb(), job.id).map(({ id, condition, actionable }) => ({ id, condition, actionable })),
		[{ id: `ev-${job.id}-result`, condition: "result", actionable: true }],
	);
});

test("finalizing a failed run creates an actionable result event", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	const job = jobOf("result-failed", { status: "running", paneId: null });
	rt.jobs.set(job.id, job);
	await finalizeJob(rt, job, "failed", "failed", null);
	assert.deepEqual(
		eventsOfRun(rt.openDb(), job.id).map((event) => [event.condition, event.actionable]),
		[["result", true]],
	);
});

test("cancelling a run creates no result event", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	const job = jobOf("result-cancelled", { status: "running", paneId: null });
	rt.jobs.set(job.id, job);
	await finalizeJob(rt, job, "cancelled", "cancelled", null);
	assert.deepEqual(eventsOfRun(rt.openDb(), job.id), []);
});

test("a result event that cannot be written rolls back the final status of the run", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	const job = jobOf("result-rollback", { status: "running", paneId: null });
	rt.jobs.set(job.id, job);
	rt.persist();
	/* A row with the id of the result event and another key makes the insert of
	   the event fail. The write of the run runs first in the same transaction. */
	createEvent(
		rt.openDb(),
		`ev-${job.id}-result`,
		"taken-by-another-key",
		job.id,
		"result",
		"result",
		null,
		true,
		1,
	);
	await assert.rejects(finalizeJob(rt, job, "completed", null, "done"));
	const row = rt.openDb().handle.prepare("SELECT status FROM runs WHERE id = ?").get(job.id) as
		| { status: string }
		| undefined;
	assert.equal(row?.status, "running", "the final status of the run was written without its result event");
});

test("a run that finished through finalizeJob blocks cleanup until its result event is acknowledged", async (t) => {
	const { rt, dir } = runtimeFor(t, fakeWezterm().exec);
	const job = jobOf("result-finalize-cleanup", {
		status: "running",
		paneId: null,
		sessionDir: sessionDirOf(dir, "result-finalize-cleanup"),
	});
	rt.jobs.set(job.id, job);
	acquireOwnership(rt.openDb(), taskKey(job.id), "session-1", 1, "t", 1000);
	rt.sessionId = "session-1";
	await finalizeJob(rt, job, "completed", null, "done");
	const refused = await cleanupTool(rt).execute("call-1", { workerId: job.id });
	assert.equal(refused.isError, true, "cleanup removed a worker whose result nobody acknowledged");
	assert.ok(refused.content[0]?.text.includes(`ev-${job.id}-result`));
});

test("the delivery of a run with an unconfirmed stop creates no result event", (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	const job = jobOf("result-pending-stop", {
		status: "running",
		paneId: null,
		pendingStop: { status: "cancelled", error: "stop", failure: "pane still open" },
	});
	rt.jobs.set(job.id, job);
	acquireOwnership(rt.openDb(), taskKey(job.id), "session-1", 1, "t", 1000);
	rt.sessionId = "session-1";
	const messages: string[] = [];
	rt.sendToMainSession = (text) => {
		messages.push(text);
		return "sendUserMessage";
	};
	createDeliver(rt)(job);
	assert.deepEqual(eventsOfRun(rt.openDb(), job.id), []);
	assert.equal(messages.length, 1);
	assert.doesNotMatch(messages[0] ?? "", /Event id:/);
});

test("a result delivery uses the event id and format", (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	const job = jobOf("result-delivery", { status: "completed", paneId: null, finishedAt: 1 });
	rt.jobs.set(job.id, job);
	acquireOwnership(rt.openDb(), taskKey(job.id), "session-1", 1, "t", 1000);
	rt.sessionId = "session-1";
	const messages: string[] = [];
	rt.sendToMainSession = (text) => {
		messages.push(text);
		return "sendUserMessage";
	};
	createDeliver(rt)(job);
	const eventId = `ev-${job.id}-result`;
	assert.equal(deliveriesOfEvent(rt.openDb(), eventId)[0]?.eventId, eventId);
	assert.ok(
		messages[0]?.includes(
			`Event id: ${eventId}. Acknowledge it with wezterm_worker_ack after you read the result.`,
		),
	);
	assert.doesNotMatch(
		formatDelivery(
			{ ...job, pendingStop: { status: "cancelled", error: "stop", failure: null } },
			{
				worker: { state: "unknown", totals: null, cost: null, note: "" },
				request: { state: "unknown", totals: null, cost: null, note: "" },
			},
		),
		/Event id:/,
	);
});

test("replay delivers an undelivered run under its result event id", (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	const job = jobOf("result-replay", { status: "completed", finishedAt: 2 });
	rt.jobs.set(job.id, job);
	acquireOwnership(rt.openDb(), taskKey(job.id), "session-1", 1, "t", 1000);
	rt.sessionId = "session-1";
	rt.sendToMainSession = () => "sendUserMessage";
	replayUndelivered(rt, [job], createDeliver(rt), null);
	assert.equal(deliveriesOfEvent(rt.openDb(), `ev-${job.id}-result`)[0]?.eventId, `ev-${job.id}-result`);
});

test("a result event stays silent when the run ends", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	const job = jobOf("result-silent", { status: "running", paneId: null });
	rt.jobs.set(job.id, job);
	const messages: string[] = [];
	rt.sendToMainSession = (text) => {
		messages.push(text);
		return "sendUserMessage";
	};
	await finalizeJob(rt, job, "completed", null, "done");
	assert.deepEqual(messages, []);
});

test("cleanup refuses a result event until wezterm_worker_ack handles it", async (t) => {
	const { rt, dir } = runtimeFor(t, fakeWezterm().exec);
	const job = jobOf("result-cleanup", {
		status: "completed",
		paneId: null,
		sessionDir: sessionDirOf(dir, "result-cleanup"),
	});
	rt.jobs.set(job.id, job);
	acquireOwnership(rt.openDb(), taskKey(job.id), "session-1", 1, "t", 1000);
	rt.sessionId = "session-1";
	const eventId = `ev-${job.id}-result`;
	createEvent(
		rt.openDb(),
		eventId,
		eventKey(job.id, "result", "result"),
		job.id,
		"result",
		"result",
		null,
		true,
		1,
	);
	const cleanup = cleanupTool(rt);
	const refused = await cleanup.execute("call-1", { workerId: job.id });
	assert.equal(refused.isError, true);
	assert.ok(refused.content[0]?.text.includes(eventId));
	const tools = new Map<
		string,
		{ execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }
	>();
	registerAckTool({
		pi: { zod: fakeZod(), registerTool: (tool: never) => tools.set("ack", tool as never) } as never,
		rt,
		deliver: () => undefined,
	});
	const ack = tools.get("ack");
	assert.ok(ack);
	await ack.execute("ack", { workerId: job.id, eventId, disposition: "accepted" });
	const allowed = await cleanup.execute("call-2", { workerId: job.id });
	assert.notEqual(allowed.isError, true);
});
