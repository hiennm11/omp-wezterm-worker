/**
 * The helpers of the tests of a Codex resume.
 *
 * A Codex resume continues the thread of a source run. The helpers start
 * that source run through the fake runtime, end it, and hold the jobs that a
 * resume of an OMP run or of a Claude Code run needs.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { endCodexProcesses } from "../extensions/lib/codex-process.ts";
import { createGroup } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { spawnCodexWorker } from "../extensions/lib/spawn-codex.ts";
import type { CodexFake } from "./codex-spawn-helpers.ts";

/** The id of the source run of a resume. */
export const SOURCE_ID = "wz-codex-src";

/** The id of the new run of a resume. */
export const RESUMED_ID = "wz-codex-2";

/** The id of the thread of the fake app server. */
export const THREAD_ID = "thread-1";

/**
 * Start the source run of a resume.
 *
 * The function starts a real Codex worker through the fake runtime, so the
 * source run holds a thread, two panes and a resource group.
 */
export async function startSource(fake: CodexFake): Promise<Job> {
	const job = await spawnCodexWorker(
		fake.rt,
		{ jobId: SOURCE_ID, task: "Reply with the single word OK.", cwd: fake.dir },
		{ connect: fake.connect, serverWaitMs: 100 },
	);
	assert.equal(job.status, "running", `the source run failed: ${job.error}`);
	return job;
}

/**
 * End the source run of a resume.
 *
 * The end closes both panes of the source run and ends the program of its
 * app server. The run then holds no group, so a resume can take it.
 */
export async function endSource(fake: CodexFake, job: Job): Promise<void> {
	await endCodexProcesses(fake.rt, job.codex ?? null);
	job.status = "completed";
	job.finishedAt = Date.now();
	job.paneClosed = true;
	fake.rt.persist();
}

/**
 * A fake WezTerm that records the program of every pane that it starts.
 *
 * The runtime of the test has no pane list, so a resume of a run without a
 * pane goes on.
 */
export function fakeWezterm(): { exec: RunFn; programs: string[] } {
	const programs: string[] = [];
	const exec: RunFn = async (bin, args) => {
		if (args.includes("split-pane") || args.includes("spawn")) {
			programs.push(args[args.indexOf("--") + 1] ?? bin);
			return { code: 0, stdout: "99", stderr: "" };
		}
		if (args.includes("list")) return { code: 0, stdout: "[]", stderr: "" };
		if (args.includes("get-text")) return { code: 0, stdout: "bypass permissions on", stderr: "" };
		if (bin === "powershell") return { code: 0, stdout: "0", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	return { exec, programs };
}

/** A runtime with a database in a fresh directory. */
export function freshRuntime(exec: RunFn): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-codex-resume-"));
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	return { rt, dir };
}

/** The session directory of a run, with a transcript in it. */
export function sessionDirOf(dir: string, id: string): string {
	const sessionDir = join(dir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
	return sessionDir;
}

/**
 * A finished worker of another backend.
 *
 * The function holds the job that a resume of an OMP run or of a Claude Code
 * run needs. The group of the task exists, so the resume can take it.
 */
export function finishedJob(id: string, sessionDir: string, backend?: "claude"): Job {
	const job: Job = {
		id,
		label: id,
		task: "task",
		cwd: sessionDir,
		model: null,
		tools: null,
		placement: "split",
		sessionDir,
		sessionFile: join(sessionDir, "a.jsonl"),
		worktreePath: null,
		worktreeBranch: null,
		worktreeOrigin: null,
		timeoutMs: 0,
		idleTimeoutMs: 0,
		closePaneOnFinish: true,
		...freshRunState(0),
		status: "completed",
		paneId: null,
	};
	if (backend) {
		job.backend = backend;
		job.nativeSessionId = "sess-1";
	}
	return job;
}

/** Close the runtime of a test and remove its directory. */
export async function cleanupRuntime(rt: WorkerRuntime, dir: string): Promise<void> {
	for (const bridge of rt.bridges.values()) await bridge.close();
	rt.closeDb();
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

/** Create the group of a task, so a resume can take it. */
export function seedGroup(rt: WorkerRuntime, id: string, sessionDir: string): void {
	createGroup(rt.openDb(), id, sessionDir, Date.now());
}
