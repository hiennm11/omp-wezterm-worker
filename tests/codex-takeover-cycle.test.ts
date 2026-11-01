/**
 * The report of a Codex worker after a takeover.
 *
 * A new owner restores the turn that the worker still runs. A report that
 * carries the id of that turn ends the worker. A report that names no turn
 * proves nothing about the work that runs now, so it never ends the worker.
 *
 * The test uses the fakes of the Codex spawn, so no real program runs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { monitorNativeJob } from "../extensions/lib/monitor.ts";
import { appendReport } from "../extensions/lib/report-store.ts";
import {
	cleanup,
	fakeIn,
	freshDir,
	releaseTool,
	secondSession,
	serverRow,
	spawnFirst,
	WORKER,
} from "./codex-takeover-helpers.ts";
import { takeOver } from "./takeover-helpers.ts";

/** The identity of a worker whose app server is gone. */
function goneIdentity() {
	return {
		port: 0,
		serverPid: 0,
		threadId: "",
		serverPaneId: null,
		tuiPaneId: null,
		binaryPath: "",
		version: "",
	};
}

/** Send one observation to the bridge of a run. */
async function observe(url: string, token: string, source: string, payload: unknown): Promise<void> {
	const response = await fetch(`${url}/observations`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({ backend: "codex", runId: WORKER, sessionId: null, source, payload }),
	});
	assert.equal(response.status, 202, `the bridge refused the ${source} observation`);
}

test("a report of the restored turn ends the worker after a takeover", async () => {
	const dir = freshDir();
	const first = fakeIn(dir);
	let second = null;
	try {
		const job = await spawnFirst(first);
		const released = await releaseTool(first.rt).execute("t1", { workerId: job.id });
		assert.equal(released.isError, undefined, released.content[0]?.text);

		second = fakeIn(dir, [serverRow(job.codex ?? goneIdentity())]);
		const taken = secondSession(second);
		const result = await takeOver(second.rt, WORKER);
		assert.equal(result.isError, undefined, result.content[0]?.text);

		/* The new owner restored the turn that the worker still runs. */
		const state = second.rt.claudeStates.get(WORKER);
		assert.ok(state, "the new owner holds no run state");
		assert.equal(state.currentCycleId, "turn-open", "the new owner restored no turn");

		const bridge = second.rt.bridges.get(WORKER);
		assert.ok(bridge, "the new owner holds no bridge");
		await observe(bridge.baseUrl, bridge.token, "turn.complete", {
			turnId: "turn-open",
			usage: null,
		});
		await observe(bridge.baseUrl, bridge.token, "report", {
			cycleId: "turn-open",
			state: "completed",
			result: "TAKEOVER-OK",
		});

		let tick = () => {};
		second.rt.timers = {
			setInterval: (fn) => {
				tick = fn;
				return { fake: true } as unknown as NodeJS.Timeout;
			},
		};
		const notified = Promise.withResolvers<void>();
		monitorNativeJob(second.rt, taken, () => notified.resolve());
		tick();
		await notified.promise;

		assert.equal(taken.status, "completed", "the report of the restored turn did not end the worker");
		assert.equal(taken.result, "TAKEOVER-OK");
	} finally {
		await cleanup(dir, first, second);
	}
});

test("an old report without a turn does not end the worker after a takeover", async () => {
	const dir = freshDir();
	const first = fakeIn(dir);
	let second = null;
	try {
		const job = await spawnFirst(first);
		const released = await releaseTool(first.rt).execute("t1", { workerId: job.id });
		assert.equal(released.isError, undefined, released.content[0]?.text);

		/* The worker reports while no owner holds the task. The report
		   names no turn, because the report server of an older build did
		   not send one. */
		appendReport(job.sessionDir, {
			runId: job.id,
			cycleId: null,
			state: "completed",
			result: "OLD-OK",
			dependency: null,
			resumeCondition: null,
			needs: null,
			detail: null,
		});

		second = fakeIn(dir, [serverRow(job.codex ?? goneIdentity())]);
		const taken = secondSession(second);
		const result = await takeOver(second.rt, WORKER);
		assert.equal(result.isError, undefined, result.content[0]?.text);

		const bridge = second.rt.bridges.get(WORKER);
		assert.ok(bridge, "the new owner holds no bridge");
		await observe(bridge.baseUrl, bridge.token, "turn.complete", {
			turnId: "turn-open",
			usage: null,
		});

		let tick = () => {};
		second.rt.timers = {
			setInterval: (fn) => {
				tick = fn;
				return { fake: true } as unknown as NodeJS.Timeout;
			},
		};
		monitorNativeJob(second.rt, taken, () => undefined);
		tick();

		assert.equal(taken.status, "running", "the old report ended the worker");
	} finally {
		await cleanup(dir, first, second);
	}
});
