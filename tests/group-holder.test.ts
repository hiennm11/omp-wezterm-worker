/**
 * The holder of a resource group that ended.
 *
 * A run keeps its group when its pane stays open after the run ends. A user
 * can close that pane by hand. A resume and a cleanup must then free the
 * group, because the pane that could write into the shared transcript is
 * gone.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type * as GroupHolder from "../extensions/lib/group-holder.ts";
import { createGroup, readGroup, reserveExecution } from "../extensions/lib/groups.ts";
import { resumeWorker } from "../extensions/lib/spawn.ts";
import {
	cleanupTool,
	fakeWezterm,
	groupOfId,
	heldGroup,
	jobOf,
	launchedPane,
	runtimeFor,
	seedHolder,
	seedTarget,
	sessionDirOf,
	taskWith,
} from "./group-holder-helpers.ts";

/**
 * The module under test.
 *
 * A static import cannot work on the branch that does not have the module
 * yet. A missing module stops the whole file from loading, so the other
 * tests could not run and fail on their own behaviour.
 */
async function loadHolder(): Promise<typeof GroupHolder> {
	return await import("../extensions/lib/group-holder.ts");
}

test("the decision names one result for every state of the holder", async () => {
	const { decideHolder } = await loadHolder();
	const ended = jobOf("wz-1");
	const closed = jobOf("wz-2", { paneClosed: true });
	const withoutPane = jobOf("wz-3", { paneId: null });
	const active = jobOf("wz-4", { status: "running" });

	assert.equal(decideHolder(ended, "gone"), "release");
	assert.equal(decideHolder(closed, null), "release");
	assert.equal(decideHolder(withoutPane, null), "release");
	assert.equal(decideHolder(ended, "present"), "keep-pane-open");
	assert.equal(decideHolder(ended, "unknown"), "keep-pane-unknown");
	assert.equal(decideHolder(active, "gone"), "keep");
	assert.equal(decideHolder(undefined, null), "keep");
});

test("the holder of an ended run frees its group when its pane is gone", async (t) => {
	const { freeEndedHolder } = await loadHolder();
	const { exec } = fakeWezterm({ panes: [] });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	const job = jobOf("wz-1", { paneId: 7, paneClosed: false });
	const group = heldGroup(rt, db, job);

	const result = await freeEndedHolder(rt, group);

	assert.equal(result, null);
	assert.equal(readGroup(db, group.id)?.executionHolder, null);
	assert.equal(readGroup(db, group.id)?.executionState, "free");
	assert.equal(job.paneClosed, true);
});

test("the holder of an ended run keeps its group while its pane is open", async (t) => {
	const { freeEndedHolder } = await loadHolder();
	const { exec } = fakeWezterm({ panes: [{ pane_id: 7, tab_id: 1, window_id: 1 }] });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	const job = jobOf("wz-1", { paneId: 7, paneClosed: false });
	const group = heldGroup(rt, db, job);

	const result = await freeEndedHolder(rt, group);

	assert.equal(
		result,
		"The resources of this task are held by run wz-1. Its pane 7 is still open. Close pane 7, then try again.",
	);
	assert.equal(readGroup(db, group.id)?.executionHolder, "wz-1");
	assert.equal(job.paneClosed, false);
});

test("the holder of an ended run keeps its group when the pane list fails", async (t) => {
	const { freeEndedHolder } = await loadHolder();
	const { exec } = fakeWezterm({ panes: [], listCode: 1 });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	const job = jobOf("wz-1", { paneId: 7, paneClosed: false });
	const group = heldGroup(rt, db, job);

	const result = await freeEndedHolder(rt, group);

	assert.equal(result, "The pane list cannot be read, so the state of pane 7 is unknown. Try again.");
	assert.equal(readGroup(db, group.id)?.executionHolder, "wz-1");
	assert.equal(job.paneClosed, false);
});

test("an active holder keeps its group", async (t) => {
	const { freeEndedHolder } = await loadHolder();
	const { exec } = fakeWezterm({ panes: [] });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	const job = jobOf("wz-1", { status: "running", paneId: 7, paneClosed: false });
	const group = heldGroup(rt, db, job);

	const result = await freeEndedHolder(rt, group);

	assert.equal(result, null);
	assert.equal(readGroup(db, group.id)?.executionHolder, "wz-1");
});

test("a holder that this process does not know keeps its group", async (t) => {
	const { freeEndedHolder } = await loadHolder();
	const { exec } = fakeWezterm({ panes: [] });
	const { rt } = runtimeFor(t, exec);
	const db = rt.openDb();
	createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
	reserveExecution(db, "grp-1", "wz-1", 1001);

	const result = await freeEndedHolder(rt, groupOfId(db, "grp-1"));

	assert.equal(result, null);
	assert.equal(readGroup(db, "grp-1")?.executionHolder, "wz-1");
});

test("a resume takes the group of a source run whose pane was closed by hand", async (t) => {
	const { exec, calls } = fakeWezterm({ panes: [] });
	const { rt, dir } = runtimeFor(t, exec);
	const db = rt.openDb();
	const sessionDir = sessionDirOf(dir, "wz-src");
	createGroup(db, "grp-wz-src", sessionDir, 1000);
	reserveExecution(db, "grp-wz-src", "wz-src", 1001);
	const source = jobOf("wz-src", {
		sessionDir,
		sessionFile: join(sessionDir, "a.jsonl"),
		paneId: 7,
		paneClosed: false,
		status: "completed",
	});
	rt.jobs.set(source.id, source);

	const resumed = await resumeWorker(rt, source, { jobId: "wz-new" });

	assert.equal(resumed.status, "running", `the resume failed: ${resumed.error}`);
	assert.equal(readGroup(db, "grp-wz-src")?.executionHolder, "wz-new");
	assert.equal(source.paneClosed, true);
	assert.equal(launchedPane(calls), true);
});

test("a resume refuses while the pane of the holder is open", async (t) => {
	const { exec, calls } = fakeWezterm({ panes: [{ pane_id: 7, tab_id: 1, window_id: 1 }] });
	const { rt, dir } = runtimeFor(t, exec);
	const db = rt.openDb();
	const sessionDir = sessionDirOf(dir, "wz-src");
	createGroup(db, "grp-wz-src", sessionDir, 1000);
	// The holder is another run of the task. Its pane is still open.
	seedHolder(rt, "grp-wz-src", sessionDir, "wz-hold", 7);
	const source = jobOf("wz-src", {
		sessionDir,
		sessionFile: join(sessionDir, "a.jsonl"),
		paneId: null,
		status: "completed",
	});
	rt.jobs.set(source.id, source);

	const resumed = await resumeWorker(rt, source, { jobId: "wz-new" });

	assert.equal(resumed.status, "failed");
	assert.equal(
		resumed.error,
		"The resources of this task are held by run wz-hold. Its pane 7 is still open. Close pane 7, then try again.",
	);
	assert.equal(readGroup(db, "grp-wz-src")?.executionHolder, "wz-hold");
	assert.equal(launchedPane(calls), false);
});

test("the cleanup of a task whose holder ended with its pane gone goes on", async (t) => {
	const { exec } = fakeWezterm({ panes: [] });
	const { rt, sessionDir } = taskWith(t, exec);
	seedHolder(rt, "grp-wz-task", sessionDir, "wz-hold", 7);
	seedTarget(rt, sessionDir, "wz-task");

	const result = await cleanupTool(rt).execute("t1", { workerId: "wz-task" });

	assert.notEqual(result.isError, true);
	assert.match(result.content[0]?.text ?? "", /transcript directory removed/);
	assert.equal(existsSync(sessionDir), false);
});

test("the cleanup refuses and names the pane while the pane of the holder is open", async (t) => {
	const { exec } = fakeWezterm({ panes: [{ pane_id: 7, tab_id: 1, window_id: 1 }] });
	const { rt, db, sessionDir } = taskWith(t, exec);
	seedHolder(rt, "grp-wz-task", sessionDir, "wz-hold", 7);
	seedTarget(rt, sessionDir, "wz-task");

	const result = await cleanupTool(rt).execute("t1", { workerId: "wz-task" });

	assert.equal(result.isError, true);
	assert.equal(
		result.content[0]?.text,
		"The resources of this task are held by run wz-hold. Its pane 7 is still open. Close pane 7, then try again.",
	);
	assert.equal(result.details.pane, 7);
	assert.equal(result.details.executionHolder, "wz-hold");
	assert.equal(readGroup(db, "grp-wz-task")?.executionHolder, "wz-hold");
	assert.equal(existsSync(sessionDir), true);
});
