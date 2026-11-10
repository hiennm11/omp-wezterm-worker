/**
 * The refusal of the Codex backend on Herdr.
 *
 * The Codex backend does not run on Herdr yet. A Codex spawn and a Codex
 * resume must refuse before any pane opens and before any program starts.
 * The reply names the reason.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CODEX_HERDR_REFUSAL } from "../extensions/lib/codex-herdr.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn, RunResult } from "../extensions/lib/process.ts";
import { resumeCodexWorker } from "../extensions/lib/resume-codex.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { spawnCodexWorker } from "../extensions/lib/spawn-codex.ts";

/** A source run that a resume acts on. */
function sourceJob(dir: string): Job {
	return {
		id: "wz-codex-source",
		label: "codex source",
		task: "Reply with the single word OK.",
		cwd: dir,
		model: null,
		tools: null,
		placement: "split",
		sessionDir: join(dir, "sessions", "wz-codex-source"),
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		backend: "codex",
		nativeSessionId: null,
		...freshRunState(Date.now()),
		status: "completed",
	};
}

/**
 * A runtime that records every program that the extension started.
 *
 * The runtime answers nothing, because the refusal must come before any
 * program starts.
 */
function recordingRuntime(dir: string): { rt: WorkerRuntime; programs: string[] } {
	const programs: string[] = [];
	const exec: RunFn = async (bin): Promise<RunResult> => {
		programs.push(bin);
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	return { rt, programs };
}

test("a Codex spawn refuses before any pane opens", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-refusal-"));
	const { rt, programs } = recordingRuntime(dir);
	try {
		const job = await spawnCodexWorker(rt, {
			jobId: "wz-codex-1",
			task: "Reply with the single word OK.",
			cwd: dir,
		});
		assert.equal(job.status, "failed");
		assert.equal(job.error, CODEX_HERDR_REFUSAL);
		assert.equal(job.paneId, null, "the refused spawn opened a pane");
		assert.deepEqual(programs, [], "the refused spawn started a program");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Codex resume refuses before any pane opens", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-refusal-"));
	const { rt, programs } = recordingRuntime(dir);
	try {
		const source = sourceJob(dir);
		rt.jobs.set(source.id, source);
		const job = await resumeCodexWorker(rt, {
			jobId: "wz-codex-2",
			source,
			threadId: "thread-1",
		});
		assert.equal(job.status, "failed");
		assert.equal(job.error, CODEX_HERDR_REFUSAL);
		assert.equal(job.paneId, null, "the refused resume opened a pane");
		assert.deepEqual(programs, [], "the refused resume started a program");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});
