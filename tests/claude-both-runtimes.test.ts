/**
 * The Claude Code backend on both pane runtimes.
 *
 * The reporting contract of a Claude Code worker travels in a file, so the
 * backend starts on Herdr. The pane calls of the Claude session go through
 * the runtime of the job, so the backend starts on WezTerm too. Neither
 * runtime refuses a Claude spawn or a Claude resume.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createGroup } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import { resumeClaudeWorker } from "../extensions/lib/resume-claude.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { spawnClaudeWorker } from "../extensions/lib/spawn-claude.ts";
import { herdrFake } from "./herdr-fake.ts";
import { weztermFake } from "./wezterm-fake.ts";

/** A source run that a resume acts on. */
function sourceJob(dir: string): Job {
	const sessionDir = join(dir, "sessions", "wz-claude-source");
	mkdirSync(sessionDir, { recursive: true });
	return {
		id: "wz-claude-source",
		label: "claude source",
		task: "Reply with the single word OK.",
		cwd: dir,
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
		backend: "claude",
		nativeSessionId: null,
		...freshRunState(Date.now()),
		status: "completed",
	};
}

/** A runtime whose WezTerm answers with the fake. */
function weztermRuntime(dir: string): WorkerRuntime {
	const fake = weztermFake();
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.wezterm = async (args) => fake.answer(args);
	rt.paneRuntime = "wezterm";
	rt.config.stateDir = dir;
	rt.config.runtime = "wezterm";
	return rt;
}

/** A runtime whose Herdr answers with the fake. */
function herdrRuntime(dir: string): WorkerRuntime {
	const fake = herdrFake();
	const rt = createRuntime(async () => ({ code: 0, stdout: "", stderr: "" }));
	rt.herdr = async (args) => fake.answer(args);
	rt.paneRuntime = "herdr";
	rt.config.stateDir = dir;
	rt.config.runtime = "herdr";
	return rt;
}

test("a Claude spawn on WezTerm reaches the launch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-runtime-"));
	const rt = weztermRuntime(dir);
	try {
		const job = await spawnClaudeWorker(rt, {
			jobId: "wz-claude-1",
			task: "Reply with the single word OK.",
			cwd: dir,
			sessionId: "11111111-1111-4111-8111-111111111111",
		});
		assert.equal(job.status, "running", job.error ?? "the spawn was refused");
		assert.notEqual(job.paneId, null, "the spawn opened no pane");
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude spawn on Herdr reaches the launch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-runtime-"));
	const rt = herdrRuntime(dir);
	try {
		const job = await spawnClaudeWorker(rt, {
			jobId: "wz-claude-herdr",
			task: "Reply with the single word OK.",
			cwd: dir,
			sessionId: "11111111-1111-4111-8111-111111111111",
		});
		assert.equal(job.status, "running", job.error ?? "the spawn was refused");
		assert.notEqual(job.paneId, null, "the spawn opened no pane");
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude resume on WezTerm reaches the launch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-runtime-"));
	const rt = weztermRuntime(dir);
	try {
		const source = sourceJob(dir);
		createGroup(rt.openDb(), "grp-wz-claude-source", source.sessionDir, Date.now());
		const job = await resumeClaudeWorker(rt, {
			jobId: "wz-claude-2",
			source,
			sessionId: "",
		});
		assert.equal(job.status, "running", job.error ?? "the resume was refused");
		assert.notEqual(job.paneId, null, "the resume opened no pane");
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Claude resume on Herdr reaches the launch", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wt-claude-runtime-"));
	const rt = herdrRuntime(dir);
	try {
		const source = sourceJob(dir);
		createGroup(rt.openDb(), "grp-wz-claude-source", source.sessionDir, Date.now());
		const job = await resumeClaudeWorker(rt, {
			jobId: "wz-claude-3",
			source,
			sessionId: "",
		});
		assert.equal(job.status, "running", job.error ?? "the resume was refused");
		assert.notEqual(job.paneId, null, "the resume opened no pane");
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});
