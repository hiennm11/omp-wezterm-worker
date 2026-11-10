/**
 * The refusal of the Claude Code backend on Herdr.
 *
 * The reporting contract of a Claude Code worker has many lines, and Herdr
 * refuses an argument with a line break. A Claude spawn and a Claude resume
 * must refuse before any pane opens and before any program starts.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CLAUDE_HERDR_REFUSAL } from "../extensions/lib/claude-herdr.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn, RunResult } from "../extensions/lib/process.ts";
import { resumeClaudeWorker } from "../extensions/lib/resume-claude.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { spawnClaudeWorker } from "../extensions/lib/spawn-claude.ts";

/** A source run that a resume acts on. */
function sourceJob(dir: string): Job {
	return {
		id: "wz-claude-source",
		label: "claude source",
		task: "Reply with the single word OK.",
		cwd: dir,
		model: null,
		tools: null,
		placement: "split",
		sessionDir: join(dir, "sessions", "wz-claude-source"),
		sessionFile: null,
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		backend: "claude",
		nativeSessionId: null,
		...freshRunState(Date.now()),
		status: "completed",
	};
}

/** A runtime that records every program that the extension started. */
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

test("a Claude spawn refuses before any pane opens", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-refusal-"));
	const { rt, programs } = recordingRuntime(dir);
	try {
		const job = await spawnClaudeWorker(rt, {
			jobId: "wz-claude-1",
			task: "Reply with the single word OK.",
			cwd: dir,
			sessionId: "11111111-1111-4111-8111-111111111111",
		});
		assert.equal(job.status, "failed");
		assert.equal(job.error, CLAUDE_HERDR_REFUSAL);
		assert.equal(job.paneId, null, "the refused spawn opened a pane");
		assert.deepEqual(programs, [], "the refused spawn started a program");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude resume refuses before any pane opens and holds no group", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-refusal-"));
	const { rt, programs } = recordingRuntime(dir);
	try {
		const job = await resumeClaudeWorker(rt, {
			jobId: "wz-claude-2",
			source: sourceJob(dir),
			sessionId: "",
		});
		assert.equal(job.status, "failed");
		assert.equal(job.error, CLAUDE_HERDR_REFUSAL);
		assert.equal(job.paneId, null, "the refused resume opened a pane");
		assert.deepEqual(programs, [], "the refused resume started a program");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});
