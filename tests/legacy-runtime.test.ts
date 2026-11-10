/**
 * The runs of an older version.
 *
 * A run that the database holds from before the pane runtime existed has no
 * runtime. The extension never guesses Herdr for such a run. A tool that
 * acts on it reports that its runtime is unknown.
 *
 * The column `pane_id` of the table `runs` holds an integer. SQLite keeps a
 * text id in that column as text, so a pane id such as `w4:p1` survives a
 * write and a read. The extension changes no column and adds no migration.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { type LifecycleDb, openDatabase } from "../extensions/lib/db.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { killPane, paneState, sendToPane, unknownRuntimeRefusal } from "../extensions/lib/pane.ts";
import { runtimeOf } from "../extensions/lib/pane.ts";
import { loadRuns, persistRuns } from "../extensions/lib/runs.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";

/** A database in a fresh directory. */
function freshDb(): { db: LifecycleDb; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-legacy-runtime-"));
	return { db: openDatabase(join(dir, "lifecycle.db")), dir };
}

/** A job of a run that an older version stored. */
function legacyJob(overrides: Partial<Job> = {}): Job {
	return {
		...freshRunState(1000),
		id: "wz-old-1",
		label: "old",
		task: "task",
		cwd: "/repo",
		model: null,
		tools: null,
		status: "completed",
		paneId: "w4:p1",
		tabId: null,
		windowId: null,
		placement: "split",
		sessionDir: "/state/sessions/wz-old-1",
		sessionFile: null,
		createdAt: 1000,
		startedAt: 1001,
		finishedAt: 1002,
		result: "the answer",
		error: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		worktreeDirty: null,
		pendingStop: null,
		lastActivityAt: 1003,
		currentTool: null,
		turns: 2,
		baselineTurns: 0,
		usageBaseline: null,
		steers: 0,
		lastTranscriptSize: 10,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		paneClosed: false,
		...overrides,
	};
}

/** A runtime that records every call of a pane runtime. */
function recordingRuntime(): { rt: WorkerRuntime; calls: string[][] } {
	const calls: string[][] = [];
	const rt = createRuntime(async (_bin, args) => {
		calls.push(args);
		return { code: 0, stdout: "", stderr: "" };
	});
	rt.paneRuntime = "herdr";
	return { rt, calls };
}

test("a run of the database holds no runtime", () => {
	const { db, dir } = freshDb();
	try {
		persistRuns(db, null, [legacyJob()]);
		const { finished } = loadRuns(db);
		assert.equal(finished.length, 1);
		assert.equal(finished[0].runtime, undefined, "the run of the database holds a runtime");
		assert.equal(runtimeOf(finished[0]), null, "the run was guessed as Herdr");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a tool that acts on a run without a runtime reports an unknown runtime", async () => {
	const { rt, calls } = recordingRuntime();
	try {
		const job = legacyJob();
		const refusal = unknownRuntimeRefusal(job);
		assert.ok(refusal, "the unknown runtime was not reported");
		assert.match(refusal, /unknown/);
		assert.match(refusal, /wz-old-1/);
		assert.equal(await paneState(rt, job), "unknown");
		const sent = await sendToPane(rt, job, "text");
		assert.equal(sent.ok, false);
		assert.match(sent.error ?? "", /unknown/);
		const killed = await killPane(rt, job);
		assert.match(killed ?? "", /unknown/);
		assert.deepEqual(calls, [], "a pane runtime received a call for a run without a runtime");
	} finally {
		rt.closeDb();
	}
});

test("a run with a runtime keeps it through a reload", () => {
	const { db, dir } = freshDb();
	try {
		persistRuns(db, null, [legacyJob({ runtime: "wezterm" })]);
		const { finished } = loadRuns(db);
		assert.equal(finished.length, 1);
		assert.equal(finished[0].runtime, "wezterm", "the runtime did not survive the reload");
		assert.equal(runtimeOf(finished[0]), "wezterm");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a text pane id survives a write and a read in the integer column", () => {
	const { db, dir } = freshDb();
	try {
		persistRuns(db, null, [legacyJob({ paneId: "w4:p1", runtime: "herdr" })]);
		const row = db.handle.prepare("SELECT pane_id FROM runs WHERE id = ?").get("wz-old-1") as {
			pane_id: unknown;
		};
		assert.equal(row.pane_id, "w4:p1", "the pane id did not survive the write");
		const { finished, alive } = loadRuns(db);
		assert.equal(finished.length, 1);
		assert.equal(finished[0].paneId, "w4:p1", "the pane id did not survive the read");
		assert.equal(alive.length, 0);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
