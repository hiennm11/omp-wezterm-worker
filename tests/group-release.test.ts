/**
 * The release of a resource group.
 *
 * A run that ends frees the group of its resources. The pane of the run must
 * be gone, because a live pane can still write into the shared transcript.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	createGroup,
	heldGroups,
	readGroup,
	releaseExecutionByHolder,
	reserveExecution,
	type ResourceGroup,
} from "../extensions/lib/groups.ts";
import { groupsToRelease } from "../extensions/lib/group-recovery.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { finalizeJob } from "../extensions/lib/lifecycle.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { resumeWorker } from "../extensions/lib/spawn.ts";

/** A runtime with a database in a fresh directory. */
function freshRuntime(exec: RunFn): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-group-release-"));
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	return { rt, dir };
}

/** The exec that answers every command with success. */
const okExec: RunFn = async () => ({ code: 0, stdout: "", stderr: "" });

/** A worker record with the fields that these tests need. */
function jobOf(id: string, overrides: Partial<Job> = {}): Job {
	return {
		id,
		label: "test",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		placement: "split",
		sessionDir: "/s/wz-1",
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		status: "running",
		paneId: 7,
		...overrides,
	};
}

/** A group that a run holds. */
function heldGroup(id: string, holder: string): ResourceGroup {
	return {
		id,
		sessionDir: `C:/state/sessions/${holder}`,
		worktreePath: null,
		worktreeOrigin: null,
		worktreeBranch: null,
		executionHolder: holder,
		executionState: "held",
		disposing: false,
		updatedAt: 1000,
	};
}

test("a run that ends with its pane closed frees its group", async () => {
	const { rt, dir } = freshRuntime(okExec);
	try {
		const db = rt.openDb();
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "run-1", 1001);
		const job = jobOf("run-1", { paneId: 7, paneClosed: true });
		rt.jobs.set(job.id, job);

		await finalizeJob(rt, job, "completed", null, "done");

		const group = readGroup(db, "grp-1");
		assert.equal(group?.executionHolder, null);
		assert.equal(group?.executionState, "free");
		const next = reserveExecution(db, "grp-1", "run-2", 1002);
		assert.equal(next.granted, true);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run that ends with its pane alive keeps its group", async () => {
	const { rt, dir } = freshRuntime(okExec);
	try {
		const db = rt.openDb();
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		reserveExecution(db, "grp-1", "run-1", 1001);
		const job = jobOf("run-1", { paneId: 7, paneClosed: false, closePaneOnFinish: false });
		rt.jobs.set(job.id, job);

		await finalizeJob(rt, job, "completed", null, "done");

		const group = readGroup(db, "grp-1");
		assert.equal(group?.executionHolder, "run-1");
		assert.equal(group?.executionState, "held");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed launch of a resume frees the group of the source run", async () => {
	const exec: RunFn = async (_bin, args) =>
		args.includes("split-pane")
			? { code: 1, stdout: "", stderr: "no wezterm" }
			: { code: 0, stdout: "", stderr: "" };
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sourceId = "wz-source-1";
		const groupId = `grp-${sourceId}`;
		const sessionDir = join(dir, "sessions", sourceId);
		mkdirSync(sessionDir, { recursive: true });
		const transcript = join(sessionDir, "a.jsonl");
		writeFileSync(transcript, "", "utf8");
		createGroup(db, groupId, sessionDir, 1000);
		const source = jobOf(sourceId, {
			status: "completed",
			sessionFile: transcript,
			sessionDir,
			paneId: null,
		});

		const resumed = await resumeWorker(rt, source, { jobId: "wz-resume-1" });

		assert.equal(resumed.status, "failed");
		const group = readGroup(db, groupId);
		assert.equal(group?.executionHolder, null);
		assert.equal(group?.executionState, "free");
		const next = reserveExecution(db, groupId, "wz-resume-2", 2000);
		assert.equal(next.granted, true);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the release by holder frees every group that the run holds", () => {
	const { rt, dir } = freshRuntime(okExec);
	try {
		const db = rt.openDb();
		createGroup(db, "grp-1", "C:/state/sessions/wz-1", 1000);
		createGroup(db, "grp-2", "C:/state/sessions/wz-2", 1000);
		reserveExecution(db, "grp-1", "run-1", 1001);
		reserveExecution(db, "grp-2", "run-1", 1001);
		assert.equal(heldGroups(db).length, 2);

		releaseExecutionByHolder(db, "run-1", 1002);

		assert.equal(heldGroups(db).length, 0);
		assert.equal(readGroup(db, "grp-1")?.executionState, "free");
		assert.equal(readGroup(db, "grp-2")?.executionState, "free");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the recovery releases a group whose holder ended with its pane closed", () => {
	const groups = [heldGroup("grp-1", "run-1")];
	const jobs = [jobOf("run-1", { status: "completed", paneId: 7, paneClosed: true })];
	assert.deepEqual(
		groupsToRelease(groups, jobs).map((group) => group.id),
		["grp-1"],
	);
});

test("the recovery keeps a group whose holder is still active", () => {
	const groups = [heldGroup("grp-1", "run-1")];
	const jobs = [jobOf("run-1", { status: "running", paneId: 7, paneClosed: true })];
	assert.deepEqual(groupsToRelease(groups, jobs), []);
});

test("the recovery keeps a group whose holder has no job", () => {
	const groups = [heldGroup("grp-1", "run-1")];
	assert.deepEqual(groupsToRelease(groups, []), []);
});

test("the recovery keeps a group whose holder ended with a live pane", () => {
	const groups = [heldGroup("grp-1", "run-1")];
	const jobs = [jobOf("run-1", { status: "failed", paneId: 7, paneClosed: false })];
	assert.deepEqual(groupsToRelease(groups, jobs), []);
});
