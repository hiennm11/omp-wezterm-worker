/**
 * The resource group of a resume.
 *
 * A resume of a resumed run must use the group of the first run of the task.
 * Every run of the task shares the session directory, so the group is found
 * through that directory.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createGroup, readGroup, releaseExecutionByHolder } from "../extensions/lib/groups.ts";
import { freshRunState, type Job } from "../extensions/lib/job.ts";
import type { RunFn } from "../extensions/lib/process.ts";
import { resumeClaudeWorker } from "../extensions/lib/resume-claude.ts";
import { createRuntime, type WorkerRuntime } from "../extensions/lib/runtime.ts";
import { resumeWorker } from "../extensions/lib/spawn.ts";
import { readRunContext } from "../extensions/lib/worker-context.ts";

/** A runtime with a database in a fresh directory. */
function freshRuntime(exec: RunFn): { rt: WorkerRuntime; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "wt-resume-group-"));
	const rt = createRuntime(exec);
	rt.config.stateDir = dir;
	return { rt, dir };
}

/** A session directory with a transcript in it. */
function sessionDirOf(dir: string, id: string): string {
	const sessionDir = join(dir, "sessions", id);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "a.jsonl"), "", "utf8");
	return sessionDir;
}

/** The source run of a resume. */
function sourceJob(id: string, sessionDir: string, overrides: Partial<Job> = {}): Job {
	return {
		id,
		label: "test",
		task: "task",
		cwd: "/repo",
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
		paneId: 42,
		...overrides,
	};
}

/**
 * The fake WezTerm of these tests.
 *
 * The pane list holds no pane, so the pane of a source run is gone and the
 * resume goes on. The launch answers with a pane id.
 */
function fakeWezterm(): { exec: RunFn; calls: string[][] } {
	const calls: string[][] = [];
	const exec: RunFn = async (bin, args) => {
		calls.push(args);
		if (args.includes("list")) return { code: 0, stdout: "[]", stderr: "" };
		if (args.includes("split-pane") || args.includes("spawn")) {
			return { code: 0, stdout: "99", stderr: "" };
		}
		if (args.includes("get-text")) return { code: 0, stdout: "bypass permissions on", stderr: "" };
		if (bin === "powershell") return { code: 0, stdout: "0", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	return { exec, calls };
}

/** True when a call started a pane. */
function launchedPane(calls: string[][]): boolean {
	return calls.some((args) => args.includes("split-pane") || args.includes("spawn"));
}

test("a resume of a resumed run takes the group of the first run", async () => {
	const { exec, calls } = fakeWezterm();
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-a");
		const first = sourceJob("wz-a", sessionDir);
		createGroup(db, "grp-wz-a", sessionDir, 1000);

		const second = await resumeWorker(rt, first, { jobId: "wz-b" });
		assert.equal(second.status, "running", `the first resume failed: ${second.error}`);
		releaseExecutionByHolder(db, "wz-b", 2000);

		const third = await resumeWorker(rt, second, { jobId: "wz-c" });
		assert.equal(third.status, "running", `the second resume failed: ${third.error}`);
		assert.equal(readGroup(db, "grp-wz-a")?.executionHolder, "wz-c");
		assert.deepEqual(readRunContext(sessionDir), {
			runId: "wz-c",
			sourceRunId: "wz-b",
			resourceGroup: "grp-wz-a",
		});
		assert.equal(launchedPane(calls), true);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a native resume of a resumed run takes the group of the first run", async () => {
	const { exec } = fakeWezterm();
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-na");
		const first = sourceJob("wz-na", sessionDir, { backend: "claude", nativeSessionId: "sess-1" });
		createGroup(db, "grp-wz-na", sessionDir, 1000);

		const second = await resumeClaudeWorker(rt, {
			jobId: "wz-nb",
			source: first,
			sessionId: "sess-1",
		});
		assert.equal(second.status, "running", `the first native resume failed: ${second.error}`);
		releaseExecutionByHolder(db, "wz-nb", 2000);

		const third = await resumeClaudeWorker(rt, {
			jobId: "wz-nc",
			source: second,
			sessionId: "sess-1",
		});
		assert.equal(third.status, "running", `the second native resume failed: ${third.error}`);
		assert.equal(readGroup(db, "grp-wz-na")?.executionHolder, "wz-nc");
		assert.deepEqual(readRunContext(sessionDir), {
			runId: "wz-nc",
			sourceRunId: "wz-nb",
			resourceGroup: "grp-wz-na",
		});
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a resume of a source run without a group refuses", async () => {
	const { exec, calls } = fakeWezterm();
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-nog");
		const source = sourceJob("wz-nog", sessionDir);
		const before = db.handle.prepare("SELECT id FROM resource_groups").all();

		const resumed = await resumeWorker(rt, source, { jobId: "wz-nog-2" });

		assert.equal(resumed.status, "failed");
		assert.equal(resumed.error, "Worker wz-nog has no resource group. It cannot be resumed.");
		assert.notEqual(resumed.finishedAt, null);
		assert.equal(rt.jobs.get("wz-nog-2")?.status, "failed");
		assert.deepEqual(db.handle.prepare("SELECT id FROM resource_groups").all(), before);
		assert.equal(launchedPane(calls), false);
	} finally {
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a native resume of a source run without a group refuses", async () => {
	const { exec, calls } = fakeWezterm();
	const { rt, dir } = freshRuntime(exec);
	try {
		const db = rt.openDb();
		const sessionDir = sessionDirOf(dir, "wz-nnog");
		const source = sourceJob("wz-nnog", sessionDir, { backend: "claude", nativeSessionId: "sess-2" });
		const before = db.handle.prepare("SELECT id FROM resource_groups").all();

		const resumed = await resumeClaudeWorker(rt, {
			jobId: "wz-nnog-2",
			source,
			sessionId: "sess-2",
		});

		assert.equal(resumed.status, "failed");
		assert.equal(resumed.error, "Worker wz-nnog has no resource group. It cannot be resumed.");
		assert.notEqual(resumed.finishedAt, null);
		assert.equal(rt.jobs.get("wz-nnog-2")?.status, "failed");
		assert.deepEqual(db.handle.prepare("SELECT id FROM resource_groups").all(), before);
		assert.equal(launchedPane(calls), false);
		assert.equal(existsSync(sessionDir), true);
	} finally {
		for (const bridge of rt.bridges.values()) await bridge.close();
		rt.closeDb();
		rmSync(dir, { recursive: true, force: true });
	}
});
