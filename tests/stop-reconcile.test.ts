/**
 * The reconciliation of the stop intents that a restart left pending.
 *
 * A stop intent is stored before the pane closes. An owner that died after
 * the close leaves the intent pending. The new owner reads the pane list and
 * settles the intent. An unreadable pane list settles nothing, because the
 * code never guesses (docs/adr/0002).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Job } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { readStopIntent, recordStopIntent } from "../extensions/lib/stop-intent.ts";
import { intentVerdict, reconcileStopIntents, stopIntentRefusal } from "../extensions/lib/stop-reconcile.ts";
import { fakeWezterm, jobOf, runtimeFor } from "./group-holder-helpers.ts";

/** A run with a pending stop intent. The task belongs to the given session. */
function stopping(rt: WorkerRuntime, id: string, paneId: number | null, session = "s1"): Job {
	const job = jobOf(id, { paneId, status: "running" });
	rt.jobs.set(id, job);
	acquireOwnership(rt.openDb(), taskKey(id), session, 1, "t", 1000);
	recordStopIntent(rt.openDb(), `stop-${id}`, id, "cancelled", "Cancelled by the main agent", 1001);
	return job;
}

test("the verdict follows the pane state and never guesses", () => {
	assert.equal(intentVerdict("gone"), "confirm");
	assert.equal(intentVerdict("present"), "fail");
	assert.equal(intentVerdict("unknown"), "keep");
});

test("a pending intent is confirmed when its pane is gone", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm({ panes: [{ pane_id: 99, tab_id: 1, window_id: 1 }] }).exec);
	rt.sessionId = "s1";
	stopping(rt, "wz-1", 121);

	const outcome = await reconcileStopIntents(rt, [...rt.jobs.values()], 2000);

	assert.deepEqual(outcome.confirmed, ["stop-wz-1"]);
	assert.equal(readStopIntent(rt.openDb(), "stop-wz-1")?.state, "confirmed");
});

test("a pending intent is confirmed when the run has no pane", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm({ panes: [] }).exec);
	rt.sessionId = "s1";
	stopping(rt, "wz-1", null);

	const outcome = await reconcileStopIntents(rt, [...rt.jobs.values()], 2000);

	assert.deepEqual(outcome.confirmed, ["stop-wz-1"]);
});

test("a pending intent fails when its pane still exists", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm({ panes: [{ pane_id: 121, tab_id: 1, window_id: 1 }] }).exec);
	rt.sessionId = "s1";
	stopping(rt, "wz-1", 121);

	const outcome = await reconcileStopIntents(rt, [...rt.jobs.values()], 2000);

	assert.deepEqual(outcome.failed, ["stop-wz-1"]);
	assert.equal(readStopIntent(rt.openDb(), "stop-wz-1")?.state, "failed");
});

test("a pending intent stays pending when the pane list cannot be read", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm({ panes: [], listCode: 1 }).exec);
	rt.sessionId = "s1";
	stopping(rt, "wz-1", 121);

	const outcome = await reconcileStopIntents(rt, [...rt.jobs.values()], 2000);

	assert.deepEqual(outcome.kept, ["stop-wz-1"]);
	assert.equal(readStopIntent(rt.openDb(), "stop-wz-1")?.state, "pending");
});

test("the reconciliation leaves the intent of another session alone", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm({ panes: [] }).exec);
	rt.sessionId = "s1";
	stopping(rt, "wz-foreign", 121, "s2");

	const outcome = await reconcileStopIntents(rt, [...rt.jobs.values()], 2000);

	assert.deepEqual([...outcome.confirmed, ...outcome.failed, ...outcome.kept], []);
	assert.equal(readStopIntent(rt.openDb(), "stop-wz-foreign")?.state, "pending");
});

test("a pending intent refuses the action and a settled intent does not", async (t) => {
	const { rt } = runtimeFor(t, fakeWezterm({ panes: [] }).exec);
	rt.sessionId = "s1";
	stopping(rt, "wz-1", 121);
	const db = rt.openDb();

	const refusal = stopIntentRefusal(db, "wz-1");
	assert.match(refusal ?? "", /wz-1/);
	assert.match(refusal ?? "", /wezterm_worker_cancel/);
	assert.equal(stopIntentRefusal(db, "wz-other"), null);

	await reconcileStopIntents(rt, [...rt.jobs.values()], 2000);

	assert.equal(stopIntentRefusal(db, "wz-1"), null);
});
