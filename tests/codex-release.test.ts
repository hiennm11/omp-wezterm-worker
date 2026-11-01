/**
 * The release of a running Codex worker.
 *
 * A release hands the worker over. The session that released it keeps no
 * client, no run state and no bridge, so it can no longer observe the
 * worker. The worker keeps running: no pane closes and no program ends.
 *
 * The release of an OMP worker and of a Claude worker keeps its behaviour.
 *
 * The tests use the fakes of the Codex spawn, so no real program runs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Job } from "../extensions/lib/job.ts";
import { cleanup, fakeIn, freshDir, releaseTool, spawnFirst, WORKER } from "./codex-takeover-helpers.ts";

test("a release of a Codex worker leaves no client and no run state behind", async () => {
	const dir = freshDir();
	const first = fakeIn(dir);
	try {
		const job = await spawnFirst(first);
		assert.equal(first.rt.codexClients.has(job.id), true, "the first session holds no client");
		assert.equal(first.rt.claudeStates.has(job.id), true, "the first session holds no run state");

		const released = await releaseTool(first.rt).execute("t1", { workerId: job.id });

		assert.equal(released.isError, undefined, released.content[0]?.text);
		assert.equal(released.details.released, true);
		assert.equal(first.rt.codexClients.has(job.id), false, "the first session kept the client");
		assert.equal(first.rt.claudeStates.has(job.id), false, "the first session kept the run state");
		assert.equal(first.rt.bridges.has(job.id), false, "the first session kept the bridge");
		assert.equal(job.status, "running", "the release stopped the worker");
		assert.deepEqual(first.killedPanes, [], "the release closed a pane");
		assert.deepEqual(first.taskkills, [], "the release ended a program");
		assert.equal(first.clientCloses, 1, "the release kept the socket of the client open");
	} finally {
		await cleanup(dir, first);
	}
});

test("the release of an OMP worker closes no bridge and ends no program", async () => {
	const dir = freshDir();
	const first = fakeIn(dir);
	try {
		const job = await spawnFirst(first);
		/* An OMP worker holds no bridge and no client. */
		const ompJob: Job = { ...job, backend: "omp" };
		first.rt.jobs.set(ompJob.id, ompJob);
		first.rt.claudeStates.delete(ompJob.id);

		const released = await releaseTool(first.rt).execute("t1", { workerId: ompJob.id });

		assert.equal(released.isError, undefined, released.content[0]?.text);
		assert.equal(released.details.released, true);
		assert.equal(first.rt.bridges.has(ompJob.id), false, "the release kept a bridge");
		assert.equal(first.rt.codexClients.has(ompJob.id), false, "the release kept a client");
		assert.equal(ompJob.status, "running", "the release stopped the worker");
		assert.deepEqual(first.killedPanes, [], "the release closed a pane");
		assert.deepEqual(first.taskkills, [], "the release ended a program");
	} finally {
		await cleanup(dir, first);
	}
});

test("the release of a Claude worker closes its bridge and keeps the worker", async () => {
	const dir = freshDir();
	const first = fakeIn(dir);
	try {
		const job = await spawnFirst(first);
		const claudeJob: Job = { ...job, backend: "claude" };
		first.rt.jobs.set(claudeJob.id, claudeJob);
		const state = first.rt.claudeStates.get(claudeJob.id);
		assert.ok(state, "the run holds no state");

		const released = await releaseTool(first.rt).execute("t1", { workerId: claudeJob.id });

		assert.equal(released.isError, undefined, released.content[0]?.text);
		assert.equal(released.details.released, true);
		assert.equal(first.rt.bridges.has(claudeJob.id), false, "the release kept the bridge");
		assert.equal(first.rt.claudeStates.has(claudeJob.id), false, "the release kept the run state");
		assert.equal(claudeJob.status, "running", "the release stopped the worker");
		assert.deepEqual(first.killedPanes, [], "the release closed a pane");
		assert.deepEqual(first.taskkills, [], "the release ended a program");
	} finally {
		await cleanup(dir, first);
	}
});

test("the release of a worker of another session is refused", async () => {
	const dir = freshDir();
	const first = fakeIn(dir);
	try {
		const job = await spawnFirst(first);
		first.rt.sessionId = "session-other";

		const released = await releaseTool(first.rt).execute("t1", { workerId: job.id });

		assert.equal(released.isError, true);
		assert.equal(released.details.released, false);
		assert.equal(first.rt.codexClients.has(WORKER), true, "the refusal closed the client");
	} finally {
		await cleanup(dir, first);
	}
});
