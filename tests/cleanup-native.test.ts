/**
 * The cleanup of a native run.
 *
 * A native run is a Claude Code run. Its job has the backend `claude` and a
 * native session id. The cleanup of such a run must refuse while an event
 * waits for the owner, and it must delete the transcript after the owner
 * handled the event.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { recordHandling } from "../extensions/lib/events.ts";
import { registerCleanupTool } from "../extensions/worker-tools/cleanup.ts";
import {
	finish,
	nativeJob,
	nativeRuntime,
	seedOwner,
	seedPermissionEvent,
	toolOf,
} from "./native-run-helpers.ts";

/** The session that calls the tool. */
const OWN = "session-1";

test("the cleanup of a native run refuses while an event waits for the owner", async () => {
	const { rt, dir, sessionDir } = nativeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OWN);
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		seedPermissionEvent(rt, job.id, "ev-1");

		const result = await toolOf(rt, registerCleanupTool, "cleanup").execute("t1", { workerId: "wz-1" });

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /ev-1/);
		assert.match(result.content[0]?.text ?? "", /unhandled event/);
		assert.deepEqual(result.details.pendingEvents, ["ev-1"]);
		assert.equal(existsSync(sessionDir), true, "the transcript directory stays");
	} finally {
		finish(rt, dir);
	}
});

test("the cleanup of a native run deletes the transcript after the owner handled the event", async () => {
	const { rt, dir, sessionDir } = nativeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OWN);
		const job = nativeJob(sessionDir);
		rt.jobs.set(job.id, job);
		seedPermissionEvent(rt, job.id, "ev-1");
		/* The test records the handling with the function of the events
		   library. The ack tool writes the same row, and the cleanup only
		   reads the row of the handling. */
		recordHandling(rt.openDb(), "ev-1", "accepted", null, OWN, 1, Date.now());

		const result = await toolOf(rt, registerCleanupTool, "cleanup").execute("t1", { workerId: "wz-1" });

		assert.notEqual(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /transcript directory removed/);
		assert.equal(existsSync(sessionDir), false, "the transcript directory is gone");
	} finally {
		finish(rt, dir);
	}
});

test("the cleanup of a running native run refuses", async () => {
	const { rt, dir, sessionDir } = nativeRuntime();
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OWN);
		const job = nativeJob(sessionDir, { status: "running", paneId: 7 });
		rt.jobs.set(job.id, job);

		const result = await toolOf(rt, registerCleanupTool, "cleanup").execute("t1", { workerId: "wz-1" });

		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text, "Worker wz-1 is still running. Cancel it first.");
		assert.equal(result.details.status, "running");
		assert.equal(existsSync(sessionDir), true, "the transcript directory stays");
	} finally {
		finish(rt, dir);
	}
});

test("the cleanup of a native run keeps the worktree while its pane is open", async () => {
	const { rt, dir, sessionDir } = nativeRuntime([7]);
	try {
		rt.sessionId = OWN;
		seedOwner(rt, "wz-1", OWN);
		const worktreePath = join(dir, "worktrees", "wz-1");
		mkdirSync(worktreePath, { recursive: true });
		const job = nativeJob(sessionDir, { paneId: 7, worktreePath, worktreeBranch: "omp/worker/wz-1" });
		rt.jobs.set(job.id, job);

		const result = await toolOf(rt, registerCleanupTool, "cleanup").execute("t1", { workerId: "wz-1" });

		assert.notEqual(result.isError, true);
		const notes = result.details.notes as string[];
		assert.ok(
			notes.includes("worktree kept: close pane 7 first, it holds the directory"),
			`the notes name the pane: ${JSON.stringify(notes)}`,
		);
		assert.equal(result.details.keptWorktree, worktreePath);
		assert.equal(existsSync(worktreePath), true, "the worktree stays");
	} finally {
		finish(rt, dir);
	}
});
