/**
 * The actions of a monitor.
 *
 * The end and the stop of a monitor write the lifecycle of a worker. Both run
 * as counted actions, so the release of the task waits for them. Every action
 * reads the ownership row again, so a session that lost the task writes
 * nothing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { monitorJob } from "../extensions/lib/monitor.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, beginRelease } from "../extensions/lib/ownership.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { jobOf, runtimeFor } from "./group-holder-helpers.ts";

/** A runtime whose polls the test runs by hand. */
function manualRuntime(
	t: Parameters<typeof runtimeFor>[0],
	exec: RunFn,
): { rt: WorkerRuntime; ticks: (() => void)[] } {
	const { rt } = runtimeFor(t, exec);
	const ticks: (() => void)[] = [];
	rt.timers = {
		setInterval: (fn) => {
			ticks.push(fn);
			return { fake: true } as unknown as NodeJS.Timeout;
		},
	};
	rt.sessionId = "s1";
	return { rt, ticks };
}

/** A running worker whose total deadline has passed. */
function overdue(id: string): Job {
	return jobOf(id, {
		...freshRunState(Date.now() - 60_000),
		status: "running",
		paneId: 7,
		timeoutMs: 1000,
	});
}

/**
 * A fake WezTerm whose pane list waits for the test.
 *
 * The close of a pane must not finish before the test reads the actions of
 * the runtime.
 */
function waitingWezterm(): { exec: RunFn; openList: () => void; listed: Promise<void> } {
	const gate = Promise.withResolvers<void>();
	const listed = Promise.withResolvers<void>();
	const exec: RunFn = async (_bin, args) => {
		if (args.includes("list")) {
			await gate.promise;
			listed.resolve();
			return { code: 0, stdout: '[{"pane_id":7}]', stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	return { exec, openList: () => gate.resolve(), listed: listed.promise };
}

/**
 * A fake WezTerm whose pane list never answers.
 *
 * A stop of a worker waits for the pane list. The stop of a worker that lost
 * the authority must never start, so the list must stay unanswered.
 */
function silentWezterm(): { exec: RunFn } {
	const never = Promise.withResolvers<void>();
	const exec: RunFn = async (_bin, args) => {
		if (args.includes("list")) await never.promise;
		return { code: 0, stdout: "", stderr: "" };
	};
	return { exec };
}

/** The promises of the actions that the runtime ran. */
function trackActions(rt: WorkerRuntime): Promise<unknown>[] {
	const actions: Promise<unknown>[] = [];
	const runAction = rt.runAction;
	rt.runAction = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		const action = runAction(name, fn);
		actions.push(action);
		return action;
	};
	return actions;
}

test("the release of the owner waits for the action of the monitor", async (t) => {
	const wezterm = waitingWezterm();
	const { rt, ticks } = manualRuntime(t, wezterm.exec);
	rt.stopConfirm = { attempts: 2, intervalMs: 1 };
	const job = overdue("wz-1");
	rt.jobs.set(job.id, job);
	const db = rt.openDb();
	acquireOwnership(db, taskKey(job.id), "s1", 1, "t", 1000);
	const actions = trackActions(rt);
	monitorJob(rt, job, () => {});

	// The tick starts the stop. The close of the pane waits.
	for (const tick of ticks) tick();

	const unsettled = [...rt.pendingActions];
	assert.equal(unsettled.length, 1, "the action of the monitor must be pending");
	assert.ok(
		unsettled[0]?.startsWith("monitor:"),
		`the pending action must be a monitor action: ${unsettled[0]}`,
	);

	// The release starts. It reads the actions that did not settle.
	const begin = beginRelease(db, taskKey(job.id), "s1", 1, 1100);
	assert.equal(begin.ok, true, "the owner must start the release");
	const afterRelease = [...rt.pendingActions];
	assert.equal(afterRelease.length, 1, "the release must see the action of the monitor");
	assert.ok(
		afterRelease[0]?.startsWith("monitor:"),
		`the release must see a monitor action: ${afterRelease[0]}`,
	);

	// The pane list answers now, so the action settles.
	wezterm.openList();
	await wezterm.listed;
	await Promise.all(actions);
	assert.equal(rt.pendingActions.size, 0, "the action must settle");
});

test("an action that starts after the owner changed writes nothing", async (t) => {
	const { rt, ticks } = manualRuntime(t, silentWezterm().exec);
	const job = overdue("wz-1");
	rt.jobs.set(job.id, job);
	const db = rt.openDb();
	acquireOwnership(db, taskKey(job.id), "s1", 1, "t", 1000);

	// The owner moves between the check of the tick and the start of the action.
	const actions = trackActions(rt);
	const runAction = rt.runAction;
	rt.runAction = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
		db.handle
			.prepare("UPDATE ownership SET session_id = 's2', generation = 2 WHERE task_key = ?")
			.run(taskKey(job.id));
		return runAction(name, fn);
	};

	let notifications = 0;
	monitorJob(rt, job, () => {
		notifications += 1;
	});

	// The first tick checks the ownership and starts the action.
	ticks[0]?.();
	await Promise.all(actions);

	// The second tick sees the new owner. It writes nothing.
	ticks[1]?.();
	await Promise.all(actions);

	assert.equal(job.status, "running", "the action must not write the lifecycle");
	assert.equal(job.pendingStop, null, "the action must not stop the worker");
	assert.equal(notifications, 0, "a skipped action must not notify");
});
