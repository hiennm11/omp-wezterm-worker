import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { expirableEvents } from "../extensions/lib/event-expiry.ts";
import { createEvent, pendingEvents, readHandling } from "../extensions/lib/events.ts";
import type { Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { recoverTask } from "../extensions/lib/recover-task.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerAckTool } from "../extensions/worker-tools/ack.ts";
import { cleanupTool, fakeWezterm, jobOf, runtimeFor } from "./group-holder-helpers.ts";
import { fakeZod, toolOf } from "./native-run-helpers.ts";

const HOUR = 60 * 60 * 1000;
const NOW = 100 * HOUR;

function seedEvent(
	rt: WorkerRuntime,
	job: Job,
	condition: "missing_report" | "result" | "permission_request" | "unknown_outcome",
	createdAt = NOW - 30 * HOUR,
): string {
	rt.jobs.set(job.id, job);
	acquireOwnership(rt.openDb(), taskKey(job.id), rt.sessionId ?? "owner", 1, "test-process", NOW - 31 * HOUR);
	const id = `event-${job.id}-${condition}`;
	createEvent(
		rt.openDb(),
		id,
		`${job.id}|evidence|${condition}`,
		job.id,
		"test",
		condition,
		null,
		true,
		createdAt,
	);
	return id;
}

function recovered(
	t: TestContext,
	condition: "missing_report" | "result" | "permission_request" | "unknown_outcome",
	ageHours: number,
	status: Job["status"] = "completed",
	owned = true,
	expiryMs = 24 * HOUR,
) {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	rt.sessionId = "owner";
	rt.config.eventExpiryMs = expiryMs;
	const job = jobOf("run", { status, finishedAt: NOW - ageHours * HOUR });
	const id = seedEvent(rt, job, condition);
	if (!owned) rt.sessionId = "other";
	recoverTask(rt, [job], () => {}, NOW);
	return { rt, id, job };
}

test("recoverTask expires a stale missing-report event and leaves no pending event", (t) => {
	const { rt, id } = recovered(t, "missing_report", 30);
	assert.equal(readHandling(rt.openDb(), id)?.disposition, "expired");
	assert.deepEqual(
		pendingEvents(rt.openDb()).map((event) => event.id),
		[],
	);
});

test("recent missing-report events remain pending", (t) => {
	const { rt, id } = recovered(t, "missing_report", 2);
	assert.equal(readHandling(rt.openDb(), id), null);
	assert.deepEqual(
		pendingEvents(rt.openDb()).map((event) => event.id),
		[id],
	);
});

test("result events remain pending after the expiry limit", (t) => {
	const { rt, id } = recovered(t, "result", 30);
	assert.equal(readHandling(rt.openDb(), id), null);
});

test("permission and unknown-outcome events remain pending after the expiry limit", (t) => {
	for (const condition of ["permission_request", "unknown_outcome"] as const) {
		const { rt, id } = recovered(t, condition, 30);
		assert.equal(readHandling(rt.openDb(), id), null);
	}
});

test("active runs keep missing-report events pending", (t) => {
	const { rt, id } = recovered(t, "missing_report", 30, "running");
	assert.equal(readHandling(rt.openDb(), id), null);
});

test("a session that does not own the run writes no expiry row", (t) => {
	const { rt, id } = recovered(t, "missing_report", 30, "completed", false);
	assert.equal(readHandling(rt.openDb(), id), null);
});

test("a zero expiry limit disables event expiry", (t) => {
	const { rt, id } = recovered(t, "missing_report", 30, "completed", true, 0);
	assert.equal(readHandling(rt.openDb(), id), null);
});

test("event expiry waits from the later of creation and run end", () => {
	const job = jobOf("run", { status: "completed", finishedAt: NOW - 30 * HOUR });
	const event = {
		id: "event",
		runId: job.id,
		kind: "test",
		condition: "missing_report" as const,
		payload: null,
		actionable: true,
		createdAt: NOW,
	};
	assert.deepEqual(expirableEvents([event], [job], NOW + 23 * HOUR, 24 * HOUR), []);
	assert.deepEqual(expirableEvents([event], [job], NOW + 24 * HOUR, 24 * HOUR), [event]);
});

test("cleanup succeeds after recoverTask expires the blocking event", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	rt.sessionId = "owner";
	const job = jobOf("wz-clean", { status: "completed", finishedAt: NOW - 30 * HOUR });
	const id = seedEvent(rt, job, "missing_report");
	recoverTask(rt, [job], () => {}, NOW);
	const result = await cleanupTool(rt).execute("cleanup", { workerId: job.id });
	assert.notEqual(result.isError, true);
	assert.equal(readHandling(rt.openDb(), id)?.disposition, "expired");
});

test("ack reports that an expired event was already handled", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm().exec);
	rt.sessionId = "owner";
	const job = jobOf("wz-ack", { status: "completed", finishedAt: NOW - 30 * HOUR });
	const id = seedEvent(rt, job, "missing_report");
	rt.jobs.set(job.id, job);
	recoverTask(rt, [job], () => {}, NOW);
	const ack = toolOf(rt, registerAckTool, "ack");
	const result = await ack.execute("ack", { workerId: job.id, eventId: id, disposition: "accepted" });
	assert.equal(result.content[0]?.text, "The event was already handled as expired.");
});
