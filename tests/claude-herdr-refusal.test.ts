/**
 * The refusal of the Claude Code backend on a pane runtime.
 *
 * The reporting contract of a Claude Code worker travels in a file, so the
 * backend starts on Herdr. The backend still refuses on WezTerm, because the
 * pane calls of the Claude session still use the Herdr seam. A Claude spawn
 * and a Claude resume must refuse before any pane opens and before any
 * program starts.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CLAUDE_WEZTERM_REFUSAL, claudeRuntimeRefusal } from "../extensions/lib/claude-herdr.ts";
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
function recordingRuntime(
	dir: string,
	runtime: "herdr" | "wezterm" | null,
): { rt: WorkerRuntime; programs: string[] } {
	const programs: string[] = [];
	const exec: RunFn = async (bin): Promise<RunResult> => {
		programs.push(bin);
		return { code: 0, stdout: "", stderr: "" };
	};
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	rt.paneRuntime = runtime;
	return { rt, programs };
}

test("Herdr gives no refusal, because the contract travels in a file", () => {
	assert.equal(claudeRuntimeRefusal("herdr"), null);
});

test("WezTerm refuses, because the pane calls still use the Herdr seam", () => {
	const refusal = claudeRuntimeRefusal("wezterm");
	assert.ok(refusal, "the WezTerm runtime was not refused");
	assert.match(refusal, /WezTerm/);
	assert.match(refusal, /Issue 4/);
});

test("no runtime refuses, because no pane can open", () => {
	assert.equal(claudeRuntimeRefusal(null), CLAUDE_WEZTERM_REFUSAL);
});

test("a Claude spawn on WezTerm refuses before any pane opens", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-refusal-"));
	const { rt, programs } = recordingRuntime(dir, "wezterm");
	try {
		const job = await spawnClaudeWorker(rt, {
			jobId: "wz-claude-1",
			task: "Reply with the single word OK.",
			cwd: dir,
			sessionId: "11111111-1111-4111-8111-111111111111",
		});
		assert.equal(job.status, "failed");
		assert.equal(job.error, CLAUDE_WEZTERM_REFUSAL);
		assert.match(job.error ?? "", /Issue 4/);
		assert.equal(job.paneId, null, "the refused spawn opened a pane");
		assert.deepEqual(programs, [], "the refused spawn started a program");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude resume on WezTerm refuses before any pane opens and holds no group", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-refusal-"));
	const { rt, programs } = recordingRuntime(dir, "wezterm");
	try {
		const job = await resumeClaudeWorker(rt, {
			jobId: "wz-claude-2",
			source: sourceJob(dir),
			sessionId: "",
		});
		assert.equal(job.status, "failed");
		assert.equal(job.error, CLAUDE_WEZTERM_REFUSAL);
		assert.match(job.error ?? "", /Issue 4/);
		assert.equal(job.paneId, null, "the refused resume opened a pane");
		assert.deepEqual(programs, [], "the refused resume started a program");
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});
