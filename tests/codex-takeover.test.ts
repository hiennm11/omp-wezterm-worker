/**
 * The takeover of a running Codex worker by another session.
 *
 * A second session takes the worker over through the re-attachment. It gets
 * a client, a run state and a handover file. The worker keeps its id, and no
 * second app server and no second worker start.
 *
 * A takeover whose identity check fails stops the worker as `failed`, and it
 * ends no program that the check did not prove.
 *
 * The tests use the fakes of the Codex spawn, so no real program runs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readHandover } from "../extensions/lib/bridge-handover.ts";
import { connectCodexServer } from "../extensions/lib/codex-client.ts";
import type { CodexIdentity } from "../extensions/lib/job.ts";
import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership } from "../extensions/lib/ownership.ts";
import { appendReport } from "../extensions/lib/report-store.ts";
import {
	cleanup,
	fakeIn,
	freshDir,
	releaseTool,
	secondSession,
	serverRow,
	spawnFirst,
	THREAD,
	WORKER,
} from "./codex-takeover-helpers.ts";
import { startFakeWsServer } from "./codex-websocket-server.ts";
import { takeOver } from "./takeover-helpers.ts";

/** The identity of a worker whose app server is gone. */
function goneIdentity(): CodexIdentity {
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

test("a second session takes over a released Codex worker", async () => {
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
		assert.equal(result.details.taken, true);
		assert.equal(second.rt.codexClients.has(WORKER), true, "the new owner holds no client");
		assert.equal(second.rt.claudeStates.has(WORKER), true, "the new owner holds no run state");
		const handover = readHandover(taken.sessionDir);
		assert.ok(handover, "the new owner wrote no handover file");
		assert.equal(handover.url, second.rt.bridges.get(WORKER)?.baseUrl);
		const resume = second.clientCalls.find((call) => call.method === "thread/resume");
		assert.ok(resume, "the thread was not resumed");
		assert.equal(resume.params.threadId, THREAD);
		assert.deepEqual(
			second.weztermCalls.filter((call) => call.includes("app-server")),
			[],
			"a second app server started",
		);
		assert.equal(second.rt.jobs.size, 1, "a second worker exists");
		assert.equal(taken.id, WORKER, "the worker lost its id");
		assert.equal(taken.status, "running", "the worker stopped");
	} finally {
		await cleanup(dir, first, second);
	}
});

test("a second session takes over a Codex worker of a dead first session", async () => {
	const dir = freshDir();
	const first = fakeIn(dir);
	let second = null;
	try {
		const job = await spawnFirst(first);
		/* The owner row names a process that the machine no longer holds. */
		acquireOwnership(
			first.rt.openDb(),
			taskKey(job.id),
			"session-first",
			900,
			"2026-10-22T08:00:00.000Z",
			1100,
		);

		second = fakeIn(dir, [serverRow(job.codex ?? goneIdentity())]);
		const taken = secondSession(second);
		const result = await takeOver(second.rt, WORKER);

		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(result.details.taken, true);
		assert.equal(second.rt.codexClients.has(WORKER), true, "the new owner holds no client");
		assert.equal(second.rt.claudeStates.has(WORKER), true, "the new owner holds no run state");
		assert.ok(readHandover(taken.sessionDir), "the new owner wrote no handover file");
		assert.deepEqual(
			second.weztermCalls.filter((call) => call.includes("app-server")),
			[],
			"a second app server started",
		);
		assert.equal(second.rt.jobs.size, 1, "a second worker exists");
		assert.equal(taken.status, "running", "the worker stopped");
	} finally {
		await cleanup(dir, first, second);
	}
});

test("a takeover of a Codex worker that fails the identity check stops it as failed", async () => {
	const dir = freshDir();
	const first = fakeIn(dir);
	let second = null;
	try {
		const job = await spawnFirst(first);
		const released = await releaseTool(first.rt).execute("t1", { workerId: job.id });
		assert.equal(released.isError, undefined, released.content[0]?.text);
		/* The first session gave the worker away. It holds no client, so the
		   new owner is the only writer of the thread. */
		assert.equal(first.rt.codexClients.has(job.id), false, "the first session kept the client");

		/* The machine holds no app server of that worker any more. */
		second = fakeIn(dir);
		const taken = secondSession(second);
		const result = await takeOver(second.rt, WORKER);

		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(result.details.taken, true);
		assert.equal(taken.status, "failed", "the worker did not fail");
		assert.match(taken.error ?? "", /check of the process/, taken.error ?? "");
		assert.deepEqual(second.taskkills, [], "a program of the user ended");
		assert.equal(taken.codex?.serverPid, null, "the identity kept the process");
	} finally {
		await cleanup(dir, first, second);
	}
});

test("a second session reads the report that arrived while no owner held the task", async () => {
	const dir = freshDir();
	const first = fakeIn(dir);
	let second = null;
	try {
		const job = await spawnFirst(first);
		const released = await releaseTool(first.rt).execute("t1", { workerId: job.id });
		assert.equal(released.isError, undefined, released.content[0]?.text);

		/* The worker reports while no owner holds the task. The report goes
		   to the report file, because the bridge of the release is gone. */
		appendReport(job.sessionDir, {
			runId: job.id,
			cycleId: null,
			state: "completed",
			result: "TAKEOVER-OK",
			dependency: null,
			resumeCondition: null,
			needs: null,
			detail: null,
		});

		second = fakeIn(dir, [serverRow(job.codex ?? goneIdentity())]);
		secondSession(second);
		const result = await takeOver(second.rt, WORKER);

		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.equal(result.details.taken, true);
		const state = second.rt.claudeStates.get(WORKER);
		assert.ok(state, "the new owner holds no run state");
		assert.equal(state.reports.length, 1, "the new owner read no report");
		assert.equal(state.reports[0].result, "TAKEOVER-OK");
	} finally {
		await cleanup(dir, first, second);
	}
});

test("a closed client of the app server delivers no message to its handler", async () => {
	const server = await startFakeWsServer();
	try {
		const client = await connectCodexServer(`ws://127.0.0.1:${server.port}`);
		const seen: string[] = [];
		client.setMessageHandler((message) => {
			seen.push(message.method ?? "no-method");
		});

		client.close();
		server.send(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1" } } }));
		/* The end of the connection comes after the data of the frame. The
		   test waits for it, so the client has read the frame. */
		await server.endConnection();

		assert.deepEqual(seen, [], "a closed client delivered a message to its handler");
	} finally {
		await server.close();
	}
});
