/**
 * The re-attachment of a native worker after a restart of OMP.
 *
 * A restart loses the memory of a native run. The new owner starts a new
 * bridge, writes the handover file again and watches the worker. The worker
 * follows the bridge through the handover file.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { freshRunState, isActive, type Job } from "../extensions/lib/job.ts";
import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { reattachNative } from "../extensions/lib/reattach-native.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

/** A runtime whose pane list comes from the test and whose poll runs by hand. */
function fakeRuntime(stateDir: string, panes: number[]): { rt: WorkerRuntime; tick: () => void } {
	const exec: RunFn = async (_bin, args) => {
		if (args.join(" ").includes("list --format json")) {
			const listing = panes.map((pane_id) => ({ pane_id }));
			return { code: 0, stdout: JSON.stringify(listing), stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
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

/** A running native worker with a session directory. */
function nativeJob(sessionDir: string, overrides: Partial<Job> = {}): Job {
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
		...freshRunState(Date.now()),
		status: "running",
		paneId: 7,
		backend: "claude",
		nativeSessionId: "sess-1",
		...overrides,
	} as Job;
}

/** A state directory with a session directory inside it. */
function makeDirs(): { dir: string; sessionDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wz-reattach-"));
	const sessionDir = join(dir, "sessions", "wz-1");
	mkdirSync(sessionDir, { recursive: true });
	return { dir, sessionDir };
}

/** Send one observation to a bridge and return the status code. */
async function postObservation(url: string, token: string, source: string, payload: unknown) {
	const response = await fetch(`${url}/observations`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ backend: "claude", runId: "wz-1", sessionId: null, source, payload }),
	});
	return response.status;
}

/** Let the pending work of the monitor finish. The wait has no duration. */
async function flush(turns: number): Promise<void> {
	for (let step = 0; step < turns; step += 1) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

/** Wait for the monitor to deliver the result of the worker. */
async function delivered(notified: PromiseWithResolvers<void>): Promise<void> {
	await Promise.race([notified.promise, flush(50)]);
}

/** Close the bridges, the database and the directory of a test. */
async function cleanup(rt: WorkerRuntime, dir: string): Promise<void> {
	await Promise.all([...rt.bridges.values()].map((bridge) => bridge.close()));
	rt.bridges.clear();
	rt.claudeStates.clear();
	rt.closeDb();
	rmSync(dir, { recursive: true, force: true });
}

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

test("attachWorker fails the worker when the re-attachment fails", async () => {
	const { dir } = makeDirs();
	const { rt } = fakeRuntime(dir, [7]);
	try {
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "x");
		const job = nativeJob(join(blocker, "sessions", "wz-1"));
		rt.jobs.set(job.id, job);

		await attachWorker(rt, job, () => undefined);
		assert.equal(job.status, "failed");
		assert.ok((job.error ?? "").length > 0, "the worker holds an error");
		assert.equal(rt.monitors.size, 0, "no monitor runs");
	} finally {
		await cleanup(rt, dir);
	}
});
