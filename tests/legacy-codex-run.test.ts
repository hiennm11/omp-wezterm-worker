/**
 * A run that the database holds with the backend `codex`.
 *
 * The Codex backend was removed. A run that an older release wrote must still
 * load, and the status tool must list it as an ended run. The run must never
 * start, resume, steer or cancel. Every tool that gets such a run replies
 * with the same sentence.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { loadRuns, persistRuns } from "../extensions/lib/runs.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { registerCancelTool } from "../extensions/worker-tools/cancel.ts";
import { registerNoteToWorkerTool } from "../extensions/worker-tools/note-to-worker.ts";
import { registerResumeTool } from "../extensions/worker-tools/resume.ts";
import { registerStatusTool } from "../extensions/worker-tools/status.ts";
import { registerSteerTool } from "../extensions/worker-tools/steer.ts";
import { toolOf } from "./native-run-helpers.ts";

/** The sentence that every tool replies with for a run of the Codex backend. */
const REFUSAL = "This run used the Codex backend. The Codex backend was removed.";

/** A run that an older release wrote with the backend `codex`. */
function codexJob(id: string, sessionDir: string, overrides: Partial<Job> = {}): Job {
	return {
		id,
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
		...freshRunState(0),
		status: "completed",
		paneId: null,
		backend: "codex",
		...overrides,
	} as Job;
}

/** A runtime with a database in a fresh directory. */
function freshRuntime(): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-legacy-codex-"));
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.config.stateDir = dir;
	rt.config.commsStandard = { mode: "off", minScore: 80 };
	return { rt, dir };
}

test("a run with the backend codex still loads from the database", () => {
	const { rt, dir } = freshRuntime();
	try {
		const job = codexJob("wz-legacy-1", join(dir, "sessions", "wz-legacy-1"));
		persistRuns(rt.openDb(), null, [job]);
		const { finished, alive } = loadRuns(rt.openDb());
		assert.equal(finished.length, 1);
		assert.equal(alive.length, 0);
		assert.equal(finished[0].id, "wz-legacy-1");
		assert.equal(finished[0].backend, "codex");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run with the backend codex that was active loads as an ended run", () => {
	const { rt, dir } = freshRuntime();
	try {
		const job = codexJob("wz-legacy-active", join(dir, "sessions", "wz-legacy-active"), {
			status: "running",
			paneId: "w1:p7",
		});
		persistRuns(rt.openDb(), null, [job]);
		const { finished, alive } = loadRuns(rt.openDb());
		assert.equal(alive.length, 0, "the run of a removed backend is never alive");
		assert.equal(finished.length, 1);
		assert.notEqual(finished[0].status, "running");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the status tool lists a run of the Codex backend as an ended run", async () => {
	const { rt, dir } = freshRuntime();
	try {
		const job = codexJob("wz-legacy-2", join(dir, "sessions", "wz-legacy-2"));
		rt.jobs.set(job.id, job);
		const status = toolOf(rt, registerStatusTool, "status");
		const result = await status.execute("t1", { workerId: job.id });
		const text = result.content[0]?.text ?? "";
		assert.match(text, /wz-legacy-2\s+COMPLETED/);
		assert.match(text, /backend\s+:\s+Codex/);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume of a run of the Codex backend is refused", async () => {
	const { rt, dir } = freshRuntime();
	try {
		const job = codexJob("wz-legacy-3", join(dir, "sessions", "wz-legacy-3"));
		rt.jobs.set(job.id, job);
		const resume = toolOf(rt, registerResumeTool, "resume");
		const result = await resume.execute("t1", { workerId: job.id });
		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text ?? "", REFUSAL);
		assert.equal(rt.jobs.size, 1);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a steer of a run of the Codex backend is refused", async () => {
	const { rt, dir } = freshRuntime();
	try {
		const job = codexJob("wz-legacy-4", join(dir, "sessions", "wz-legacy-4"), {
			status: "running",
			paneId: "w1:p7",
		});
		rt.jobs.set(job.id, job);
		const steer = toolOf(rt, registerSteerTool, "steer");
		const result = await steer.execute("t1", { workerId: job.id, message: "Do the work." });
		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text ?? "", REFUSAL);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a cancel of a run of the Codex backend is refused", async () => {
	const { rt, dir } = freshRuntime();
	try {
		const job = codexJob("wz-legacy-5", join(dir, "sessions", "wz-legacy-5"), {
			status: "running",
			paneId: "w1:p7",
		});
		rt.jobs.set(job.id, job);
		const cancel = toolOf(rt, registerCancelTool, "cancel");
		const result = await cancel.execute("t1", { workerId: job.id });
		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text ?? "", REFUSAL);
		assert.equal(rt.jobs.get(job.id)?.status, "running");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a note to a run of the Codex backend is refused", async () => {
	const { rt, dir } = freshRuntime();
	try {
		const job = codexJob("wz-legacy-7", join(dir, "sessions", "wz-legacy-7"), {
			status: "running",
			paneId: "w1:p7",
		});
		rt.jobs.set(job.id, job);
		const note = toolOf(rt, registerNoteToWorkerTool, "note");
		const result = await note.execute("t1", { workerId: job.id, text: "a note" });
		assert.equal(result.isError, true);
		assert.equal(result.content[0]?.text ?? "", REFUSAL);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a run of the Codex backend never looks like a run of OMP", async () => {
	const { rt, dir } = freshRuntime();
	try {
		const job = codexJob("wz-legacy-6", join(dir, "sessions", "wz-legacy-6"), {
			status: "running",
			paneId: "w1:p7",
		});
		rt.jobs.set(job.id, job);
		const status = toolOf(rt, registerStatusTool, "status");
		const result = await status.execute("t1", { workerId: job.id });
		const text = result.content[0]?.text ?? "";
		assert.doesNotMatch(text, /backend\s+:\s+OMP/);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});
