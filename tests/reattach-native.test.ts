/**
 * The re-attachment of a native worker after a restart of OMP.
 *
 * A restart loses the memory of a native run. The new owner starts a new
 * bridge, writes the handover file again and watches the worker. The worker
 * follows the bridge through the handover file.
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { attachWorker } from "../extensions/lib/attach.ts";
import { readHandover, writeHandover } from "../extensions/lib/bridge-handover.ts";
import {
	executionsOfRun,
	markOpenUnknown,
	openExecution,
	settleByCallId,
} from "../extensions/lib/executions.ts";
import { createGroup, readGroup, reserveExecution } from "../extensions/lib/groups.ts";
import { isActive } from "../extensions/lib/job.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { reattachNative } from "../extensions/lib/reattach-native.ts";
import {
	cleanup,
	delivered,
	fakeRuntime,
	makeDirs,
	nativeJob,
	postObservation,
	sleep,
} from "./reattach-native-helpers.ts";

test("a native worker gets a new bridge and a new handover", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		writeHandover(sessionDir, { url: "http://127.0.0.1:1", token: "old-token" });

		await reattachNative(rt, job);

		assert.ok(rt.claudeStates.has(job.id), "the run state exists again");
		assert.ok(rt.bridges.has(job.id), "the bridge exists again");
		const handover = readHandover(sessionDir);
		assert.ok(handover, "the handover names the new bridge");
		assert.equal(handover.url, rt.bridges.get(job.id)?.baseUrl);
		assert.notEqual(handover.token, "old-token", "the new owner has a new token");
	} finally {
		await cleanup(rt, dir);
	}
});

test("the worker follows the new bridge and the old token is refused", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		await reattachNative(rt, job);
		const bridge = rt.bridges.get(job.id);
		assert.ok(bridge);

		const accepted = await postObservation(bridge.baseUrl, bridge.token, "tool.call.opened", {
			callId: "c1",
			tool: "Bash",
		});
		assert.equal(accepted, 202);
		assert.equal(rt.claudeStates.get(job.id)?.openCalls.has("c1"), true);

		const refused = await postObservation(bridge.baseUrl, "old-token", "tool.call.opened", {
			callId: "c2",
			tool: "Bash",
		});
		assert.equal(refused, 401);
		assert.equal(rt.claudeStates.get(job.id)?.openCalls.has("c2"), false);
	} finally {
		await cleanup(rt, dir);
	}
});

test("the run state keeps the native session id of the worker", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		await reattachNative(rt, job);
		assert.equal(rt.claudeStates.get(job.id)?.sessionId, job.nativeSessionId);
	} finally {
		await cleanup(rt, dir);
	}
});

test("only the open rows of the run become the open calls of the state", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		const db = rt.openDb();
		openExecution(db, "ex-unknown", job.id, "tool", "Bash", "call-unknown", null, "opened", "bridge", 1000);
		markOpenUnknown(db, job.id, 1100);
		openExecution(db, "ex-open", job.id, "tool", "Bash", "call-open", null, "opened", "bridge", 1200);
		openExecution(db, "ex-settled", job.id, "tool", "Bash", "call-settled", null, "opened", "bridge", 1300);
		settleByCallId(db, job.id, "call-settled", "tool result", 1400);

		await reattachNative(rt, job);

		const state = rt.claudeStates.get(job.id);
		assert.equal(state?.openCalls.has("call-open"), true);
		assert.equal(state?.openCalls.has("call-unknown"), false);
		assert.equal(state?.openCalls.has("call-settled"), false);
		const states = executionsOfRun(db, job.id)
			.map((row) => row.state)
			.sort();
		assert.deepEqual(states, ["open", "settled", "unknown"], "no row changes its state");
	} finally {
		await cleanup(rt, dir);
	}
});

test("the new owner receives the report of the worker and ends the run", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt, tick } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		await reattachNative(rt, job);
		const bridge = rt.bridges.get(job.id);
		assert.ok(bridge);
		await postObservation(bridge.baseUrl, bridge.token, "turn.start", { turnId: "turn-1" });
		await postObservation(bridge.baseUrl, bridge.token, "turn.complete", {
			turnId: "turn-1",
			usage: null,
		});
		await postObservation(bridge.baseUrl, bridge.token, "report", {
			cycleId: "turn-1",
			state: "completed",
			result: "THE-ANSWER",
		});

		const notified = Promise.withResolvers<void>();
		monitorNativeJob(rt, job, () => notified.resolve());
		tick();
		await delivered(notified);

		assert.equal(job.status, "completed");
		assert.equal(job.result, "THE-ANSWER");
	} finally {
		await cleanup(rt, dir);
	}
});

test("an open row blocks the completion until a settlement arrives", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt, tick } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		openExecution(rt.openDb(), "ex-c2", job.id, "tool", "Bash", "c2", null, "opened", "bridge", 1000);
		await reattachNative(rt, job);
		const bridge = rt.bridges.get(job.id);
		assert.ok(bridge);
		await postObservation(bridge.baseUrl, bridge.token, "turn.start", { turnId: "turn-1" });
		await postObservation(bridge.baseUrl, bridge.token, "turn.complete", {
			turnId: "turn-1",
			usage: null,
		});
		await postObservation(bridge.baseUrl, bridge.token, "report", {
			cycleId: "turn-1",
			state: "completed",
			result: "THE-ANSWER",
		});

		const notified = Promise.withResolvers<void>();
		monitorNativeJob(rt, job, () => notified.resolve());
		tick();
		await delivered(notified);
		assert.equal(job.status, "running", "the open row keeps the worker alive");

		await postObservation(bridge.baseUrl, bridge.token, "tool.call.settled", { callId: "c2" });
		tick();
		await delivered(notified);

		assert.equal(job.status, "completed", "the settled row lets the worker end");
		assert.equal(job.result, "THE-ANSWER");
	} finally {
		await cleanup(rt, dir);
	}
});

test("attachWorker gives a native worker a bridge and a monitor", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		await attachWorker(rt, job, () => undefined);
		assert.ok(rt.bridges.has(job.id), "the bridge exists");
		assert.ok(rt.claudeStates.has(job.id), "the run state exists");
		assert.ok(rt.monitors.has(job.id), "the monitor runs");
	} finally {
		await cleanup(rt, dir);
	}
});

test("attachWorker ends a native worker whose pane is gone", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, []);
	try {
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		await attachWorker(rt, job, () => undefined);
		assert.equal(rt.bridges.has(job.id), false, "no bridge exists");
		assert.equal(isActive(job), false, "the worker is no longer active");
	} finally {
		await cleanup(rt, dir);
	}
});

test("attachWorker keeps the old behaviour for an OMP worker", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const job = nativeJob(sessionDir, { backend: undefined });
		rt.jobs.set(job.id, job);
		await attachWorker(rt, job, () => undefined);
		assert.equal(rt.bridges.has(job.id), false, "no bridge exists");
		assert.ok(rt.monitors.has(job.id), "the monitor runs");
	} finally {
		await cleanup(rt, dir);
	}
});

test("a handover that cannot be written leaves no bridge and no state", async () => {
	const { dir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		const job = nativeJob(join(blocker, "sessions", "wz-1"));
		rt.jobs.set(job.id, job);

		await assert.rejects(() => reattachNative(rt, job));
		assert.equal(rt.claudeStates.has(job.id), false, "no run state exists");
		assert.equal(rt.bridges.has(job.id), false, "no bridge exists");
	} finally {
		await cleanup(rt, dir);
	}
});

test("attachWorker stops the worker when the re-attachment fails", async () => {
	const { dir } = makeDirs();
	const { rt, commands } = fakeRuntime(dir, [7]);
	try {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		const job = nativeJob(join(blocker, "sessions", "wz-1"));
		rt.jobs.set(job.id, job);

		await attachWorker(rt, job, () => undefined);

		const kills = commands.filter((command) => command.join(" ").includes("kill-pane"));
		assert.equal(kills.length, 1, "the pane of the worker receives a kill command");
		assert.equal(job.status, "failed", "the worker ends as failed");
		assert.ok(
			(job.error ?? "").startsWith("The native worker could not be attached again:"),
			`the worker holds the error of the re-attachment: ${job.error}`,
		);
		assert.equal(rt.monitors.size, 0, "no monitor runs");
	} finally {
		await cleanup(rt, dir);
	}
});

test("a failed re-attachment closes the open rows of the run", async () => {
	const { dir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		const job = nativeJob(join(blocker, "sessions", "wz-1"));
		rt.jobs.set(job.id, job);
		const db = rt.openDb();
		openExecution(db, "ex-1", job.id, "tool", "Bash", "call-1", null, "opened", "bridge", 1000);

		await attachWorker(rt, job, () => undefined);

		const rows = executionsOfRun(db, job.id);
		assert.equal(rows.length, 1, "the run keeps its row");
		assert.equal(rows[0].state, "unknown", "the open row becomes unknown");
		assert.equal(
			rows.filter((row) => row.state === "open").length,
			0,
			"no row of the run stays open",
		);
	} finally {
		await cleanup(rt, dir);
	}
});

test("a failed re-attachment frees the execution of the group", async () => {
	const { dir, sessionDir } = makeDirs();
	const { rt, commands } = fakeRuntime(dir, [7]);
	try {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		const job = nativeJob(join(blocker, "sessions", "wz-1"));
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
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		const job = nativeJob(join(blocker, "sessions", "wz-1"));
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
