/**
 * The authority of a write of a run.
 *
 * A session writes the row of a run only when it holds the authority of the
 * task of that run. A session that does not hold the authority keeps a stale
 * copy of the run. Its write must not change the row of the owner.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { taskKey } from "../extensions/lib/owner.ts";
import { acquireOwnership, beginRelease, commitRelease } from "../extensions/lib/ownership.ts";
import { loadRuns } from "../extensions/lib/runs.ts";
import type { WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerReleaseTool } from "../extensions/worker-tools/release.ts";
import { type FakeTool, fakeRuntime, fakeZod, makeJob } from "./takeover-helpers.ts";

/** The session that holds the task of the worker. */
const OWN = "session-a";

/** The session that does not hold the task of the worker. */
const OTHER = "session-b";

/** A state directory that holds the database of the sessions. */
function freshDir(): string {
	return mkdtempSync(join(tmpdir(), "wt-run-authority-"));
}

/** A runtime with a database in the given state directory. */
function runtimeIn(dir: string): WorkerRuntime {
	const { rt } = fakeRuntime({ starts: {}, code: 0, panes: [3] }, { stateDir: dir });
	return rt;
}

/** The owner of the task of a worker. */
function seedOwner(rt: WorkerRuntime, jobId: string, sessionId: string): void {
	acquireOwnership(rt.openDb(), taskKey(jobId), sessionId, 900, "2026-10-29T08:00:00.000Z", 1000);
}

/** The release tool of the extension, with the given runtime. */
function releaseTool(rt: WorkerRuntime): FakeTool {
	const tools = new Map<string, FakeTool>();
	registerReleaseTool({
		pi: {
			zod: fakeZod(),
			registerTool: (tool: FakeTool) => tools.set("release", tool),
		} as never,
		rt,
		deliver: () => undefined,
	});
	const tool = tools.get("release");
	assert.ok(tool, "the release tool was not registered");
	return tool;
}

/** Close the runtimes and remove the state directory of a test. */
function finish(...runtimes: WorkerRuntime[]): void {
	for (const rt of runtimes) rt.closeDb();
}

test("a session that does not hold the authority keeps the row of the owner", () => {
	const dir = freshDir();
	const owner = runtimeIn(dir);
	const other = runtimeIn(dir);
	try {
		owner.sessionId = OWN;
		other.sessionId = OTHER;
		const fresh = join(dir, "sessions", "wz-1", "session.jsonl");
		const job = makeJob(dir, "wz-1", { status: "running", sessionFile: fresh });
		seedOwner(owner, job.id, OWN);
		owner.jobs.set(job.id, job);
		owner.persist();

		// The other session keeps a stale copy of the run. Its write must not
		// change the row of the owner.
		const stale = makeJob(dir, "wz-1", { status: "running", sessionFile: null });
		other.jobs.set(stale.id, stale);
		other.persist();

		const { alive } = loadRuns(owner.openDb());
		assert.equal(alive.length, 1);
		assert.equal(alive[0].sessionFile, fresh, "the row must keep the state of the owner");
	} finally {
		finish(owner, other);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run without an ownership row gets its first row", () => {
	const dir = freshDir();
	const rt = runtimeIn(dir);
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		rt.persist();

		const { alive } = loadRuns(rt.openDb());
		assert.equal(alive.length, 1, "a new run must get its first row");
		assert.equal(alive[0].id, "wz-1");
		assert.equal(alive[0].status, "running");
	} finally {
		finish(rt);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a session without an identity writes the row of the run", () => {
	const dir = freshDir();
	const rt = runtimeIn(dir);
	try {
		rt.sessionId = null;
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		rt.persist();

		const { alive } = loadRuns(rt.openDb());
		assert.equal(alive.length, 1, "a session without an identity writes as it did before");
		assert.equal(alive[0].id, "wz-1");
	} finally {
		finish(rt);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run of a task that another session released is not written", () => {
	const dir = freshDir();
	const owner = runtimeIn(dir);
	const other = runtimeIn(dir);
	try {
		owner.sessionId = OWN;
		other.sessionId = OTHER;
		const job = makeJob(dir, "wz-1");
		seedOwner(owner, job.id, OTHER);
		beginRelease(owner.openDb(), taskKey(job.id), OTHER, 1, 1100);
		commitRelease(owner.openDb(), taskKey(job.id), OTHER, 1, 1200);

		other.jobs.set(job.id, job);
		other.persist();

		const { alive, finished } = loadRuns(owner.openDb());
		assert.equal(alive.length, 0, "a released task must not get a new row");
		assert.equal(finished.length, 0);
	} finally {
		finish(owner, other);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the release writes the row of the run that it releases", async () => {
	const dir = freshDir();
	const rt = runtimeIn(dir);
	try {
		rt.sessionId = OWN;
		const job = makeJob(dir, "wz-1");
		rt.jobs.set(job.id, job);
		const db = rt.openDb();
		seedOwner(rt, job.id, OWN);
		// The first write gives the run its row.
		rt.persist();

		// The owner learns the transcript of the worker. The row must hold it
		// when the authority moves to another session.
		job.sessionFile = join(dir, "sessions", "wz-1", "session.jsonl");

		const result = await releaseTool(rt).execute("t1", { workerId: job.id });

		assert.equal(result.isError, undefined, result.content[0]?.text);
		const { alive } = loadRuns(db);
		assert.equal(alive.length, 1, "the release must keep the row of the run");
		assert.equal(alive[0].sessionFile, join(dir, "sessions", "wz-1", "session.jsonl"));
	} finally {
		finish(rt);
		rmSync(dir, { recursive: true, force: true });
	}
});
