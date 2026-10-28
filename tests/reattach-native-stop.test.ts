/**
 * The stop of a native worker whose re-attachment fails.
 *
 * A worker that no owner watches keeps running. A failed re-attachment
 * therefore stops the worker. The stop waits for the pane to close, so the
 * ledger of the run closes only after the worker really stopped.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { attachWorker } from "../extensions/lib/attach.ts";
import { executionsOfRun, openExecution } from "../extensions/lib/executions.ts";
import { createGroup, readGroup, reserveExecution } from "../extensions/lib/groups.ts";
import type { Job } from "../extensions/lib/job.ts";
import { cleanup, fakeRuntime, makeDirs, nativeJob, sleep } from "./reattach-native-helpers.ts";

/** A job whose handover file cannot be written. */
function unattachableJob(dir: string): Job {
	const blocker = join(dir, "blocker");
	writeFileSync(blocker, "x");
	return nativeJob(join(blocker, "sessions", "wz-1"));
}

test("a failed re-attachment closes the open rows of the run", async () => {
	const { dir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = unattachableJob(dir);
		rt.jobs.set(job.id, job);
		const db = rt.openDb();
		openExecution(db, "ex-1", job.id, "tool", "Bash", "call-1", null, "opened", "bridge", 1000);

		await attachWorker(rt, job, () => undefined);

		const rows = executionsOfRun(db, job.id);
		assert.equal(rows.length, 1, "the run keeps its row");
		assert.equal(rows[0].state, "unknown", "the open row becomes unknown");
		assert.equal(rows.filter((row) => row.state === "open").length, 0, "no row of the run stays open");
	} finally {
		await cleanup(rt, dir);
	}
});

test("a failed re-attachment frees the execution of the group", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt, commands } = fakeRuntime(dir, [7]);
	try {
		const job = unattachableJob(dir);
		rt.jobs.set(job.id, job);
		const db = rt.openDb();
		createGroup(db, "group-1", sessionDir, 1000);
		const reservation = reserveExecution(db, "group-1", job.id, 1000);
		assert.equal(reservation.granted, true, "the run holds the group");

		await attachWorker(rt, job, () => undefined);

		const kills = commands.filter((command) => command.join(" ").includes("kill-pane"));
		assert.equal(kills.length, 1, "the pane of the worker receives a kill command");
		const group = readGroup(db, "group-1");
		assert.equal(group?.executionHolder, null, "the group holds no run");
		assert.equal(group?.executionState, "free", "the execution of the group is free");
	} finally {
		await cleanup(rt, dir);
	}
});

test("a failed re-attachment waits for the pane to close and then retries the stop", async () => {
	const { dir } = makeDirs();
	const panes = [7];
	const { rt, tick } = fakeRuntime(dir, panes, { dropPaneOnKill: false });
	rt.stopConfirm = { attempts: 2, intervalMs: 1 };
	try {
		const job = unattachableJob(dir);
		rt.jobs.set(job.id, job);

		await attachWorker(rt, job, () => undefined);

		assert.equal(job.status, "running", "the worker waits for the stop to be confirmed");
		assert.ok(job.pendingStop, "the job holds a pending stop");
		assert.equal(rt.monitors.has(job.id), true, "a monitor retries the pending stop");

		panes.splice(panes.indexOf(7), 1);
		tick();
		await sleep(50);

		assert.equal(job.status, "failed", "the confirmed stop ends the worker as failed");
		assert.equal(job.pendingStop, null, "the pending stop is cleared");
	} finally {
		await cleanup(rt, dir);
	}
});
